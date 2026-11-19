/** One capture per failed test, while its page and runtime still belong to the fixture.
 * SQLite backup is consistent; the later live file copy deliberately is not atomic with it. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import type { Page, TestInfo } from '@playwright/test';
import { preserveFailureWorkspace } from '../tests/helpers/failure-workspace.ts';
import type { Runtime } from './server.ts';
import { failureJson, withFixtureCleanup } from './fixture-cleanup.ts';

type Outcome = { name: string; begin: string; end?: string; status?: 'fulfilled' | 'rejected'; reason?: string };
type Capture = {
  raw?: { outcomes: (Outcome & { present?: boolean })[]; faults: unknown[] };
  outcomes: Outcome[];
  faults: unknown[];
  timing: { raw: (Outcome & { present?: boolean })[]; backup?: Outcome; runsCopy?: Outcome;
    attempts?: unknown[]; files?: string[]; apis: (Outcome & { statusCode?: number })[] };
  promise?: Promise<void>;
  complete: boolean;
};
const captures = new WeakMap<TestInfo, Map<string, Capture>>();
function captureFor(runtime: Runtime, info: TestInfo): Capture {
  const known = captures.get(info) ?? new Map<string, Capture>(); captures.set(info, known);
  let capture = known.get(runtime.root);
  if (!capture) {
    capture = { outcomes: [], faults: [], timing: { raw: [], apis: [] }, complete: false };
    known.set(runtime.root, capture);
  }
  return capture;
}
function writeRawManifest(runtime: Runtime, info: TestInfo, capture: Capture, terminal = false) {
  writeFileSync(info.outputPath('runtime-raw/capture-manifest.json'), JSON.stringify({ root: runtime.root,
    testId: info.testId, status: info.status, errors: info.errors, raw: capture.raw!.outcomes,
    ...(terminal ? { complete: false, mode: 'worker-exit-before-cleanup-finished' } : {}),
    argv: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], pid: process.pid,
    consistency: 'sequential live copies, not atomic; preserved before backup or disposal' }, null, 2));
}

/** Synchronous so the same raw Owner can run at the worker's last exit, before the keeper disposes its root. */
function captureRaw(runtime: Runtime, info: TestInfo) {
  const capture = captureFor(runtime, info);
  if (capture.raw) return capture.raw;
  const result = { outcomes: [] as (Outcome & { present?: boolean })[], faults: [] as unknown[] };
  capture.raw = result;
  for (const source of ['config.yaml', '.alpacawork/alpacawork.sqlite', '.alpacawork/alpacawork.sqlite-wal',
    '.alpacawork/alpacawork.sqlite-shm', '.alpacawork/runs']) {
    const outcome: (typeof result.outcomes)[number] = { name: source, begin: new Date().toISOString() };
    result.outcomes.push(outcome);
    try {
      outcome.present = existsSync(join(runtime.root, source));
      if (outcome.present) {
        const target = join(info.outputPath('runtime-raw'), source);
        mkdirSync(join(target, '..'), { recursive: true });
        cpSync(join(runtime.root, source), target, { recursive: true });
      }
      outcome.status = 'fulfilled';
    } catch (error) { outcome.status = 'rejected'; outcome.reason = String(error); result.faults.push(error); }
    finally { outcome.end = new Date().toISOString(); }
  }
  try { writeRawManifest(runtime, info, capture); }
  catch (error) { result.faults.push(error); }
  return result;
}

/** Runtime lifetime, including stop faults and a runner-aborted teardown. No DB copy on successful disposal.
 * SIGKILL/OS death cannot run an exit hook; an exit capture explicitly proves raw bytes only. */
