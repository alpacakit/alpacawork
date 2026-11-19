import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { TelemetrySection } from '../src/features/telemetry/Telemetry';
import { queryClient } from '../src/data/query-client';
import { TestWorkspace, screenData, tree } from './fixtures';

beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

// First in this file: the page's opening is measured before its consent status is first read.
test('a counted use leaves the tab only while sending is on, with the screen\'s own attributes and nothing else', async () => {
  const { countTime, countUse, dialogUse } = await import('../src/features/telemetry/count');
  const { workspaceWriteBasis } = await import('../src/data/connection');
  const uses: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).includes('telemetry/use')) { uses.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
    return Response.json({ state: 'on', blockedBy: null, digest: 'a'.repeat(64), id: null });
  });
  // jsdom names no known system; the language is English and the theme follows the OS.
  const person = { device: 'desktop.other', via: 'screen', lang: 'en', theme: 'system' };
  // Before the status is read, facts wait in the tab and go only once it says on.
  countTime('open', 800); countUse('search');
  expect(uses).toEqual([]);
  render(<TestWorkspace data={screenData(tree())}><TelemetrySection /></TestWorkspace>);
  await waitFor(() => expect(uses).toEqual([{ time: 'open', ms: 800 }, { op: 'search', attributes: person }]));
  const key = ['telemetry', workspaceWriteBasis().root];
  for (const state of ['blocked', 'not_asked', 'needs_reask', 'off'] as const) {
    queryClient.setQueryData(key, { state, blockedBy: null, digest: null, id: null });
    countUse('send.button'); countTime('task', 100);
  }
  queryClient.setQueryData(key, { state: 'on', blockedBy: null, digest: null, id: null });
  countUse('send.key');
  // An agent checking the screen (`?agent=1`) counts as such, not as the person.
  window.history.replaceState(null, '', '/?agent=1');
  countUse('w.message');
  window.history.replaceState(null, '', '/');
  await waitFor(() => expect(uses).toHaveLength(4));
  expect(uses.slice(2)).toEqual([{ op: 'send.key', attributes: person }, { op: 'w.message', attributes: { ...person, via: 'agent' } }]);
  // Nothing that narrows down the device leaves: no user agent, no size, no time zone.
  const sent = JSON.stringify(uses);
  for (const value of [navigator.userAgent, String(window.innerWidth), Intl.DateTimeFormat().resolvedOptions().timeZone]) expect(sent).not.toContain(value);
  const settings = { kind: 'settings', tab: 'server' } as const, edit = { kind: 'input', form: 'responsible', taskId: 'T1' } as const;
  expect([dialogUse(settings, null), dialogUse({ ...settings, tab: 'apps' }, settings), dialogUse(edit, settings),
    dialogUse({ ...edit, form: 'move' }, edit), dialogUse(null, edit), dialogUse({ kind: 'run', runId: 'R1' }, null)])
    .toEqual(['open.settings', null, 'form.responsible', 'form.move', null, null]);
});
