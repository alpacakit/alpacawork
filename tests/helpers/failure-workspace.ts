/** Preserve the failing test's own files before its existing teardown removes them. */
import { copyFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync, readlinkSync, symlinkSync, writeFileSync, lstatSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';

export function preserveFailureWorkspace(root: string, destination: string) {
  const files: { path: string; size?: number; mode?: number; links?: number; sha256?: string; link?: string; error?: string }[] = [];
  const visit = (source: string, target: string) => {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
      const from = join(source, name), to = join(target, name), path = relative(root, from);
      const evidence: (typeof files)[number] = { path };
      files.push(evidence);
      try {
        const stat = lstatSync(from);
        // These are facts about the source at copy time, not the new copy's inode/link count.
        Object.assign(evidence, { size: stat.size, mode: stat.mode, links: stat.nlink });
        if (stat.isSymbolicLink()) {
          const link = readlinkSync(from); evidence.link = link; symlinkSync(link, to);
        } else if (stat.isDirectory()) visit(from, to);
        else if (stat.isFile()) {
          copyFileSync(from, to);
          evidence.sha256 = createHash('sha256').update(readFileSync(to)).digest('hex');
        }
      } catch (error) { evidence.error = String(error); }
    }
  };
  visit(root, destination);
  // Live DB/WAL/SHM bytes are evidence, not a claim of one atomic SQLite snapshot.
  const result = { root, destination, capturedAt: new Date().toISOString(), files };
  writeFileSync(join(destination, 'capture-manifest.json'), JSON.stringify(result, null, 2));
  return result;
}

/** Keep the subject before its registered teardown runs; successful cases incur no filesystem capture. */
import { test as nodeTest, type TestContext } from 'node:test';

const preserved = new WeakMap<TestContext, Set<string>>();

/** Node fixtures call this inside their cleanup hook, before closing stores, servers or process groups.
 * Raw bytes are never opened with SQLite. Backup/inspection only touches disposable copies. */
export async function preserveTestFailure(t: TestContext, root: string,
  options: { origin?: string; databaseRoot?: string; diagnostics?: () => unknown; failure?: { error: unknown } } = {}) {
  // Public Node 24.16 context properties; this repo's older @types/node predates them.
  const context = t as TestContext & { readonly passed: boolean; readonly error: Error | null };
  // A caller that closes HTTP in finally knows its failure before Node finalizes the context.
  // Its explicit error owns that early observation; the fixture's later hook must not capture it twice.
  if ((!options.failure && context.passed) || preserved.get(t)?.has(root)) return;
  const originalError = options.failure ? options.failure.error : context.error;
  const selected = process.env.ALPACAWORK_FAILURE_EVIDENCE_DIR
    ?? (process.env.ALPACAWORK_E2E_GUARD_LOG?.replace(/\.jsonl$/, '-failures'))
    ?? resolve('.local/test-failures');
  mkdirSync(selected, { recursive: true });
  const destination = mkdtempSync(join(selected, `${createHash('sha256').update(t.fullName).digest('hex').slice(0, 16)}-`));
  const faults: unknown[] = [];
  const outcomes: { name: string; begin: string; end?: string; error?: unknown }[] = [];
  const manifest = {
    test: t.fullName, root, destination, originalError,
    contextAtCapture: { passed: context.passed, error: context.error },
    consistency: 'raw sequential live copy first; backup from a disposable copy; APIs are separate live observations',
    api: options.origin ? { state: 'started', origin: options.origin }
      : { state: 'not_started', reason: 'HTTP server not started; live/host API not applicable' },
    outcomes,
  };
  const json = (value: unknown) => JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return String(item);
    if (item instanceof Map) return Object.fromEntries(item);
    if (item instanceof Set) return [...item];
    if (item instanceof Error) return { ...item, name: item.name, message: item.message, stack: item.stack,
      cause: item.cause, ...(item instanceof AggregateError ? { errors: item.errors } : {}) };
    return item;
  }, 2);
  const record = async (name: string, operation: () => unknown | Promise<unknown>) => {
    const outcome: (typeof outcomes)[number] = { name, begin: new Date().toISOString() };
    outcomes.push(outcome);
    try { await operation(); }
    catch (error) { outcome.error = error; faults.push(error); }
    finally { outcome.end = new Date().toISOString(); }
  };
  const raw = join(destination, 'runtime-raw');
  await record('raw', () => {
    const captured = preserveFailureWorkspace(root, raw);
    const errors = captured.files.filter(file => file.error);
    if (errors.length) throw new Error(`Workspace copy faults: ${json(errors)}`);
  });
  await record('database', async () => {
    const work = join(destination, 'database-work');
    mkdirSync(work, { recursive: true });
    const source = controlDatabasePath(join(raw, relative(root, options.databaseRoot ?? root))), copied = join(work, 'control.sqlite');
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(source + suffix)) copyFileSync(source + suffix, copied + suffix);
      else if (!suffix) throw new Error(`Failure database missing: ${source}`);
    }
    const db = new DatabaseSync(copied);
    const snapshot = join(destination, 'control-backup.sqlite');
    try { await backup(db, snapshot); } finally { db.close(); }
    const captured = new DatabaseSync(snapshot, { readOnly: true });
    try {
      const integrity = captured.prepare('PRAGMA integrity_check').all();
      writeFileSync(join(destination, 'database-integrity.json'), json(integrity));
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
        throw new Error(`Failure backup integrity: ${json(integrity)}`);
    } finally { captured.close(); }
  });
  await record('diagnostics', async () => {
    writeFileSync(join(destination, 'diagnostics.json'), json(await options.diagnostics?.() ?? null));
  });
  if (options.origin) for (const path of ['workspace/live', 'host/status']) {
    await record(path, async () => {
      const response = await fetch(new URL(`/api/${path}`, options.origin), { signal: AbortSignal.timeout(5000) });
      writeFileSync(join(destination, path === 'workspace/live' ? 'live.json' : 'host.json'),
        json({ status: response.status, body: await response.json() }));
      if (!response.ok) throw new Error(`Failure API ${path} returned ${response.status}`);
    });
  }
  writeFileSync(join(destination, 'failure.json'), json(manifest));
  const roots = preserved.get(t) ?? new Set<string>();
  roots.add(root); preserved.set(t, roots);
  t.diagnostic(`Failure evidence: ${destination}`);
  if (faults.length) {
    // Node may display only the body error when an after hook also fails.
    t.diagnostic(`Failure evidence capture faults (original failure retained): ${json(faults)}`);
    throw new AggregateError([originalError, ...faults],
      'Failure evidence capture incomplete; original test failure retained');
  }
}

const subjects=new WeakMap<TestContext,Set<string>>();
export function rememberEvidenceWorkspace(t:TestContext,root:string) {
  const known=subjects.get(t)??new Set<string>();known.add(root);subjects.set(t,known);
}
export function evidenceTest(name:string,run:(t:TestContext)=>void|Promise<void>) {
  return nodeTest(name,async t=>{
    try {await run(t);}catch(error){
      const selected=process.env.ALPACAWORK_E2E_GUARD_LOG;
      if(selected)for(const [index,root] of [...(subjects.get(t)??[])].entries()) {
        const folder=selected.replace(/\.jsonl$/,'-failures')+'/'+createHash('sha256').update(name).digest('hex').slice(0,16)+'-'+index;
        try {preserveFailureWorkspace(root,folder);}
        catch(cause){mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'capture-error.txt'),String(cause));}
      }
      throw error;
    }
  });
}
