import { stringify } from 'yaml';
import { runRecordSchema } from '@alpacawork/contract/run';
import { fixtureAgentSetting, inertFixtureLaunch } from '../../tests/helpers/agent-stub.ts';
/** Development-only synthetic workspaces. No production workspace is ever an input. */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { holdControlWriter, openControlDatabase, taskHash } from '@alpacawork/db';
import { record } from '../../tests/runs-fixtures.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const marker = '.dev-fixture.json';
const fixedTime = '2026-09-25T00:00:00.000Z';
const placeholder = '/synthetic-fixture-workspace';
export const profiles = { small: { tasks: 14, logs: 19, runs: 7 }, perf: { tasks: 290, logs: 14798, runs: 5792 } };
export type Counts = { tasks: number; logs: number; runs: number };
type Spec = Counts & { seed: string };
type Manifest = { format: 1; kind: 'original' | 'copy'; key: string; spec: Spec; sourceHash: string;
  files: Record<string, string>; counts: Counts; bytes: number; generationMs: number };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

function validate(spec: Spec) {
  for (const [name, value] of Object.entries(spec)) {
    if (name === 'seed') continue;
    if (!Number.isSafeInteger(value) || Number(value) < (name === 'tasks' ? 2 : 0)) throw Error(`Invalid ${name}: ${value}`);
  }
  if (spec.logs < spec.tasks) throw Error('logs must include at least one creation per Task (project included)');
  if (!spec.seed || spec.seed.length > 128) throw Error('seed must contain 1–128 characters');
}

