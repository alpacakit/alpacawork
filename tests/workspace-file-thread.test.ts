import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { setImmediate as turn } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { RunId } from '@alpacawork/contract';
import { RUN_FILES } from '@alpacawork/contract/run';
import { taskProjectedViewSchema } from '@alpacawork/contract/control';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { WorkspaceFileThread, type WorkspaceFileObservation } from '@alpacawork/backend/test-dist/receiver/workspace-file-thread.js';
import { backendEntry } from '@alpacawork/backend/test-dist/app-paths.js';
import type { FileWorkerRequest, FileWorkerMessage } from '@alpacawork/backend/test-dist/receiver/workspace-file-thread.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert(check(), message);
}
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-file-thread-'));
  const observations: WorkspaceFileObservation[] = [];
  await mkdir(join(root, '.alpacawork'));
  await mkdir(join(root, 'tasks', 'T1', 'work'), { recursive: true });
  const start = (createWorker?: Parameters<typeof WorkspaceFileThread.start>[2]) => {
    const worker = WorkspaceFileThread.start(root, value => observations.push(value), createWorker);
    t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true }); });
    return worker;
  };
  return { root, observations, start };
}
function latest(observations: readonly WorkspaceFileObservation[], task = 'T1') {
  return observations.flatMap(value => value.fileLists).filter(value => value.task === task).at(-1)?.files;
}

test('initialization delivers complete Task file lists and preserves file classification before it resolves', async t => {
  const { root, observations, start } = await fixture(t);
  await writeFile(join(root, 'tasks', 'T1', 'note.md'), 'notes');
  await writeFile(join(root, 'tasks', 'T1', 'work', 'bytes.bin'), Buffer.from([0, 1, 2]));
  await symlink(join(root, 'tasks', 'T1', 'note.md'), join(root, 'tasks', 'T1', 'link.md'));
  await mkdir(join(root, 'tasks', 'P2'));
  await writeFile(join(root, 'tasks', 'P2', 'plan.md'), 'plan');
  const worker = start();
  await worker.initialized;
  assert.deepEqual(latest(observations)?.map(file => file.name), ['note.md', 'work/bytes.bin']);
  assert.deepEqual(latest(observations, 'P2')?.map(file => file.name), ['plan.md']);
  assert.equal(latest(observations)?.find(file => file.name === 'work/bytes.bin')?.size, 3);
  assert(worker.healthy);
  assert(observations.some(value => value.keys.some(key => key.kind === 'files' && key.id === 'T1')));
});

class FixtureWorker extends EventEmitter {
  readonly requests: FileWorkerRequest[] = [];
  postMessage(message: FileWorkerRequest) {
    this.requests.push(message);
    if ('id' in message) queueMicrotask(() => this.emit('message', { kind: 'reply', id: message.id } satisfies FileWorkerMessage));
  }
  async terminate() { this.emit('exit', 1); return 1; }
  ready() {
    this.emit('message', { kind: 'observation', observation: { fileLists: [{ task: 'T1', files: [] }], keys: [], paths: [],
      repair: true, healthy: true, faults: [] } } satisfies FileWorkerMessage);
    this.emit('message', { kind: 'ready' } satisfies FileWorkerMessage);
  }
}

test('worker failures back off, retain known observations explicitly, recover, and cannot restart after close', async t => {
  const observations: WorkspaceFileObservation[] = [], workers: FixtureWorker[] = [];
  let failing = true;
  const thread = WorkspaceFileThread.start('/fixture', value => observations.push(value), () => {
    const worker = new FixtureWorker(); workers.push(worker);
    queueMicrotask(() => workers.length > 1 && failing ? worker.emit('exit', 1) : worker.ready());
    return worker;
  });
  t.after(() => thread.close());
  await thread.initialized;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  workers[0]!.emit('exit', 1);
  const opening = thread.openedTask('T1');
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await turn(); };
  await advance(249); assert.equal(workers.length, 1);
  await advance(1); assert.equal(workers.length, 2);
  await advance(499); assert.equal(workers.length, 2);
  await advance(1); assert.equal(workers.length, 3);
  assert.equal((await opening).state, 'retained');
  assert.equal(thread.healthy, false);
  assert.ok(observations.some(value => !value.healthy && value.faults.some(fault => fault.message.includes('ended'))));
  failing = false;
  await advance(1000);
  assert.equal((await thread.openedTask('T1')).state, 'observed');
  assert.equal(thread.healthy, true);
  workers.at(-1)!.emit('exit', 1);
  await thread.close();
  const closed = workers.length;
  await advance(30_000);
  assert.equal(workers.length, closed, 'shutdown cancels the pending restart');
});