export async function withRuntimeEvidence(runtime: Runtime, info: TestInfo, use: () => Promise<void>,
  stages: Parameters<typeof withFixtureCleanup>[1], record: Parameters<typeof withFixtureCleanup>[2] = () => {}) {
  const exiting = () => {
    const capture = captureFor(runtime, info);
    if (capture.complete) return;
    const raw = captureRaw(runtime, info);
    capture.timing.raw = raw.outcomes;
    const exit: Outcome = { name: 'worker-exit', begin: new Date().toISOString(), status: 'rejected',
      reason: 'Worker exited before failure evidence completed', end: new Date().toISOString() };
    capture.outcomes.push(exit);
    // Exit cannot await attachments. Attempt each terminal record synchronously, reusing the original raw.
    const writes = [
      () => writeRawManifest(runtime, info, capture, true),
      () => writeFileSync(info.outputPath('runtime-capture.json'), JSON.stringify({ ...capture.timing,
        root: runtime.root, origin: runtime.origin, testId: info.testId, status: info.status, errors: info.errors,
        complete: false, mode: 'worker-exit-before-cleanup-finished', outcomes: capture.outcomes,
        faults: [...new Set([...raw.faults, ...capture.faults])].map(failureJson),
        argv: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], pid: process.pid,
        consistency: 'preserved sequential raw copies; unfinished operations are not complete; worker exit cannot await attachments' }, null, 2)),
      () => writeFileSync(info.outputPath('failure-capture.json'), JSON.stringify(capture.outcomes, null, 2)),
    ];
    for (const write of writes) try { write(); }
    catch (error) { capture.faults.push(error); console.error('Failure evidence worker-exit capture fault', error, 'original errors', info.errors); }
  };
  process.once('exit', exiting);
  let attempted = false;
  try {
    await withFixtureCleanup(use, stages, async failures => {
      const faults: unknown[] = [];
      try { await record(failures); } catch (error) { faults.push(error); }
      if (failures.length || info.status !== info.expectedStatus) {
        try { writeFileSync(info.outputPath('runtime-cleanup.json'), JSON.stringify({ originalTestErrors: info.errors,
          failures: failures.map(each => ({ stage: each.stage, error: failureJson(each.error) })) }, null, 2)); }
        catch (error) { faults.push(error); }
        if (!attempted) {
          attempted = true;
          try { await captureFailure(undefined, runtime, info, false); } catch (error) { faults.push(error); }
        }
      }
      if (faults.length) throw new AggregateError(faults, 'Runtime cleanup evidence incomplete');
    });
  } finally { process.removeListener('exit', exiting); }
}

export function captureFailure(page: Page | undefined, runtime: Runtime, info: TestInfo, screenshots = true) {
  const capture = captureFor(runtime, info);
  capture.promise ??= Promise.resolve().then(() => captureFull(page, runtime, info, screenshots, capture));
  return capture.promise;
}

