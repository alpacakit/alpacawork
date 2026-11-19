import { rememberWriteIdentity } from "../src/data/write-identity";
import { seedPersonal } from './read-fixtures';
import { beforeAll, beforeEach, afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { uiLocales } from '@alpacawork/core/ui-language';
import { defaultSettings, personalSettings, uiLanguageOptions, type SettingDefinition } from '@alpacawork/contract';
import { PersonalSettingsTab } from '../src/features/panels/PersonalSettingsTab';
import { usePersonalSettings } from '../src/data/personal-settings';
import { intentKey, useWriteIntentStore } from '../src/data/write-intent';
import { useConnection } from '../src/data/connection';
import { queryClient } from '../src/data/query-client';
import { receiveFullIndex, resources, startRequiredReadSession } from '../src/data/resources';
import { indexOf, tree } from './fixtures';
import { TestWorkspace } from './fixtures';
import { problemResponse } from "./problem";

beforeAll(() => startI18n());
beforeEach(() => { queryClient.clear(); receiveFullIndex(queryClient, indexOf(tree())); useConnection.setState({ state: 'live', offline: false }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); usePersonalSettings.setState(usePersonalSettings.getInitialState(), true); useWriteIntentStore.setState({ entries: {}, unavailable: false }); });

test('a personal setting uses the common durable send state while its answer is pending', async () => {
  const values = defaultSettings();
  seedPersonal({ root: '/fixture', status: 'ready', fresh: true, values, revision: 'r1' });
  let answer!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const save = usePersonalSettings.getState().save('theme', 'dark');
  expect(useWriteIntentStore.getState().entries[intentKey('/fixture', 'personal-setting:theme', null)]).toMatchObject({
    status: 'pending', payload: { key: 'theme', value: 'dark', expectedRevision: 'r1' },
  });
  answer(new Response(JSON.stringify({ values: { ...values, theme: 'dark' }, revision: 'r2' })));
  expect(await save).toBe(true);
});

test('every registered label, hint and choice has English and Japanese translations', () => {
  for (const definition of personalSettings) {
    for (const key of [definition.labelKey, 'helpKey' in definition ? definition.helpKey : undefined,
      ...('options' in definition ? definition.options.map((option) => 'labelKey' in option ? option.labelKey : undefined) : [])]) {
      if (!key) continue;
      expect(i18n.exists(key, { lng: 'ja', ns: 'panels' }), key).toBe(true);
      expect(i18n.exists(key, { lng: 'en', ns: 'panels' }), key).toBe(true);
    }
  }
});

test('every catalog supplies the settings language choices in their own names', () => {
  const names: Record<typeof uiLocales[number], string> = {
    en: 'English', ja: '日本語', 'zh-CN': '简体中文', es: 'Español', 'pt-BR': 'Português (Brasil)',
  };
  for (const locale of uiLocales) for (const { value, labelKey } of uiLanguageOptions) {
    expect(i18n.getResource(locale, 'panels', labelKey)).toBe(names[value]);
  }
});

test('one extra registration draws a row and uses the same generic save path', async () => {
  const definitions: readonly SettingDefinition[] = [...personalSettings,
    // Named as a select is, so its switch is the only one of that name.
    { key: 'testExtra', group: 'display', owner: 'person', kind: 'toggle', defaultValue: false,
      labelKey: 'settings.personal.theme' }];
  const values = { ...defaultSettings(definitions), testExtra: false };
  seedPersonal({ root: '/fixture', status: 'ready', fresh: true, values, revision: 'r1' });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ values: { ...values, [input.key]: input.value }, revision: 'r2' }));
  });
  render(<TestWorkspace><PersonalSettingsTab definitions={definitions} /></TestWorkspace>);
  fireEvent.click(screen.getByRole('switch', { name: 'Theme' }));
  await waitFor(() => expect(usePersonalSettings.getState().values.testExtra).toBe(true));
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ key: 'testExtra', value: true });
});