test('an unexpected real worker exit restores watches and Task files through HTTP views', async t => {
  const area = await mkdtemp(join(tmpdir(), 'workspace-file-http-'));
  const original = createOriginal({ tasks: 4, logs: 4, runs: 0, seed: 'worker-http-recovery' }, join(area, 'originals'));
  const root = copyWorkspace(original.root, join(area, 'working')).root;
  const observations: WorkspaceFileObservation[] = [];
  const workers: Worker[] = [];
  const captured: { thread?: WorkspaceFileThread } = {};
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      try { await captured.thread?.close(); }
      finally { removeWorkspace(root); removeWorkspace(original.root); await rm(area, { recursive: true, force: true }); }
    }
  });
  const task = 'T2', removedTask = 'T3';
  await mkdir(join(root, 'tasks', task, 'work'), { recursive: true });
  await mkdir(join(root, 'tasks', removedTask), { recursive: true });
  await writeFile(join(root, 'tasks', task, 'work', 'initial.md'), 'known before the worker exits');
  await writeFile(join(root, 'tasks', removedTask, 'removed.md'), 'removed while the worker is down');
  const tail = '.alpacawork/runs/R2/protocol/00000000-0000-0000-0000-000000000000/events/000000000001.json';
  await mkdir(join(root, tail, '..'), { recursive: true });
  const realStart = WorkspaceFileThread.start;
  t.mock.method(WorkspaceFileThread, 'start', (workspace: string, observed: Parameters<typeof realStart>[1]) => captured.thread = realStart(workspace, observation => {
    observations.push(observation); observed(observation);
  }, () => {
    const worker = new Worker(backendEntry('receiver/workspace-file-worker'), { workerData: { root: workspace } });
    workers.push(worker); return worker;
  }));
  server = await startServer(root, 0);
  const thread = captured.thread;
  assert.ok(thread);
  const readView = async () => {
    const response = await fetch(new URL(`/api/task/view?task=${task}`, server!.url), { signal: AbortSignal.timeout(10_000) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return taskProjectedViewSchema.parse(body);
  };
  const initial = await readView();
  assert.equal(initial.row.id, task);
  assert.ok(initial.task.files?.some(file => file.name === 'work/initial.md'));
  thread.observeRuns([{ id: 'R1' as RunId, task, state: 'running' }]);
  await thread.repair();
  await workers[0]!.terminate();
  assert.equal(thread.healthy, false);
  await rm(join(root, 'tasks', removedTask), { recursive: true });
  await writeFile(join(root, 'tasks', task, 'work', 'recovered.md'), 'written while down');
  thread.updateRuns({ upsert: [{ id: 'R2' as RunId, task, state: 'running' }], remove: ['R1' as RunId] });
  thread.observeExecution([tail]);
  const recovered = await readView();
  assert.equal(recovered.row.id, task);
  assert.ok(recovered.task.files?.some(file => file.name === 'work/initial.md'));
  assert.ok(recovered.task.files?.some(file => file.name === 'work/recovered.md'), 'opening the Task over HTTP observes files after worker recovery');
  assert.equal(workers.length, 2);
  assert.equal(thread.healthy, true);
  assert.deepEqual(latest(observations, removedTask), [], 'a folder deleted while down cannot retain its old file list');
  observations.length = 0;
  await writeFile(join(root, '.alpacawork', 'runs', 'R2', RUN_FILES.activity), '{}');
  await writeFile(join(root, tail), '{}');
  await writeFile(join(root, 'tasks', task, 'work', 'polled.md'), 'active work');
  await until(() => observations.some(value => value.keys.some(key => key.kind === 'activity' && key.id === 'R2')), 'replacement worker lost its Run watches');
  await until(() => observations.some(value => value.paths.includes(tail)), 'replacement worker lost execution-tail watches');
  await until(() => !!latest(observations, task)?.some(file => file.name === 'work/polled.md'), 'replacement worker lost active Task polling');
  assert.ok((await readView()).task.files?.some(file => file.name === 'work/polled.md'), 'the HTTP view receives file observations from the replacement worker');
  await server.close();
  await thread.close();
  const closed = workers.length;
  await delay(300);
  assert.equal(workers.length, closed);
});

test('opened Tasks and repair publish worker results without enumerating on the calling thread', async t => {
  const { root, observations, start } = await fixture(t);
  const entries = FileWriter.prototype.entries;
  FileWriter.prototype.entries = () => { throw new Error('Task enumeration reached the serving thread'); };
  t.after(async () => { FileWriter.prototype.entries = entries; });
  const worker = start();
  await worker.initialized;
  await writeFile(join(root, 'tasks', 'T1', 'work', 'draft.md'), 'draft');
  await worker.openedTask('T1');
  assert.deepEqual(latest(observations)?.map(file => file.name), ['work/draft.md']);
  await rm(join(root, 'tasks', 'T1', 'work', 'draft.md'));
  await worker.repair();
  assert.deepEqual(latest(observations), []);
  await mkdir(join(root, 'tasks', 'T3'));
  await writeFile(join(root, 'tasks', 'T3', 'new.md'), 'new');
  await worker.repair();
  assert.deepEqual(latest(observations, 'T3')?.map(file => file.name), ['new.md']);
  await rm(join(root, 'tasks', 'T3'), { recursive: true });
  await worker.repair();
  assert.deepEqual(latest(observations, 'T3'), []);
  await assert.rejects(worker.openedTask('../escape'), /Invalid Task identity/);
});