async function captureFull(page: Page | undefined, runtime: Runtime, info: TestInfo, screenshots: boolean, capture: Capture) {
  const { outcomes, faults, timing } = capture;
  let database: [string, unknown[]][] | undefined;
  const attach = async (name: string, body: string | Buffer, contentType = 'application/json') => {
    const path = info.outputPath(`${name}.${contentType === 'image/png' ? 'png' : 'json'}`);
    writeFileSync(path, body);
    await info.attach(name, { path, contentType });
  };
  // Record each result even when another capture operation or an attachment fails.
  const record = async (name: string, operation: (outcome: Outcome) => Promise<void>) => {
    const outcome: Outcome = { name, begin: new Date().toISOString() };
    outcomes.push(outcome);
    try { await operation(outcome); outcome.status = 'fulfilled'; }
    catch (error) { outcome.status = 'rejected'; outcome.reason = String(error); faults.push(error); }
    finally { outcome.end ??= new Date().toISOString(); }
  };
  // Preserve live DB/WAL/SHM and Run/config bytes before backup or diagnostic GETs.
  // These sequential copies are evidence, not one atomic database snapshot.
  const raw = captureRaw(runtime, info); timing.raw = raw.outcomes; faults.push(...raw.faults);
  await Promise.all([
    ...(screenshots && page ? [record('screen', async () => { await attach('failure-screen', await page.screenshot({ timeout: 5000 }), 'image/png'); })] : []),
    record('api', async () => {
      const results = await Promise.allSettled(['workspace/live', 'host/status'].map(async path => {
        const outcome: (typeof timing.apis)[number] = { name: path, begin: new Date().toISOString() };
        timing.apis.push(outcome);
        try {
          const response = await fetch(`${runtime.origin}/api/${path}`, { signal: AbortSignal.timeout(5000) });
          outcome.statusCode = response.status;
          await attach(path === 'workspace/live' ? 'failure-api' : 'failure-host',
            JSON.stringify({ status: response.status, body: await response.json() }));
          if (!response.ok) throw new Error(`Failure API ${path} returned ${response.status}`);
          outcome.status = 'fulfilled';
        } catch (error) { outcome.status = 'rejected'; outcome.reason = String(error); throw error; }
        finally { outcome.end = new Date().toISOString(); }
      }));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Failure API capture incomplete');
    }),
    (async () => {
      await record('database', async outcome => {
        timing.backup = outcome;
        const snapshot = info.outputPath('runtime-control.sqlite');
        const work = info.outputPath('database-work'); mkdirSync(work, { recursive: true });
        const copied = join(work, 'control.sqlite'), source = controlDatabasePath(info.outputPath('runtime-raw'));
        for (const suffix of ['', '-wal', '-shm']) if (existsSync(source + suffix)) cpSync(source + suffix, copied + suffix);
        const db = new DatabaseSync(copied);
        try { await backup(db, snapshot); } finally { db.close(); }
        // This timestamp marks the actual DB backup, before inspection/attachment and FS copy.
        outcome.end = new Date().toISOString();
        const captured = new DatabaseSync(snapshot, { readOnly: true });
        try {
          timing.attempts = captured.prepare('SELECT run_no, attempt_id, next_seq, acked_seq, last_digest, completed_digest FROM run_attempts ORDER BY run_no').all();
          database = captured.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
            .map(row => [String(row.name), captured.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all()]);
        } finally { captured.close(); }
        await info.attach('runtime-control', { path: snapshot, contentType: 'application/vnd.sqlite3' });
      });
      // Copy even if the DB backup failed. Its manifest retains per-file copy faults.
      await record('workspace', async outcome => {
        timing.runsCopy = outcome;
        const copied = info.outputPath('failure-workspace');
        const manifest = preserveFailureWorkspace(runtime.root, copied);
        outcome.end = new Date().toISOString();
        timing.files = manifest.files.filter(file => file.path.startsWith('.alpacawork/runs/') && (file.sha256 || file.link || file.error))
          .map(file => file.path).sort();
        const files = manifest.files.map(({ path, size, mode, links, error }) => ({ path, size, mode, links, error }));
        await attach('failure-fs', JSON.stringify({ root: runtime.root, files,
          config: readFileSync(join(copied, 'config.yaml'), 'utf8'), database }));
        const errors = manifest.files.filter(file => file.error);
        if (errors.length) throw new Error(`Workspace copy faults: ${JSON.stringify(errors)}`);
      });
    })(),
  ]);
  // Both manifests are attempted independently; attachment failure remains a teardown fault.
  const captured = outcomes.map(outcome => ({ ...outcome }));
  await Promise.all([
    record('runtime-manifest', async () => { await attach('runtime-capture', JSON.stringify({ ...timing,
      root: runtime.root, origin: runtime.origin, testId: info.testId,
      status: info.status, expectedStatus: info.expectedStatus, errors: info.errors, complete: true,
      consistency: { raw: 'sequential live copies before backup/APIs, not atomic',
        backup: 'SQLite backup of a disposable raw copy; raw live copies are sequential', workspace: 'later live copy, not atomic with raw/backup/APIs',
        apis: 'separate live HTTP observations, not atomic with files or each other' },
      runsCopyPath: 'failure-workspace/.alpacawork/runs', outcomes: captured }, null, 2)); }),
    record('capture-manifest', async () => { await attach('failure-capture', JSON.stringify(captured, null, 2)); }),
  ]);
  capture.complete = true;
  if (faults.length) throw new AggregateError(faults, 'Failure evidence capture incomplete; original test failure is retained');
}