/** The fixture cleanup/copy contract accepts only the exact physical root named in its marker. */
function realDirectory(path: string) {
  const absolute = resolve(path);
  if (realpathSync(absolute) !== absolute || !lstatSync(absolute).isDirectory()) throw Error('Fixture requires its real directory path');
}
function filesIn(root: string, relative = ''): string[] {
  return readdirSync(join(root, relative)).sort().flatMap(name => {
    const path = join(relative, name), info = lstatSync(join(root, path));
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw Error(`Linked or special file: ${path}`);
    return info.isDirectory() ? filesIn(root, path) : [path];
  });
}
function sourceHash() {
  const paths = ['scripts/dev-fixtures/fixture.ts', 'tests/runs-fixtures.ts', 'tests/helpers/agent-stub.ts'];
  // Fingerprint the current schema and its contracts, not just a schema version number.
  for (const area of ['db', 'contract', 'core']) for (const path of filesIn(join(repo, 'packages', area, 'src')))
    paths.push(join('packages', area, 'src', path));
  return hash(paths.sort().map(path => path + '\0' + hash(readFileSync(join(repo, path)))).join('\n'));
}
function summary(root: string) {
  const paths = filesIn(root).filter(path => path !== marker);
  return { files: Object.fromEntries(paths.map(path => [path, hash(readFileSync(join(root, path)))])),
    bytes: paths.reduce((sum, path) => sum + statSync(join(root, path)).size, 0) };
}
function count(db: DatabaseSync): Counts {
  const n = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  return { tasks: n('tasks'), logs: n('task_log'), runs: n('runs') };
}
function checkDatabase(db: DatabaseSync, expected: Counts) {
  const actual = count(db);
  if (Object.keys(actual).some(key => actual[key as keyof Counts] !== expected[key as keyof Counts])) throw Error('Fixture counts differ');
  if (db.prepare('PRAGMA foreign_key_check').all().length || db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') throw Error('Invalid fixture database');
  if (db.prepare(`SELECT id FROM runs WHERE state NOT IN ('succeeded','failed','stopped') OR
    json_extract(record,'$.launch.argv') <> '["/usr/bin/false"]' OR json_extract(record,'$.launch.path') <> '/usr/bin:/bin'`).all().length)
    throw Error('Fixture contains executable or unfinished Runs');
}

/** Stable IDs, fixed clock and synthetic text; every request belongs to an ended inert Run. */
function generate(root: string, spec: Spec) {
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 }, false, true);
  try {
    db.exec('BEGIN IMMEDIATE');
    const id = (n: number) => `fixture-${hash(spec.seed + ':' + n).slice(0, 24)}`;
    const task = db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`);
    // Each Task's values, a row per field as `task update --values-file` stores them (task_values).
    const value = db.prepare('INSERT INTO task_values(task_id,field_id,value) VALUES(?,?,?)');
    db.prepare('INSERT INTO agents(id,created_at) VALUES(?,?)').run('fixture-agent', fixedTime);
    const placement = db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at) VALUES(?,?,'fixture-agent','fixture',1,1,?)`);
    const states = ['todo', 'doing', 'waiting', 'done', 'stopped'];
    for (let n = 1; n <= spec.tasks; n++) {
      const project = n === 1;
      const parent = n <= 3 ? 1 : Math.floor(n / 2);
      const state = project ? 'todo' : states[(n - 2) % states.length]!;
      const notes = 'Fictional measurement data. No production content.\n'.repeat(n % 17 === 0 ? 400 : 4).trim();
      task.run(id(n), project ? 'project' : 'task', n, project ? null : id(parent), project ? null : id(1),
        project ? 'Synthetic development project' : `Synthetic task ${n}`,
        n > 10 && n % 19 === 0 ? 'archived' : 'active', state, !project && n % 13 === 0 ? 1 : 0,
        !project && (state === 'waiting' || n === 2) ? 1 : 0, project ? json({ color: '#39659b' }) : null, fixedTime, fixedTime);
      // A project's own value is its policy, free text written as the user likes.
      const values: Record<string, unknown> = project ? {
        project_policy: 'Goal: ship the synthetic app in a shape its users can work with unaided.\n\n' +
          '- Tests guard only what users would miss if it broke\n- The agent decides and goes on; it asks only what it must\n' +
          `- Nothing leaves this PC without approval\n\n${notes}`,
      } : {
        goal: `Finish synthetic task ${n} and say what changed`,
        policy: ['Measure first, then change one thing at a time'],
        ...state === 'done' ? { conclusion: `Synthetic task ${n} is done; the fictional numbers met the target.` } : {},
        remaining: state === 'done' ? [] : [`Check the result of synthetic task ${n} — the owner`],
        conditions: [`The fictional measurement passes — ${state === 'done' ? 'met' : 'unchecked'}`],
        notes,
      };
      for (const [field, entry] of Object.entries(values))
        if (!Array.isArray(entry) || entry.length) value.run(id(n), field, JSON.stringify(entry));
      if (!project) placement.run(`fixture-placement-${n}`, `T${n}`, fixedTime);
    }
    db.prepare('INSERT INTO wait_cycles(id,task_id,opened_at) VALUES(?,?,?)').run('fixture-cycle', 'T2', fixedTime);
    const request = db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state,wait_cycle_id)
      VALUES(?,?,?,1,?,'new',?,'instruction',?,?,'queued',?)`);
    const run = db.prepare('INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,?,?,\'present\')');
    const returned = db.prepare('INSERT INTO returns(id,request_id,to_task_id,outcome,boundary_run_id,created_at) VALUES(?,?,?,?,?,?)');
    for (let n = 1; n <= spec.runs; n++) {
      const target = 2 + (n - 1) % (spec.tasks - 1), taskId = `T${target}`, requestId = `fixture-request-${n}`;
      const prompt = `Synthetic instruction ${n}.\n` + 'Fictional work item.\n'.repeat(n % 31 === 0 ? 200 : 12);
      const result = `Synthetic result ${n}.\n` + 'Fictional review result.\n'.repeat(n % 37 === 0 ? 200 : 12);
      request.run(requestId, taskId, `fixture-placement-${target}`, taskHash(id(target), 1), prompt,
        n === 1 ? '{"kind":"human"}' : '{"kind":"placement","placementId":"fixture-placement-2"}', fixedTime, n === 1 ? null : 'fixture-cycle');
      run.run(n, JSON.stringify(runRecordSchema.parse(record(`R${n}`, { task: taskId, placementId: `fixture-placement-${target}`, requestId,
        agent: 'fixture', role: 'owner', caller: n === 1 ? null : { run: 'R1' }, cwd: placeholder, state: 'succeeded', created_at: fixedTime, started_at: fixedTime, ended_at: fixedTime,
        exit: { code: 0, signal: null }, launch: inertFixtureLaunch('codex') }))), prompt, result);
      // Leave a subset of closures absent to exercise the returns read path.
      if (n > 1 && n % 4 !== 0) returned.run(`fixture-return-${n}`, requestId, 'T2', 'succeeded', `R${n}`, fixedTime);
    }
    const log = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,?,?)');
    const ordinals = new Map<number, number>();
    for (let n = 0; n < spec.logs; n++) {
      // A dense lane crosses pagination boundaries; remaining lanes share the rest.
      const target = n < spec.tasks ? n + 1 : n % 3 === 0 ? 2 : 2 + n % (spec.tasks - 1);
      const ordinal = ordinals.get(target) ?? 0, logId = `fixture-log-${n}`;
      const entry = { id: logId, kind: ordinal === 0 ? 'created' : 'reported',
        at: new Date(Date.parse(fixedTime) + Math.floor(n / 2) * 1000).toISOString(),
        title: ordinal === 0 ? 'Synthetic task created' : `Synthetic observation ${n}`,
        description: 'Fictional history.\n'.repeat(n % 29 === 0 ? 50 : 40), actor: { kind: 'human' },
        fromState: null, toState: ordinal === 0 ? 'todo' : null, ...(ordinal === 0 ? { userRequested: target !== 1 && (states[(target - 2) % 5] === 'waiting' || target === 2) } : {}) };
      log.run(logId, id(target), ordinal, JSON.stringify(entry)); ordinals.set(target, ordinal + 1);
    }
    db.prepare('UPDATE task_sequence SET next_number=?').run(spec.tasks + 1);
    db.prepare('UPDATE run_sequence SET next_number=?').run(spec.runs + 1);
    checkDatabase(db, spec);
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode=DELETE');
  } finally { db.close(); }
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { fixture: { ...fixtureAgentSetting('codex'), enabled: false } } }));
  // Lock files are runtime resources, not part of the shared closed database.
  for (const path of filesIn(root)) if (path.endsWith('.lock')) rmSync(join(root, path));
}

function manifest(root: string): Manifest {
  realDirectory(root);
  const value = JSON.parse(readFileSync(join(root, marker), 'utf8')) as Manifest;
  if (value.format !== 1 || !['original', 'copy'].includes(value.kind) || !/^[0-9a-f]{64}$/.test(value.key)) throw Error('Not a development fixture');
  return value;
}
function verifyOriginal(root: string) {
  const value = manifest(root);
  if (value.kind !== 'original' || JSON.stringify(summary(root).files) !== JSON.stringify(value.files)) throw Error('Original has changed; regenerate after removing this exact cache entry');
  return value;
}
function permissions(root: string, writable: boolean) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry), info = lstatSync(path);
    if (info.isDirectory()) { chmodSync(path, 0o700); permissions(path, writable); }
    else chmodSync(path, writable ? 0o600 : 0o400);
  }
  chmodSync(root, writable ? 0o700 : 0o500);
}

export function createOriginal(spec: Spec, cache = join(homedir(), '.cache', 'alpacawork-fixtures')) {
  validate(spec);
  cache = resolve(cache); mkdirSync(cache, { recursive: true, mode: 0o700 }); realDirectory(cache);
  const source = sourceHash(), key = hash(json({ format: 1, source, spec })), root = join(cache, key);
  if (existsSync(root)) return { root, reused: true, ...verifyOriginal(root) };
  const temporary = mkdtempSync(join(cache, '.building-')), started = performance.now();
  try {
    generate(temporary, spec);
    const value: Manifest = { format: 1, kind: 'original', key, spec, sourceHash: source, ...summary(temporary), counts: { tasks: spec.tasks, logs: spec.logs, runs: spec.runs }, generationMs: performance.now() - started };
    writeFileSync(join(temporary, marker), json(value));
    permissions(temporary, false);
    try { renameSync(temporary, root); }
    catch (error) {
      if (!existsSync(root)) throw error;
      const winner = verifyOriginal(root);
      return { root, reused: true, ...winner };
    }
    return { root, reused: false, ...value };
  } finally {
    if (existsSync(temporary)) { permissions(temporary, true); rmSync(temporary, { recursive: true }); }
  }
}

export function copyWorkspace(source: string, destination: string) {
  source = resolve(source); destination = resolve(destination);
  const value = verifyOriginal(source), started = performance.now();
  realDirectory(dirname(destination));
  if (destination === source || destination.startsWith(source + sep)) throw Error('Destination must be outside the original');
  // Exclusive mkdir refuses even an existing empty directory and all symlinks.
  mkdirSync(destination, { mode: 0o700 });
  try {
    for (const path of Object.keys(value.files)) {
      mkdirSync(dirname(join(destination, path)), { recursive: true, mode: 0o700 });
      copyFileSync(join(source, path), join(destination, path), constants.COPYFILE_EXCL);
      chmodSync(join(destination, path), 0o600);
    }
    const db = openControlDatabase(destination, { busyTimeoutMs: 1000 });
    try {
      db.prepare(`UPDATE runs SET record=json_set(record,'$.cwd',?)`).run(destination);
      db.prepare('UPDATE workspace_identity SET id=?').run(randomUUID());
      checkDatabase(db, value.counts);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('PRAGMA journal_mode=DELETE');
    } finally { db.close(); }
    writeFileSync(join(destination, marker), json({ ...value, kind: 'copy' }));
    return { root: destination, key: value.key, counts: value.counts, ...summary(destination), copyMs: performance.now() - started };
  } catch (error) { rmSync(destination, { recursive: true }); throw error; }
}

/** Only remove the exact marked fixture requested by the caller; no cache-wide purge. Stop servers first. */
export function removeWorkspace(root: string) {
  root = resolve(root); const value = manifest(root); filesIn(root);
  if (root === resolve(homedir()) || basename(root) === '.cache') throw Error('Refusing broad removal');
  // Copies may be served; the product's existing writer lease refuses deletion while serve owns one.
  const release = value.kind === 'copy' ? holdControlWriter(root) : () => {};
  try { permissions(root, true); rmSync(root, { recursive: true }); } finally { release(); }
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === '--help') {
    console.log('node scripts/dev-fixtures/fixture.ts create [--profile small|perf] [--tasks N --logs N --runs N --seed TEXT --cache PATH]\nnode scripts/dev-fixtures/fixture.ts copy --source ORIGINAL --dest NEW_ROOT\nnode scripts/dev-fixtures/fixture.ts remove --root EXACT_ROOT'); return;
  }
  const allowed: Record<string, string[]> = { create: ['profile', 'tasks', 'logs', 'runs', 'seed', 'cache'], copy: ['source', 'dest'], remove: ['root'] };
  const parsed = parseArgs({ args, options: Object.fromEntries(Object.values(allowed).flat().map(name => [name, { type: 'string' as const }])) }).values;
  if (!allowed[command] || Object.keys(parsed).some(name => !allowed[command]!.includes(name))) throw Error('Unknown command or option for this command');
  if (command === 'create') {
    const profile = parsed.profile ?? 'small';
    if (!Object.hasOwn(profiles, profile)) throw Error('profile must be small or perf');
    const defaults = profiles[profile as keyof typeof profiles];
    const spec = { tasks: parsed.tasks === undefined ? defaults.tasks : Number(parsed.tasks), logs: parsed.logs === undefined ? defaults.logs : Number(parsed.logs), runs: parsed.runs === undefined ? defaults.runs : Number(parsed.runs), seed: parsed.seed ?? 'synthetic-v1' };
    console.log(json(createOriginal(spec, parsed.cache)));
  } else if (command === 'copy' && parsed.source && parsed.dest) console.log(json(copyWorkspace(parsed.source, parsed.dest)));
  else if (command === 'remove' && parsed.root) { removeWorkspace(parsed.root); console.log(json({ removed: resolve(parsed.root) })); }
  else throw Error('Missing required options; use --help');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