test('task notification switches show the defaults and save the chosen state', async () => {
  const values = defaultSettings();
  seedPersonal({ root: '/fixture', status: 'ready', fresh: true, values, revision: 'r1' });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ values: { ...values, [input.key]: input.value }, revision: 'r2' }));
  });
  render(<TestWorkspace><PersonalSettingsTab /></TestWorkspace>);
  expect(screen.getByRole('switch', { name: 'When a task is awaiting review' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('switch', { name: 'When a task asks you a question' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('switch', { name: 'When a task is stopped' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('switch', { name: 'When a task is done' }).getAttribute('aria-checked')).toBe('false');
  fireEvent.click(screen.getByRole('switch', { name: 'When a task is done' }));
  await waitFor(() => expect(usePersonalSettings.getState().values['push.done']).toBe(true));
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ key: 'push.done', value: true });
});

test('a different setting changed elsewhere is rebased once; the same setting is kept for review', async () => {
  const values = defaultSettings();
  seedPersonal({ root: '/fixture', status: 'ready', fresh: true, values, revision: 'r1' });
  let posts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/settings/set')) {
      posts++;
      if (posts === 1) return problemResponse('conflict');
      const input = JSON.parse(String(init?.body));
      expect(input.expectedRevision).toBe('r2');
      return new Response(JSON.stringify({ values: { ...values, language: 'ja', theme: 'dark' }, revision: 'r3' }));
    }
    return new Response(JSON.stringify({ values: { ...values, language: 'ja' }, revision: 'r2' }));
  });
  expect(await usePersonalSettings.getState().save('theme', 'dark')).toBe(true);
  expect(posts).toBe(2);
  expect(usePersonalSettings.getState().values).toMatchObject({ language: 'ja', theme: 'dark' });
  seedPersonal({ root: '/fixture', status: 'ready', fresh: true, values, revision: 'r1' });
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/settings/set')
    ? problemResponse('conflict')
    : new Response(JSON.stringify({ values: { ...values, theme: 'light' }, revision: 'r2' })));
  expect(await usePersonalSettings.getState().save('theme', 'dark')).toBe(false);
  expect(useWriteIntentStore.getState().entries[intentKey('/fixture', 'personal-setting:theme', null)]?.status).toBe('conflict');
  expect(usePersonalSettings.getState().values.theme).toBe('light');
});

test('a late response from one setting cannot roll back a newer confirmed setting', async () => {
  const values = defaultSettings();
  seedPersonal({ root: '/fixture', status: 'ready', fresh: true, values, revision: 'r1' });
  let releaseFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
  let posts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url).endsWith('/settings/set')) {
      posts++;
      if (posts === 1) return firstResponse;
      if (posts === 2) return problemResponse('conflict');
      return new Response(JSON.stringify({ values: { ...values, theme: 'dark', 'push.done': true }, revision: 'r3' }));
    }
    return new Response(JSON.stringify({ values: { ...values, theme: 'dark' }, revision: 'r2' }));
  });
  const first = usePersonalSettings.getState().save('theme', 'dark');
  const second = usePersonalSettings.getState().save('push.done', true);
  expect(await second).toBe(true);
  releaseFirst(new Response(JSON.stringify({ values: { ...values, theme: 'dark' }, revision: 'r2' })));
  expect(await first).toBe(true);
  expect(usePersonalSettings.getState().values).toMatchObject({ theme: 'dark', 'push.done': true });
  expect(usePersonalSettings.getState().revision).toBe('r3');
});

test('an uncertain response is checked against the server before claiming success', async () => {
  const values = defaultSettings();
  seedPersonal({ root: '/fixture', status: 'ready', fresh: true, values, revision: 'r1' });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/settings/set')
    ? problemResponse('unavailable')
    : new Response(JSON.stringify({ values: { ...values, theme: 'dark' }, revision: 'r2' })));
  expect(await usePersonalSettings.getState().save('theme', 'dark')).toBe(true);
  expect(useWriteIntentStore.getState().entries[intentKey('/fixture', 'personal-setting:theme', null)]?.status).toBe('confirmed');
  expect(usePersonalSettings.getState().values.theme).toBe('dark');
  vi.restoreAllMocks();
  seedPersonal({ root: '/fixture', status: 'ready', fresh: true, values, revision: 'r1' });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
  expect(await usePersonalSettings.getState().save('theme', 'dark')).toBe(false);
  expect(useWriteIntentStore.getState().entries[intentKey('/fixture', 'personal-setting:theme', null)]?.status).toBe('unconfirmed');
});

