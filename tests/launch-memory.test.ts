import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';

const change = async (url: string, value: unknown) => {
  const response = await fetch(new URL('/api/launch-memory', url), { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alpacawork-op-id': crypto.randomUUID() }, body: JSON.stringify({ change: value }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
/** What another screen (a phone) is given: the index every screen reads. */
const remembered = async (url: string) => (await (await fetch(new URL('/api/workspace/live', url))).json()).launchMemory;

test('the last choice in one screen\'s input is where another screen\'s next new conversation starts', async t => {
  // A home of its own, so serve reads no installation of this machine.
  const base = mkdtempSync(join(tmpdir(), 'launch-memory-')), root = join(base, 'workspace'), home = join(base, 'home');
  mkdirSync(home);
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(base, { recursive: true, force: true });
  });
  await initializeWorkspace(root, []);
  const app = await startServer(root, 0);
  try {
    assert.deepEqual(await remembered(app.url), { agent: null, values: {} });
    await change(app.url, { kind: 'choose', agent: 'claude', values: { model: 'opus', effort: 'high' } });
    await change(app.url, { kind: 'choose', agent: 'codex', values: { model: 'gpt-6.2-sol' } });
    // Each agent keeps its own values; the agent last chosen is where a new conversation starts.
    const both: Record<string, Record<string, string>> = { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-6.2-sol' } };
    assert.deepEqual(await remembered(app.url), { agent: 'codex', values: both });
    // Two screens on the same agent choose different rows: each keeps the other's.
    await change(app.url, { kind: 'choose', agent: 'claude', values: { effort: 'low' } });
    await change(app.url, { kind: 'choose', agent: 'claude', values: { model: 'fable' } });
    both.claude = { model: 'fable', effort: 'low' };
    assert.deepEqual(await remembered(app.url), { agent: 'claude', values: both });
    // Setup lets the agent go and keeps the values.
    await change(app.url, { kind: 'forget-agent' });
    assert.deepEqual(await remembered(app.url), { agent: null, values: both });
  } finally { await app.close(); }
});
