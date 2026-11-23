import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
/** Early direct denial must leave an actually importable Run's SQL and spool untouched. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { digestBytes } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { assignResponsible } from './helpers/control-fixture.ts';
import { receiverClock } from './helpers/receiver-clock.ts';
import { callerWorkspace, conversationHeaders } from './coordinator-caller.fixture.ts';

type Server = Awaited<ReturnType<typeof startServer>>;
async function subject(t: TestContext, start = startServer) {
  // The existing receiver clock leaves background import pending until an entry actually identifies its caller.
  receiverClock(t);
  let server: Server | undefined; t.after(async () => { await server?.close(); });
  const w = callerWorkspace(t);
  const task = (await new ControlTaskCommands(w.root, { kind: 'human' }).create({ parentId: w.project, userRequested: false,
    tasks: [{ title: 'Synthetic pending conversation' }] })).tasks[0];
  const placement = await assignResponsible(w.root, task, 'codex');
  const run = w.heldRun({ task: task.id, placementId: placement.id, session: null, attempt: true });
  server = await start(w.root, 0);
  const conversation = 'unimported-' + randomUUID(); w.journal(run, conversation);
  const store = new RunStore(w.root, { busyTimeoutMs: 1000 }); t.after(() => store.close());
  assert.equal(store.runtimeGet(run.id)?.session, null);
  const snapshot = () => {
    const tables = store.connection.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const sql = Object.fromEntries(tables.map(row => [String(row.name), store.connection.prepare(`SELECT * FROM "${row.name}"`).all()]));
    const files: Record<string, string> = {};
    const walk = (folder: string) => { for (const name of readdirSync(folder)) {
      if (name === 'alpacawork.sqlite' || name.startsWith('alpacawork.sqlite-') || name === 'host.sqlite' || name.startsWith('host.sqlite-')) continue;
      const path = join(folder, name), info = lstatSync(path);
      files[path.slice(w.root.length)] = info.isFile() ? digestBytes(readFileSync(path)) : 'directory';
      if (info.isDirectory()) walk(path);
    } }; walk(w.root); return { sql, files };
  };
  async function call(path: string, cli: boolean, direct = true) {
    const response = await fetch(new URL(path, server!.url), { method: path.includes('confirm') || path.includes('cancel') ? 'POST' : 'GET',
      headers: { ...(direct ? conversationHeaders(conversation, 'codex') : {}),
        ...(cli && { 'x-alpacawork-client': 'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT) }), 'content-type': 'application/json' },
      ...(path.includes('confirm') || path.includes('cancel') ? { body: '{malformed body before authorization' } : {}) });
    return { status: response.status, body: await response.json() as any };
  }
  return { w, task, run, store, snapshot, call };
}

test('new human acts and SCREEN refuse unknown direct conversations before import with/without CLI and encoded aliases', async t => {
  const f = await subject(t), before = f.snapshot();
  for (const cli of [false, true]) for (const encoded of [false, true]) {
    for (const path of ['/api/update/review', '/api/update/confirm', '/api/update/cancel', '/api/workspace/folders']) {
      // Encode the first byte of the route component without changing the resolved route.
      const target = encoded ? '/api/%' + path.charCodeAt(5).toString(16) + path.slice(6) : path;
      const result = await f.call(target, cli);
      assert.equal(result.status, 403, JSON.stringify(result)); assert.equal(result.body.error.reason.kind, 'authorization_required');
      assert.equal(result.body.error.reason.action, path.includes('/update/') ? 'update.' + path.split('/').at(-1) : 'screen');
      assert.deepEqual(f.snapshot(), before); assert.equal(f.store.runtimeGet(f.run.id)?.session, null);
    }
  }
  // A normal CLI entry preserves resolveCaller's original import/reason/detail, proving the journal was not inert.
  const ordinary = await f.call('/api/commands/task/get?task=' + f.task.id, true);
  assert.equal(ordinary.status, 403); assert.equal(ordinary.body.error.reason.kind, 'conversation_belongs_alpacawork_run');
  assert.deepEqual(ordinary.body.error.detail, { conversation: 'task_run' });
  assert.notDeepEqual(f.snapshot(), before); assert.ok(f.store.runtimeGet(f.run.id)?.session);
});

test('removing either preflight site makes the original no-import assertion fail at the real HTTP boundary', async t => {
  const production = resolve('apps/backend/test-dist/receiver/server.js'), source = readFileSync(production, 'utf8');
  const cases = [
    { name: 'cli', marker: 'preflightEntryClaim(root, routeActs.get(`${c.req.method} ${c.req.path}`), scopeOf(c.req.raw).claim);', cli: true },
    { name: 'entry', marker: 'preflightEntryClaim(root, act, claim);', cli: false },
  ];
  // Each subtest owns a distinct clock and synthetic workspace.
  for (const entry of cases) await t.test(entry.name, async child => {
    assert.ok(source.includes(entry.marker));
    const file = join(dirname(production), `server-preflight-${entry.name}-${process.pid}.js`); child.after(() => rmSync(file, { force: true }));
    writeFileSync(file, source.replace(entry.marker, ''));
    const mutant = await import(pathToFileURL(file).href);
    const f = await subject(child, mutant.startServer), before = f.snapshot();
    const result = await f.call('/api/update/review', entry.cli);
    assert.equal(result.status, 403); assert.ok(f.store.runtimeGet(f.run.id)?.session, 'the removed site must let actual import run');
    assert.throws(() => assert.deepEqual(f.snapshot(), before), assert.AssertionError);
  });
});
