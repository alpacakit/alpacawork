import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { hasCode } from '@alpacawork/core';
import { RUN_FILES, runFolder, runNumber } from '@alpacawork/contract/run';
import { runIdSchema } from '@alpacawork/contract';
import { readControl } from '../control/task-store.js';
import { supportsTally, TallyParser, tallySchema, type Tally } from '../agents/adapters/tally.js';
import { JsonlReader } from '../runs/readers/jsonl.js';
import { writeRunFile } from '../runs/files.js';

const MAX_STDOUT = 128 * 1024 * 1024;
const MAX_TALLY = 8 * 1024 * 1024;
const BATCH_SIZE = 32;
const { root } = workerData as { root: string };
const port = parentPort!;
type TallyRun = { id: string; provider: string; adapter: string; session: string | null };
const runSource = `SELECT 'R' || id AS id, json_extract(record,'$.agent') AS provider,
  json_extract(record,'$.launch.adapter') AS adapter, session_id AS session
  FROM runs WHERE task_id IS NOT NULL AND state IN ('succeeded','failed','cancelled')
    AND json_extract(record,'$.pids.agent') IS NOT NULL AND json_extract(record,'$.started_at') IS NOT NULL`;
const pending = new Set<string>(), done = new Set<string>();
let history: TallyRun[] = [], recent: TallyRun[] = [], running = false, stopped = false;

function ordinaryFile<T>(path: string, read: (fd: number, size: number) => T): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Expected a regular Run file');
    return read(fd, stat.size);
  } finally { closeSync(fd); }
}

function tally({ id, provider, adapter, session }: TallyRun): Tally | undefined {
  const folder = runFolder(root, id);
  if (!lstatSync(dirname(folder)).isDirectory() || !lstatSync(folder).isDirectory()) return;
  const output = join(folder, RUN_FILES.tally);
  try {
    const existing = ordinaryFile(output, (fd, size) => size <= MAX_TALLY
      ? tallySchema.safeParse(JSON.parse(readFileSync(fd, 'utf8'))) : null);
    if (existing?.success) return existing.data;
  } catch (error) {
    if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ELOOP') && !(error instanceof SyntaxError)) throw error;
  }

  const parser = new TallyParser(adapter, provider, session);
  let state: Tally['state'] = 'unsupported';
  if (supportsTally(adapter)) {
    try {
      state = ordinaryFile(join(folder, RUN_FILES.stdout), (fd, size) => {
        if (!size) return 'unsupported';
        const lines = new JsonlReader(), observe = (value: unknown) => parser.observe(value);
        lines.readFd(fd, observe, MAX_STDOUT);
        if (size <= MAX_STDOUT) lines.finish(observe);
        return size > MAX_STDOUT || lines.rejection ? 'partial' : 'complete';
      });
    } catch (error) {
      if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ELOOP')) throw error;
    }
  }
  const result = parser.finish(state);
  writeRunFile(folder, RUN_FILES.tally, JSON.stringify(result));
  return result;
}

function loadPending() {
  const ids: string[] = [];
  for (const id of pending) {
    pending.delete(id);
    ids.push(id);
    if (ids.length === BATCH_SIZE) break;
  }
  try {
    return readControl(root, db => db.prepare(runSource + ' AND runs.id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(ids.map(runNumber))) as TallyRun[]);
  } catch {
    port.postMessage({ issue: ids.join(', ') });
    return [];
  }
}

function work() {
  if (stopped) return;
  if (!recent.length && pending.size) recent = loadPending();
  const batch: [string, Tally][] = [], until = performance.now() + 20;
  for (let visited = 0; visited < BATCH_SIZE && (recent.length || !pending.size && history.length) && performance.now() < until; visited++) {
    const run = recent.pop() ?? history.pop()!;
    if (done.has(run.id)) continue;
    try {
      const value = tally(run);
      if (value) { done.add(run.id); batch.push([run.id, value]); }
    } catch (error) {
      // Usage remains available if a Run folder disappeared or could not be tallied.
      if (!hasCode(error, 'ENOENT')) port.postMessage({ issue: run.id });
    }
  }
  if (batch.length) port.postMessage({ batch });
  if (pending.size || recent.length || history.length) setTimeout(work, 20);
  else running = false;
}

function rescan() {
  history = readControl(root, db => db.prepare(runSource + " ORDER BY julianday(json_extract(record,'$.ended_at')), runs.id")
    .all() as TallyRun[]).filter(run => !done.has(run.id));
}

port.on('message', (message: { stop?: true; rescan?: true; ids?: string[] }) => {
  if (message.stop) { stopped = true; port.close(); return; }
  if (message.rescan) rescan();
  for (const id of message.ids ?? []) if (runIdSchema.safeParse(id).success && !done.has(id)) pending.add(id);
  if (!running) { running = true; setImmediate(work); }
});
