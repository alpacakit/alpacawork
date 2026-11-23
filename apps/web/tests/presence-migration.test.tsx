import { receiveFullIndex } from '../src/data/resources';
import { useConnection } from '../src/data/connection';
/** E2E presence: real person state and HTTP writes; only rendering runs in jsdom. */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { i18n, startI18n } from '@alpacawork/i18n';

import { projectedIndexSchema } from '@alpacawork/contract/control';
import { openIndexStream } from '../../../tests/index-stream';
import { PresenceMenu } from '../src/features/chrome/PresenceMenu';
import { SettingsDialog } from '../src/features/panels/SettingsDialog';
import { Toaster } from '../src/components/ui/toaster';
import { usePersonalSettings } from '../src/data/personal-settings';
import { useWriteIntentStore } from '../src/data/write-intent';
import { useDialogStore } from '../src/state/dialog-store';
import { queryClient } from '../src/data/query-client';
import { screenData, TestWorkspace, tree } from './fixtures';

const transport = globalThis.fetch;
let stop: (() => Promise<void>) | undefined;
let scratch = '';
let abort: AbortController | undefined;
// Each test starts its own workspace and serve in other processes; on a busy PC that alone can take five seconds.
vi.setConfig({ testTimeout: 15_000 });
beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => {
  const Original = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
    return new Original(locales, { timeZone: 'Asia/Tokyo', ...options });
  });
});
afterEach(async () => {
  cleanup(); abort?.abort(); abort = undefined; vi.restoreAllMocks();
  await stop?.(); stop = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true }); scratch = '';
  queryClient.clear(); usePersonalSettings.setState(usePersonalSettings.getInitialState(), true);
  useWriteIntentStore.setState({ entries: {}, unavailable: false });
  useDialogStore.setState({ dialog: null }); sessionStorage.clear();
});
function cleanCliEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: scratch, XDG_CONFIG_HOME: join(scratch, '.config') };
  for (const key of ['ALPACAWORK_RUN', 'ALPACAWORK_RUN_TOKEN', 'ALPACAWORK_SERVER', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID']) delete env[key];
  return env;
}
async function isolatedServe(root: string) {
  const child = spawn(process.execPath, [resolve('tests/helpers/serve-http.ts'), root], { env: cleanCliEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } };
  let stderr = ''; child.stderr!.on('data', bytes => { stderr += bytes; });
  const lines = createInterface({ input: child.stdout! });
  const line = await Promise.race([once(lines, 'line').then(([line]) => String(line)), once(child, 'exit').then(() => { throw new Error(stderr); })]);
  lines.close();
  return { ...JSON.parse(line), stop };
}
async function fixture() {
  scratch = mkdtempSync(join(tmpdir(), 'presence-migration-'));
  const root = join(scratch, 'workspace');
  const init = spawnSync(process.execPath, [resolve('apps/backend/dist/backend.js'), '--workspace', root, 'workspace', 'init'],
    { env: cleanCliEnv(), encoding: 'utf8', timeout: 20_000 });
  expect(init.status, init.stderr).toBe(0);
  const server = await isolatedServe(root); stop = server.stop;
  const origin = new URL(server.url).origin;
  const request = (path: string, init?: RequestInit) => transport(origin + '/api/' + path, init);
  const settings = async () => {
    const response = await request('commands/settings/get'); expect(response.status).toBe(200); return response.json();
  };
  abort = new AbortController();
  const feed = await openIndexStream(new URL('/api/events', origin), abort.signal);
  let index = await feed.index();
  const rendered = screenData(tree({ root }));
  // Real HTTP reads own the cache after receiveFullIndex; this fixture supplies rendering context only.
  const data = () => ({ ...rendered, seed: () => {}, info: { ...rendered.info, presence: index.presence } });
  await settings();
  // The first GET can create the person's default settings. Observe its real published
  // revision before exercising a settings write, as Workspace's live feed does.
  index = projectedIndexSchema.parse(await (await request('workspace/live')).json());
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => transport(new URL(String(url), origin), init));
  receiveFullIndex(queryClient, index);
  useConnection.setState({ state: 'live', fresh: true, writable: index.writable, offline: false });
  await usePersonalSettings.getState().load(root);
  const ui = () => <TestWorkspace data={data()}><PresenceMenu /><Toaster /></TestWorkspace>;
  const view = render(ui());
  return { settings,
    follow: async (state: string) => {
      do { index = await feed.index(); } while (index.presence.state !== state);
      await act(async () => { receiveFullIndex(queryClient, index); view.rerender(ui()); });
    },
    showSettings: () => { view.rerender(<TestWorkspace data={data()}><PresenceMenu /><SettingsDialog initialTab="notifications" /><Toaster /></TestWorkspace>); },
  };
}
const trigger = () => document.querySelector<HTMLButtonElement>('[data-presence-trigger]')!;
const action = (name: string) => fireEvent.click(document.querySelector(`[data-presence-item="${name}"]`)!);
const label = () => trigger().getAttribute('aria-label');

test('a slow browser clock still pauses for one hour from real server time', async () => {
  const before = Date.now(); const h = await fixture();
  vi.spyOn(Date, 'now').mockReturnValue(before - 3_600_000);
  fireEvent.click(trigger()); action('hour'); await h.follow('muted');
  expect(label()).toMatch(/Notifications paused/);
  const until = Date.parse((await h.settings()).values['push.mutedUntil']);
  expect(until).toBeGreaterThanOrEqual(before + 3_600_000);
  expect(until).toBeLessThanOrEqual(new Date().getTime() + 3_600_000);
});

test('notification menu opens settings and controls persist threshold and quiet hours over real HTTP', async () => {
  const h = await fixture(); fireEvent.click(trigger()); action('settings');
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: 'settings', tab: 'notifications', focus: 'notifications' }); h.showSettings();
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  const away = screen.getByLabelText('Away when idle') as HTMLSelectElement;
  const from = screen.getByLabelText('Pause at') as HTMLSelectElement;
  await waitFor(() => expect(away.disabled).toBe(false));
  expect(away.value).toBe('5'); expect(from.disabled).toBe(true);
  fireEvent.change(away, { target: { value: '2' } });
  await waitFor(() => expect(usePersonalSettings.getState().values['push.awayAfter']).toBe('2'));
  fireEvent.click(screen.getByRole('switch', { name: 'Daily quiet hours' }));
  await waitFor(() => expect(from.disabled).toBe(false));
  fireEvent.change(from, { target: { value: '21:30' } });
  await waitFor(() => expect(usePersonalSettings.getState().values['push.quietFrom']).toBe('21:30'));
  fireEvent.change(screen.getByLabelText('Resume at'), { target: { value: '07:30' } });
  await waitFor(async () => expect((await h.settings()).values).toMatchObject({
    'push.awayAfter': '2', 'push.quiet': true, 'push.quietFrom': '21:30', 'push.quietTo': '07:30', 'push.timeZone': 'Asia/Tokyo' }));
});
