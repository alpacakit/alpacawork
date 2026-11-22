/** All Task walks, watch registration and missed-notification repair run off the serving event loop. */
import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { setImmediate as turn } from 'node:timers/promises';
import { TASK_ID_PATTERN, type RunId } from '@alpacawork/contract';
import { RUN_FILES } from '@alpacawork/contract/run';
import { CONFIG_FILE } from '@alpacawork/raw';
import { TaskFileIndex } from '../control/task-files.js';
import { FileWriter } from '../raw/storage.js';
import { POLL_INTERVAL_MS } from '../poll-interval.js';
import { WorkspaceWatch } from './workspace-watch.js';
import type { FileObservationFault, FileWorkerMessage, FileWorkerRequest, WatchedRun, WorkspaceFileObservation } from './workspace-file-thread.js';

const root = resolve((workerData as { root: string }).root);
const validTask = new RegExp(`^${TASK_ID_PATTERN}$`);
const taskPath = new RegExp(`^tasks/(${TASK_ID_PATTERN})(?:/|$)`);
const personFiles = new Map([
  ['.alpacawork/personal-settings.json', 'settings'], ['.alpacawork/notice-state.json', 'notices'],
  ['.alpacawork/coordinator-read.json', 'coordinator'], ['.alpacawork/launch-memory.json', 'launch'],
]);
const post = (message: FileWorkerMessage) => parentPort!.postMessage(message);
const faultOf = (error: unknown, detail: { task?: string; path?: string } = {}): FileObservationFault => {
  const fault = error as NodeJS.ErrnoException;
  return { ...detail, message: fault?.message ?? String(error), ...fault?.code ? { code: fault.code } : {} };
};
const fileIndex = new TaskFileIndex();
const listed = new Map<string, string>();
const unreadable = new Set<string>();
const observedStamps = new Map<string, string>();
const pendingPaths = new Set<string>();
let fullRepair = false, stopped = false, pollQueued = false, nextTask = 0, nextFolderProbe = 0;
const runs = new Map<RunId, WatchedRun>();
let execution: readonly string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let work: Promise<void> = Promise.resolve();

function batch(repair = false): { fileLists: WorkspaceFileObservation['fileLists'][number][];
  keys: WorkspaceFileObservation['keys'][number][]; paths: string[]; faults: FileObservationFault[]; repair: boolean } {
  return { fileLists: [], keys: [], paths: [], faults: [], repair };
}
type Batch = ReturnType<typeof batch>;
function emit(value: Batch) {
  const keys = [...new Map(value.keys.map(key => [`${key.kind}:${key.id}`, key])).values()];
  post({ kind: 'observation', observation: { ...value, keys, paths: [...new Set(value.paths)],
    healthy: watcher.healthy && unreadable.size === 0 && value.faults.length === 0 } });
}
function enqueue(operation: () => Promise<void>) {
  work = work.then(async () => { if (!stopped) await operation(); }).catch(error => {
    post({ kind: 'failed', fault: faultOf(error) });
    stopped = true;
    clearInterval(pollTimer); clearInterval(repairTimer); clearTimeout(flushTimer);
    void watcher.close().finally(() => parentPort!.close());
  });
}
function changed(path?: string) {
  if (stopped) return;
  if (path === undefined) fullRepair = true;
  else pendingPaths.add(path);
  if (!flushTimer) flushTimer = setTimeout(() => {
    flushTimer = undefined;
    enqueue(flush);
  }, 25);
}
const watcher = new WorkspaceWatch(root, changed, {
  covers(path) {
    const [top, second, third] = path.split('/');
    if (top === '.alpacawork') return second === undefined || second === 'local-stops' && third === undefined;
    return top === 'tasks' && third !== 'work';
  },
  diagnostic(entry) {
    if (entry.state === 'degraded') post({ kind: 'observation', observation: {
      ...batch(), healthy: false, faults: [{ message: String(entry.message ?? 'Workspace watch degraded'),
        ...typeof entry.code === 'string' ? { code: entry.code } : {} }],
    } });
  },
});

