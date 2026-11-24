import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { hasCode } from '@alpacawork/core';
import { RUN_FILES } from '@alpacawork/contract/run';
import { runIdSchema } from '@alpacawork/contract';
import { readControl } from '../control/task-store.js';
import { supportsTally, TallyParser, tallySchema, type Tally } from '../agents/adapters/tally.js';
import { JsonlReader } from '../runs/readers/jsonl.js';
import { writeRunFile } from '../runs/files.js';

const MAX_STDOUT = 128 * 1024 * 1024;
const MAX_TALLY = 8 * 1024 * 1024;
const filename = 'tally.json';
const { root } = workerData as { root: string };
const port = parentPort!;
const folders = join(root, '.alpacawork', 'runs');
const ended = `r.task_id IS NOT NULL AND r.state IN ('succeeded','failed','cancelled')
  AND (a.started_json IS NOT NULL OR a.run_no IS NULL AND json_extract(r.record,'$.pids.agent') IS NOT NULL)`;
const joined = 'FROM runs r LEFT JOIN run_attempts a ON a.run_no=r.id';
const pending = new Set<string>(), done = new Set<string>();
let history: string[] = [], running = false, stopped = false;

function ordinaryFile<T>(path: string, read: (fd: number, size: number) => T): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Expected a regular Run file');
    return read(fd, stat.size);
  } finally { closeSync(fd); }
}

function tally(id: string): Tally | undefined {
  const n = Number(id.slice(1));
  const row = readControl(root, db => db.prepare(`SELECT json_extract(r.record,'$.agent') AS provider,
    json_extract(r.record,'$.launch.adapter') AS adapter, r.session_id AS session
    ${joined} WHERE r.id=? AND ${ended}`).get(n));
  if (!row) return;
  const folder = join(folders, id);
  if (!lstatSync(folders).isDirectory() || !lstatSync(folder).isDirectory()) return;
  const output = join(folder, filename);
  try {
    const existing = ordinaryFile(output, (fd, size) => size <= MAX_TALLY
      ? tallySchema.safeParse(JSON.parse(readFileSync(fd, 'utf8'))) : null);
    if (existing?.success) return existing.data;
  } catch (error) {
    if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ELOOP') && !(error instanceof SyntaxError)) throw error;
  }

  const adapter = String(row.adapter), parser = new TallyParser(adapter, String(row.provider), row.session as string | null);
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
  writeRunFile(folder, filename, JSON.stringify(result));
  return result;
}

function work() {
  if (stopped) return;
  const batch: [string, Tally][] = [], until = performance.now() + 20;
  let visited = 0;
  while ((pending.size || history.length) && visited++ < 32 && performance.now() < until) {
    const fresh = pending.values().next().value;
    const id = fresh ?? history.pop()!;
    if (fresh) pending.delete(fresh);
    if (done.has(id)) continue;
    try {
      const value = tally(id);
      if (value) { done.add(id); batch.push([id, value]); }
    } catch (error) {
      // Usage remains available if a Run folder disappeared or could not be tallied.
      if (!hasCode(error, 'ENOENT')) port.postMessage({ issue: id });
    }
  }
  if (batch.length) port.postMessage({ batch });
  if (pending.size || history.length) setTimeout(work, 20);
  else running = false;
}

function rescan() {
  history = readControl(root, db => db.prepare(`SELECT r.id ${joined} WHERE ${ended}
    ORDER BY json_extract(r.record,'$.ended_at'), r.id`).all().map(row => 'R' + row.id));
}

port.on('message', (message: { stop?: true; rescan?: true; ids?: string[] }) => {
  if (message.stop) { stopped = true; port.close(); return; }
  if (message.rescan) rescan();
  for (const id of message.ids ?? []) if (runIdSchema.safeParse(id).success && !done.has(id)) pending.add(id);
  if (!running) { running = true; setImmediate(work); }
});
