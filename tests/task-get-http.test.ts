/** An HTTP Task read answers from current Run facts, and the live index is the same JSON in every encoding. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { touch } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { receiverClock } from './helpers/receiver-clock.ts';
import { AGENTS_TEMPLATE } from '@alpacawork/backend/test-dist/agents-settings.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { fields, time } from './runs-fixtures.ts';

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-task-get-http-')));
  const project = initializeControlFixture(root);
  writeFileSync(join(root, 'config.yaml'), AGENTS_TEMPLATE, { mode: 0o600 });
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: false,
    tasks: [{ title: 'Current Run facts' }] })).tasks[0]!;
  const writer = new RunStore(root, { busyTimeoutMs: 0 });
  const created = writer.write(tx => createFixtureRun(writer, tx, fields({ task: task.id }), 'Current input'));
  t.after(() => { writer.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, task, writer, created };
}

test('HTTP task get returns current Run facts and live sends the same authorized JSON in both encodings', async t => {
  const h = await fixture(t); receiverClock(t);
  h.writer.write(tx => tx.finish({ ...tx.get(h.created.id)!, state: 'cancelled', reason: 'stopped', ended_at: time }, { state: 'missing', text: null }));
  const server = await startServer(h.root, 0);
  try {
    const get = async () => {
      const response = await fetch(new URL(`/api/commands/task/get?task=${h.task.id}&runs=1`, server.url));
      assert.equal(response.status, 200); return response.json();
    };
    const first = await get();
    assert.deepEqual(await get(), first);
    h.writer.write(() => {
      h.writer.connection.prepare("UPDATE runs SET record=json_set(record,'$.launch.values.model','updated-model') WHERE id=?")
        .run(Number(h.created.id.slice(1)));
      touch(h.writer.connection, { kind: 'run', id: h.created.id });
    });
    assert.equal((await get()).runs[0].modelId, 'updated-model', 'a committed Run change is returned by the next authorized read');
    const index = async (encoding: string) => {
      const response = await fetch(new URL('/api/workspace/live', server.url), { headers: { 'accept-encoding': encoding } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('content-type')?.split(';')[0], 'application/json');
      assert.equal(response.headers.get('content-encoding'), encoding === 'gzip' ? 'gzip' : null);
      return response.text();
    };
    assert.equal(await index('gzip'), await index('identity'));
    const refused = await fetch(new URL('/api/workspace/live', server.url), { headers: { authorization: 'invalid' } });
    assert.equal(refused.status, 403);
  } finally { await server.close(); }
});
