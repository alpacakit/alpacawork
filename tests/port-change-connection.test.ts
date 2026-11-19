import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { assertPortChangeable } from '@alpacawork/backend/test-dist/release/switch.js';

test('port inspection survives synchronous service stop and still refuses unknown connection failures', { timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'port-inspection-')), stopped = new Int32Array(new SharedArrayBuffer(4));
  // A real server on another thread can finish stopping while the service adapter
  // blocks this thread; the client's queued FIN cannot run before the next probe.
  const server = new Worker(`
const {createServer} = require('node:http'), {parentPort,workerData} = require('node:worker_threads');
const server = createServer((_request,response) => response.end(JSON.stringify({
  workspace:workerData.workspace, schema:0, unfinishedRuns:[], contractUsers:[], unpublishedStops:0
})));
server.listen(0,'127.0.0.1',()=>parentPort.postMessage(server.address().port));
parentPort.once('message',()=>{server.closeAllConnections();server.close(()=>{
  const stopped = new Int32Array(workerData.stopped); Atomics.store(stopped,0,1); Atomics.notify(stopped,0);
});});`, { eval: true, workerData: { workspace: root, stopped: stopped.buffer } });
  t.after(async () => { await server.terminate(); rmSync(root, { recursive: true, force: true }); });
  const [port] = await once(server, 'message');
  mkdirSync(join(root, '.alpacawork'));
  writeFileSync(join(root, '.alpacawork/connection.json'), JSON.stringify({ url: `http://127.0.0.1:${port}/`,
    publicUrl: null, generation: randomUUID(), runManager: join(root, 'run-manager.js') }));
  const place = { workspace: root, releases: join(root, 'releases'), service: 'test.service', say: () => {} };
  await assertPortChangeable(place, null);
  await setImmediate();
  server.postMessage('stop');
  assert.notEqual(Atomics.wait(stopped, 0, 0, 5000), 'timed-out', 'the synchronous service stop must finish');
  assert.equal(Atomics.load(stopped, 0), 1);
  await assertPortChangeable(place, null);

  const fetch = globalThis.fetch;
  try {
    for (const code of ['UND_ERR_SOCKET', 'ECONNRESET']) {
      const error = new TypeError('fetch failed', { cause: Object.assign(new Error('unknown connection failure'), { code }) });
      globalThis.fetch = async () => { throw error; };
      await assert.rejects(assertPortChangeable(place, null), failure => failure === error);
    }
  } finally { globalThis.fetch = fetch; }
});
