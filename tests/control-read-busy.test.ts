import { initializeControlFixture } from './helpers/control-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { RunStore } from '@alpacawork/runs';

test('parallel tree/event reads use committed DB state during a file writer lock', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-read-busy-')));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await server?.close(); rmSync(root, { recursive: true, force: true }); });
  const initializer = new FileWriter(root);
  writeFileSync(join(root, 'config.yaml'), 'agents: {}\n');
  let project: string;
  try { project = initializeControlFixture(root); } finally { initializer.close(); }
  await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: null,
    tasks: [{ title: 'No agent fixture' }] });
  server = await startServer(root, 0);
  const url = (path: string) => new URL(path, server!.url);
  async function read(path: string) {
    const response = await fetch(url(path), { signal: AbortSignal.timeout(5000) });
    if (response.body) await response.body.cancel();
    return response.status;
  }
  const paths = ['/api/workspace/live', '/api/events', '/api/workspace/live', '/api/events'];
  assert.deepEqual(await Promise.all(paths.map(read)), [200, 200, 200, 200]);

  const writer = new FileWriter(root);
  try {
    await writer.locked(async () => {
      assert.deepEqual(await Promise.all(paths.map(read)), [200, 200, 200, 200]);
    });
  } finally { writer.close(); }
  assert.deepEqual(await Promise.all(paths.map(read)), [200, 200, 200, 200]);
  const runs = RunStore.openReadable(root, { busyTimeoutMs: 0 });
  try { assert.deepEqual(runs?.read() ?? [], []); } finally { runs?.close(); }
});