test('watch notifications carry file lists and config, person and local stop signals', async t => {
  const { root, observations, start } = await fixture(t);
  const worker = start(); await worker.initialized;
  observations.length = 0;
  await writeFile(join(root, 'tasks', 'T1', 'note.md'), 'new');
  await writeFile(join(root, 'config.yaml'), 'agents: {}');
  await writeFile(join(root, '.alpacawork', 'personal-settings.json.tmp'), '{}');
  await rename(join(root, '.alpacawork', 'personal-settings.json.tmp'), join(root, '.alpacawork', 'personal-settings.json'));
  await mkdir(join(root, '.alpacawork', 'local-stops'));
  await writeFile(join(root, '.alpacawork', 'local-stops', 'stop.json'), '{}');
  await until(() => !!latest(observations)?.some(file => file.name === 'note.md'), 'watched file list was not published');
  await until(() => observations.some(value => value.keys.some(key => key.kind === 'config')), 'config change was not observed');
  await until(() => observations.some(value => value.keys.some(key => key.kind === 'person' && key.id === 'settings')), 'personal settings change was not observed');
  await until(() => observations.some(value => value.paths.some(path => path.startsWith('.alpacawork/local-stops'))), 'stop publication was not observed');
});

test('unreadable files retain their marker and a failed folder retains its last successful list', async t => {
  if (process.getuid?.() === 0) { t.skip('Permission denial requires an unprivileged user'); return; }
  const { root, observations, start } = await fixture(t);
  const denied = join(root, 'tasks', 'T1', 'work', 'denied.md');
  await writeFile(denied, 'private');
  await chmod(denied, 0);
  const worker = start(); await worker.initialized;
  const initial = latest(observations);
  assert.equal(initial?.[0]?.readable, false);
  assert.equal(initial?.[0]?.revision, 'unreadable');
  const work = join(root, 'tasks', 'T1', 'work');
  await chmod(work, 0);
  try {
    await assert.rejects(worker.openedTask('T1'), /EACCES|permission denied/i);
    assert.deepEqual(latest(observations), initial);
    assert(observations.some(value => value.faults.some(fault => fault.task === 'T1' && fault.code === 'EACCES')));
    assert.equal(worker.healthy, false);
  } finally { await chmod(work, 0o700); }
  await chmod(denied, 0o600);
  await worker.openedTask('T1');
  assert.equal(latest(observations)?.[0]?.readable, undefined);
  assert.equal(latest(observations)?.[0]?.size, 7);
});

test('active Run polling notices activity and unwatched work, execution tails and failed stdout repair', async t => {
  const { root, observations, start } = await fixture(t);
  const folder = join(root, '.alpacawork', 'runs', 'R1');
  const tail = '.alpacawork/runs/R1/protocol/00000000-0000-0000-0000-000000000000/events/000000000001.json';
  await mkdir(join(root, tail, '..'), { recursive: true });
  const worker = start(); await worker.initialized;
  worker.observeRuns([{ id: 'R1' as RunId, task: 'T1', state: 'running' }]);
  worker.observeExecution([tail]);
  await until(() => observations.some(value => value.keys.some(key => key.kind === 'activity' && key.id === 'R1')), 'Run baseline was not observed');
  observations.length = 0;
  await writeFile(join(folder, RUN_FILES.activity), '{}');
  await writeFile(join(root, 'tasks', 'T1', 'work', 'live.md'), 'live');
  await writeFile(join(root, tail), '{}');
  await until(() => observations.some(value => value.keys.some(key => key.kind === 'activity' && key.id === 'R1')), 'activity change was not observed');
  await until(() => !!latest(observations)?.some(file => file.name === 'work/live.md'), 'active Task work was not observed');
  await until(() => observations.some(value => value.paths.includes(tail)), 'published event tail was not observed');
  worker.updateRuns({ upsert: [{ id: 'R1' as RunId, task: 'T1', state: 'failed' }], remove: [] });
  await worker.repair(); // Establish the failed stdout baseline at the same public boundary.
  observations.length = 0;
  await writeFile(join(folder, RUN_FILES.stdout), 'failure repaired');
  await worker.repair();
  assert(observations.some(value => value.keys.some(key => key.kind === 'activity' && key.id === 'R1')));
  worker.updateRuns({ upsert: [{ id: 'R2' as RunId, task: null, state: 'running' }], remove: ['R1' as RunId] });
  await worker.repair();
  assert(observations.some(value => value.keys.some(key => key.kind === 'activity' && key.id === 'R2')));
  observations.length = 0;
  await writeFile(join(folder, RUN_FILES.stdout), 'removed Run changed');
  await worker.repair();
  assert(!observations.some(value => value.keys.some(key => key.kind === 'activity' && key.id === 'R1')));
  await worker.close();
  worker.updateRuns({ upsert: [{ id: 'R1' as RunId, task: 'T1', state: 'running' }], remove: [] });
  assert.equal(worker.healthy, false);
  await assert.rejects(worker.openedTask('T1'), /closing/);
});