test('an unconfirmed save keeps its control disabled and explains how to recover', () => {
  rememberWriteIdentity('/fixture', 'op1', 'initial');
  seedPersonal({ root: '/fixture', status: 'ready', fresh: true, values: defaultSettings(), revision: 'r1' });
  useWriteIntentStore.setState({ entries: { [intentKey('/fixture', 'personal-setting:theme', null)]: {
    status: 'unconfirmed', operationId: 'op1', transport: 'receipt', payload: { key: 'theme', value: 'dark', expectedRevision: 'r1' },
    attempt: 'attempt1', at: new Date().toISOString(),
  } } });
  render(<TestWorkspace><PersonalSettingsTab /></TestWorkspace>);
  expect(screen.getByText('Couldn\'t confirm the save. Reload the page.')).toBeTruthy();
  expect((screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
});

for (const language of uiLocales) test(`initial settings GET applies its admitted ${language} language when the Query itself advances revision`, async () => {
  await i18n.changeLanguage(language === 'ja' ? 'en' : 'ja');
  const index = indexOf(tree());
  receiveFullIndex(queryClient, { ...index, person: { ...index.person, settings: 'initial-language' } });
  const values = { ...defaultSettings(), language };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ values, revision: 'initial-language' }));
  try {
    await usePersonalSettings.getState().load('/fixture');
    await waitFor(() => expect(i18n.language).toBe(language));
    expect(usePersonalSettings.getState().values).toEqual(values);
    expect(queryClient.getQueryData(resources.personalSettings('/fixture').queryKey)).toEqual({ values, revision: 'initial-language' });
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  } finally { await i18n.changeLanguage('en'); }
});

for (const language of ['ja', 'en'] as const) test(`required-read observer applies admitted ${language} after proof publication without calling load`, async () => {
  await i18n.changeLanguage(language === 'ja' ? 'en' : 'ja');
  const index = indexOf(tree());
  receiveFullIndex(queryClient, { ...index, person: { ...index.person, settings: 'observer-language' } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => Response.json(String(url).includes('settings/get')
    ? { values: { ...defaultSettings(), language }, revision: 'observer-language' }
    : { state: null, revision: index.person.notices }));
  const stop = startRequiredReadSession(queryClient);
  try {
    await waitFor(() => expect(usePersonalSettings.getState().values.language).toBe(language));
    await waitFor(() => expect(i18n.language).toBe(language));
  } finally { stop(); await i18n.changeLanguage('en'); }
});

test('the update confirmation row is hidden while confirmation is on', () => {
  seedPersonal({ root: '/fixture', status: 'ready', fresh: true, values: defaultSettings(), revision: 'r1' });
  render(<TestWorkspace><PersonalSettingsTab /></TestWorkspace>);
  expect(screen.queryByRole('switch', { name: 'Confirm before updating' })).toBeNull();
});

test('once confirmation is off its row is shown, turns it back on, and stays for this opening', async () => {
  const off = { ...defaultSettings(), 'update.confirm': false };
  seedPersonal({ root: '/fixture', status: 'ready', fresh: true, values: off, revision: 'r1' });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ values: { ...off, [input.key]: input.value }, revision: 'r2' }));
  });
  render(<TestWorkspace><PersonalSettingsTab /></TestWorkspace>);
  const row = screen.getByRole('switch', { name: 'Confirm before updating' });
  expect(row.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(row);
  await waitFor(() => expect(usePersonalSettings.getState().values['update.confirm']).toBe(true));
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ key: 'update.confirm', value: true });
  expect(screen.getByRole('switch', { name: 'Confirm before updating' }).getAttribute('aria-checked')).toBe('true');
});