/** The established reader retains classification, unreadable markers and no-follow file access policy. */
function scan(task: string, value: Batch) {
  const folder = `tasks/${task}`;
  try {
    const writer = new FileWriter(root);
    try {
      fileIndex.invalidate(folder);
      const files = fileIndex.read(writer, [folder]).get(folder)!;
      const stamp = JSON.stringify(files);
      if ((listed.get(task) ?? '[]') !== stamp || unreadable.has(task)) {
        value.fileLists.push({ task, files });
        value.keys.push({ kind: 'files', id: task });
      }
      listed.set(task, stamp);
      unreadable.delete(task);
    } finally { writer.close(); }
  } catch (error) {
    unreadable.add(task);
    value.faults.push(faultOf(error, { task, path: folder }));
  }
}
async function scanAll(value: Batch) {
  let discovered: string[];
  try {
    discovered = readdirSync(join(root, 'tasks'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && validTask.test(entry.name)).map(entry => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') discovered = [];
    else { unreadable.add('tasks'); value.faults.push(faultOf(error, { path: 'tasks' })); return; }
  }
  unreadable.delete('tasks');
  // Previously observed folders remain included so deletion publishes an empty list.
  for (const task of new Set([...listed.keys(), ...unreadable].filter(id => validTask.test(id)).concat(discovered))) {
    if (stopped) return;
    scan(task, value);
    await turn();
  }
}
function stamp(path: string, value: Batch): string {
  try {
    const info = lstatSync(join(root, path), { bigint: true });
    return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return '';
    value.faults.push(faultOf(error, { path }));
    return `fault:${(error as Error).message}`;
  }
}
function observe(path: string, value: Batch): boolean {
  const next = stamp(path, value);
  if (observedStamps.has(path) && observedStamps.get(path) === next) return false;
  observedStamps.set(path, next);
  value.paths.push(path);
  return true;
}
function observePersonal(value: Batch) {
  if (observe(CONFIG_FILE, value)) value.keys.push({ kind: 'config', id: CONFIG_FILE });
  for (const [path, id] of personFiles) if (observe(path, value)) value.keys.push({ kind: 'person', id });
  // Directory membership and each existing file cover both atomic replacement and in-place stop publication.
  const directory = '.alpacawork/local-stops';
  observe(directory, value);
  try {
    for (const entry of readdirSync(join(root, directory))) observe(`${directory}/${entry}`, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') value.faults.push(faultOf(error, { path: directory }));
  }
}
function probeRuns(value: Batch, every = false) {
  for (const run of runs.values()) {
    if (!every && run.state !== undefined && run.state !== 'running') continue;
    const files: readonly string[] = run.state === 'failed' ? [RUN_FILES.activity, RUN_FILES.recentWork, RUN_FILES.stdout]
      : [RUN_FILES.activity, RUN_FILES.recentWork];
    let differs = false;
    for (const file of files) if (observe(`.alpacawork/runs/${run.id}/${file}`, value)) differs = true;
    if (differs) value.keys.push({ kind: 'activity', id: run.id });
  }
  for (const path of execution) observe(path, value);
}
function validRun(run: WatchedRun): boolean {
  return /^R[1-9][0-9]*$/.test(run.id) && (run.task === null || validTask.test(run.task));
}
function removeRun(id: RunId) {
  runs.delete(id);
  for (const file of [RUN_FILES.activity, RUN_FILES.recentWork, RUN_FILES.stdout])
    observedStamps.delete(`.alpacawork/runs/${id}/${file}`);
}
async function repair() {
  const value = batch(true);
  await scanAll(value);
  observePersonal(value);
  probeRuns(value, true);
  emit(value);
}
async function flush() {
  const paths = [...pendingPaths]; pendingPaths.clear();
  const all = fullRepair || paths.some(path => path === 'tasks'); fullRepair = false;
  const value = batch(all);
  if (all) await scanAll(value);
  else for (const task of new Set(paths.flatMap(path => taskPath.exec(path)?.[1] ?? []))) scan(task, value);
  for (const path of paths) {
    if (path === CONFIG_FILE) {
      if (observe(path, value)) value.keys.push({ kind: 'config', id: path });
    } else if (personFiles.has(path)) {
      if (observe(path, value)) value.keys.push({ kind: 'person', id: personFiles.get(path)! });
    } else if (path === '.alpacawork/local-stops' || path.startsWith('.alpacawork/local-stops/')) value.paths.push(path);
  }
  if (all) { observePersonal(value); probeRuns(value, true); }
  if (value.fileLists.length || value.keys.length || value.paths.length || value.faults.length || all) emit(value);
}

const pollTimer = setInterval(() => {
  if (pollQueued || stopped) return;
  pollQueued = true;
  enqueue(async () => {
    try {
      const value = batch();
      probeRuns(value);
      const active = [...new Set([...runs.values()].filter(run => run.state === undefined || run.state === 'running')
        .flatMap(run => run.task === null ? [] : [run.task]))];
      if (active.length && Date.now() >= nextFolderProbe) {
        const started = performance.now();
        scan(active[nextTask++ % active.length]!, value);
        nextFolderProbe = Date.now() + Math.max(POLL_INTERVAL_MS, (performance.now() - started) * 20);
      }
      if (value.fileLists.length || value.keys.length || value.paths.length || value.faults.length) emit(value);
    } finally { pollQueued = false; }
  });
}, POLL_INTERVAL_MS);
const repairTimer = setInterval(() => enqueue(repair), 300_000);

enqueue(async () => {
  await watcher.initialized;
  await repair();
  post({ kind: 'ready' }); // The initial lists are delivered before initialized resolves on the serving thread.
});
parentPort!.on('message', (message: FileWorkerRequest) => {
  enqueue(async () => {
    if (message.kind === 'runs') {
      const initial = message.runs.filter(validRun);
      const retained = new Set(initial.map(run => run.id));
      for (const id of runs.keys()) if (!retained.has(id)) removeRun(id);
      for (const run of initial) runs.set(run.id, run);
      return;
    }
    if (message.kind === 'update-runs') {
      for (const id of message.update.remove) removeRun(id);
      for (const run of message.update.upsert) if (validRun(run)) runs.set(run.id, run);
      return;
    }
    if (message.kind === 'execution') {
      const next = message.paths.filter(path => /^\.alpacawork\/runs\/R[1-9][0-9]*\/protocol\/[a-f0-9-]{36}\/events\/[0-9]{12}\.json$/.test(path));
      for (const path of execution) if (!next.includes(path)) observedStamps.delete(path);
      execution = next;
      return;
    }
    try {
      if (message.kind === 'close') {
        stopped = true;
        clearInterval(pollTimer); clearInterval(repairTimer); clearTimeout(flushTimer);
        await watcher.close();
        post({ kind: 'reply', id: message.id });
        parentPort!.close();
        return;
      }
      if (message.kind === 'repair') await repair();
      else if (message.kind === 'opened') {
        const task = taskPath.exec(message.task)?.[1] ?? message.task;
        if (!validTask.test(task)) throw new Error('Invalid Task identity for file observation');
        const value = batch(); scan(task, value); emit(value);
        if (value.faults.length) { post({ kind: 'reply', id: message.id, fault: value.faults[0]! }); return; }
      }
      post({ kind: 'reply', id: message.id });
    } catch (error) { post({ kind: 'reply', id: message.id, fault: faultOf(error) }); }
  });
});
