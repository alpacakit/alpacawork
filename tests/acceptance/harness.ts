/** Isolated roots, real entries, fake agents, and bounded group cleanup. */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { grantFixtureRequest, initializeControlFixture } from '../helpers/control-fixture.ts';
import { commandFetch } from '../helpers/command-fetch.ts';
import { stringify } from 'yaml';
import { tryLock } from '@alpacawork/core';
import { RunStore, type CreateRunFields } from '@alpacawork/runs';
import { runRecordSchema, type RunRecord } from '@alpacawork/contract/run';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { preserveTestFailure } from '../helpers/failure-workspace.ts';
import { assignedSession, launchSnapshot, readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { AGENT_ADAPTERS } from '@alpacawork/contract/agent-adapters';
import { fixtureAgentSetting } from '../helpers/agent-stub.ts';
import { syntheticStatusApp } from '../helpers/agent-inspection.ts';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { planInputs,publishCommands } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { settle } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { openRunFile } from '@alpacawork/backend/test-dist/runs/files.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';

const backend = resolve('apps/backend/dist/backend.js');
export const cliEntry = resolve('apps/cli/dist/cli.js');
export const fake = resolve('tests/fixtures/fake-run-agent.mjs');
const reporter = resolve('tests/acceptance/reporter-agent.mjs');
export const driver = resolve('tests/acceptance/driver.ts');
export const now = () => new Date().toISOString();
const servers = new Map<string, Awaited<ReturnType<typeof startServer>>>();
const installationHomes = new Map<string, string>();
/** The test HTTP server of `root`, started on first use. */
async function serverOf(root: string) {
  const existing = servers.get(root); if (existing) return existing;
  const app = await startServer(root, 0); servers.set(root, app); return app;
}
/** The user's outside Codex conversation, where the coordinator speaks for the user: `cli`'s options for its commands. */
export const coordinator = { env: { CODEX_THREAD_ID: 'acceptance-coordinator' } };
export { cleanEnv, until, alive, killGroup, processes, cleanupGroups, receipts } from './processes.ts';
import { cleanEnv, until, killGroup, cleanupGroups, receipts } from './processes.ts';
export function execute(root: string, entry: string, args: string[], env: Record<string, string> = {}) {
  const started = performance.now();
  const child = spawn(process.execPath, [entry, ...args], { cwd: root, env: cleanEnv(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
  const timer = setTimeout(() => { if (child.pid) killGroup(child.pid); }, 120_000);
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; ms: number; body: any }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      let body: unknown;
      try { body = JSON.parse(code === 0 ? stdout : stderr); } catch { /* Crash drivers deliberately have no JSON response. */ }
      resolve({ code, signal, stdout, stderr, ms: performance.now() - started, body });
    });
  }).finally(() => clearTimeout(timer));
  return { child, done };
}
export function cli(root: string, command: string, input: Record<string, string> = {}, options: { env?: Record<string, string> } = {}) {
  return (async () => {
    const local = command === 'workspace init';
    const values = { ...input };
    if (!local && ['new', 'update', 'request', 'report', 'move', 'comment', 'set', 'returns', 'assign', 'release', 'stop'].includes(command.split(' ')[1]!) && !('op-id' in values))
      values['op-id'] = randomUUID();
    const home = installationHomes.get(root)!;
    const localBackend = local ? syntheticStatusApp(resolve('.'), join(home, 'status-app')) : backend;
    return execute(root, local ? localBackend : cliEntry,
      [...(local ? ['--workspace', root] : ['--server', (await serverOf(root)).url]), ...command.split(' '),
        ...Object.entries(values).flatMap(([k, v]) => v === '' ? [`--${k}`] : [`--${k}`, v])],
      local ? { HOME: installationHomes.get(root)!, XDG_CONFIG_HOME: join(installationHomes.get(root)!, '.config'), ...options.env } : options.env).done;
  })();
}
export async function http(url: string, command: string, input?: unknown) {
  const response = await commandFetch(new URL(`/api/${command}`, url), { method: input === undefined ? 'GET' : 'POST',
    headers: input === undefined ? {} : { 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: await response.json() };
}
/**
 * An isolated root. Initialized, it has the fixture's project below the root project T1 (`project`) and in it the
 * person's Task `task` with a responsible of `profile`: `fake`, or `reporter`, which reports through the CLI.
 */
export async function setup(t: TestContext, parallel = 8, initialize = true, profile: 'fake' | 'reporter' = 'fake') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-b8-')));
  const installationHome = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-b8-home-')));
  installationHomes.set(root, installationHome);
  const previousEnvironment = Object.fromEntries(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']
    .map(name => [name, process.env[name]]));
  const locks: number[] = [];
  let store: RunStore;
  const requests: { input: Parameters<RequestService['request']>[0]; context: Parameters<RequestService['request']>[1] }[] = [];
  let projection:ReturnType<typeof setInterval>|undefined,paused=false;
  t.after(async () => {
    clearInterval(projection);
    try {
      await preserveTestFailure(t, root, { origin: servers.get(root)?.url,
        diagnostics: async () => ({ requests, task: task && await new ControlTaskStore(root).get(task.id),
          snapshot: getStore().snapshot(project), processes: receipts(root) }) });
    } finally {
      const invocations = join(root, 'fake-invocations.jsonl');
      t.diagnostic(JSON.stringify({ kind: 'acceptance-fixture', root, home: installationHome,
        invocations: existsSync(invocations) ? readFileSync(invocations, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
        runs: store?.read().filter(run => run.pids.manager || run.pids.agent).map(run => ({
          id: run.id, state: run.state, pids: run.pids, launch: run.launch, session: run.session,
        })) ?? [] }));
      try { const app = servers.get(root); if (app) { await app.close(); servers.delete(root); } }
      finally {
        try { for (const fd of locks) closeSync(fd); await cleanupGroups(root); }
        finally {
          store?.close(); rmSync(root, { recursive: true, force: true });
          installationHomes.delete(root); rmSync(installationHome, { recursive: true, force: true });
          for (const [name, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
          }
        }
      }
    }
  });
  // Executables belong to the fixture's HOME: the workspace must stay empty
  // until the real CLI initializes it (setup(..., false)).
  const path = join(installationHome, 'acceptance-bin');
  mkdirSync(path, { mode: 0o700 });
  // Both built-in entry names are private Node scripts. No provider binary can
  // be found beyond this PATH; ps is the only host utility needed for cleanup.
  symlinkSync('/bin/ps', join(path, 'ps'));
  for (const [command, format] of [['claude', 'claude'], ['codex', 'codex'], ['alpacawork-agent', 'codex']]) {
    writeFileSync(join(path, command), `#!${process.execPath}\n` +
      `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';\n` +
      `const args=process.argv.slice(2);\n` +
      `if(args.includes('--version')) { console.log('synthetic 1'); process.exit(0); }\n` +
      `if(args.join(' ')==='auth status'||args.join(' ')==='login status') process.exit(0);\n` +
      `appendFileSync(${JSON.stringify(join(root, 'fake-invocations.jsonl'))},JSON.stringify({pid:process.pid,ppid:process.ppid,argv:process.argv,path:process.env.PATH,home:process.env.HOME})+'\\n');\n` +
      `setTimeout(()=>process.kill(-process.pid,'SIGKILL'),120000).unref();\n` +
      (format === 'claude' ? `if(args.includes('--acceptance-reporter')) {\n` +
        `const {createInterface}=await import('node:readline');const lines=createInterface({input:process.stdin});\n` +
        `const input=await new Promise(done=>lines.once('line',line=>done(JSON.parse(line))));lines.close();\n` +
        `const prompt=input.message.content,session=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];\n` +
        `mkdirSync(${JSON.stringify(join(root, 'processes'))},{recursive:true});\n` +
        `writeFileSync(${JSON.stringify(join(root, 'processes'))}+'/'+process.pid+'.json',JSON.stringify({pid:process.pid,pgid:process.pid,branch:'agent',prompt,cwd:process.cwd()}));\n` +
        `process.stdout.write(JSON.stringify({type:'command_lifecycle',state:'started',command_uuid:input.uuid})+'\\n');\n` +
        `process.argv=[process.execPath,${JSON.stringify(reporter)},'--cli',${JSON.stringify(cliEntry)},'--session',session,'--prompt',prompt];\n` +
        `await import(${JSON.stringify(new URL(`file://${reporter}`).href)});\n` +
        `} else {\n` : '') +
      `process.argv=[process.execPath,${JSON.stringify(fake)},'--root',${JSON.stringify(root)},'--format',${JSON.stringify(format)},...args];\n` +
      `await import(${JSON.stringify(new URL(`file://${fake}`).href)});\n` +
      (format === 'claude' ? `}\n` : ''), { mode: 0o700 });
  }
  Object.assign(process.env, { PATH: path, HOME: installationHome, XDG_CONFIG_HOME: join(installationHome, '.config'),
    CLAUDE_CONFIG_DIR: join(installationHome, '.claude'), CODEX_HOME: join(installationHome, '.codex') });
  // Current settings and protocol ownership come from the product, not a second DSL.
  const config = { limits: { parallel, run_minutes: 0 }, agents: {
    fake: { ...fixtureAgentSetting('claude'), env: [] },
    plain: { ...fixtureAgentSetting('codex'), env: [] },
    reporter: { ...fixtureAgentSetting('claude', {
      start: AGENT_ADAPTERS.claude.options.start + ' --acceptance-reporter',
      resume: AGENT_ADAPTERS.claude.options.resume + ' --acceptance-reporter',
    }), env: [] },
  } };
  let project: string | undefined;
  let task: Awaited<ReturnType<ControlTaskCommands['create']>>['tasks'][number] | undefined;
  let placement: ReturnType<PlacementStore['place']> | undefined;
  if (initialize) {
    const writer = new FileWriter(root);
    try {
      writer.save('config.yaml', null, Buffer.from(stringify(config)));
      project = initializeControlFixture(root);
      // Control initialization installs inert defaults in agent-bin. Admission
      // must instead capture this harness's separate, executable protocol fakes.
      process.env.PATH = path;
    }
    finally { writer.close(); }
    task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: null, tasks: [{ title: 'Acceptance' }] })).tasks[0];
    const people = new PlacementStore(root);
    try { placement = people.place({ taskId: task.id, agentId: people.createAgent('Acceptance agent').id,
      profileKey: profile, responsible: true }); }
    finally { people.close(); }
  }
  const getStore = () => {paused=false;return store ??= new RunStore(root, { busyTimeoutMs: 1000 })};
  const closeStore=()=>{paused=true;store?.close();store=undefined!};
  const records = () => getStore().read();
  /** Direct RunStore fixture for scheduler/manager fault cases, not an admission path. */
  function seed(extra: Partial<CreateRunFields> = {}, state: 'queued' | 'running' | 'succeeded' = 'queued', plan: object = {}) {
    const settings = readAgentsSettings(root); if (!settings.ok) throw settings.error;
    const agent = extra.agent ?? 'fake';
    const previous = extra.resumes ? getStore().get(extra.resumes) : null;
    const snapshot = launchSnapshot(settings.config, agent, extra.resumes ? 'resume' : 'start', path, {}, previous?.launch);
    if (!snapshot.ok) throw new Error(snapshot.code);
    return getStore().write(tx => {
      const requestId = extra.requestId ?? randomUUID();
      if (!extra.requestId) {
        tx.insertRequest({ id: requestId, taskId: task?.id ?? 'T1',
          placementId: extra.placementId ?? placement?.id ?? 'Pfixture', placementRevision: 1,
          taskHash: task?.hash ?? '0'.repeat(64), waitCycleId: null, headRunId: extra.resumes ?? null,
          mode: extra.resumes ? 'continue' : 'new', body: 'Fault fixture', purpose: 'instruction',
          author: { kind: 'human' }, submittedAt: now(), deliveryState: 'queued' });
        grantFixtureRequest(getStore(), tx, requestId);
      }
      let run = tx.create({ requestId, task: task?.id ?? 'T1', placementId: placement?.id ?? 'Pfixture',
        agent, role: 'owner', caller: null, session: previous?.session ?? assignedSession(snapshot.launch, agent),
        continues: false, resumes: null, cwd: root, launch: snapshot.launch, ...extra }, JSON.stringify(plan));
      if (state !== 'queued') {
        run = { ...run, state: 'running', started_at: now() }; tx.update(run);
        if (state === 'succeeded') { run = { ...run, state, ended_at: now(), exit: { code: 0, signal: null } }; tx.finish(run, { state: 'present', text: 'fixture reply' }); }
        else {
          mkdirSync(getStore().folder(run.id), { recursive: true });
          const fd = openRunFile(getStore().folder(run.id), 'manager.lock', constants.O_RDWR | constants.O_CREAT);
          assert.equal(tryLock(fd), true); locks.push(fd);
        }
      }
      return run;
    });
  }
  const tick = async () => {
    const s = new RunStore(root, { busyTimeoutMs: 10_000 });
    try { return await settle(s); } finally { s.close(); }
  };
  const waitState = (id: string, state: RunRecord['state'], timeout = 60_000) => until(() => {
    const r = getStore().get(id); return r?.state === state && r;
  }, `${id} becomes ${state}`, timeout);
  const ready = (id: string) => until(() => {
    const r = getStore().get(id); return r?.pids.agent && receipts(root).some(p => p.pid === r.pids.agent) && r;
  }, `${id} agent receipt`);
  const gate = (name: string) => join(root, name);
  const release = (name: string) => writeFileSync(gate(name), 'go');
  const continuations = (parent: RunRecord) => records().filter(r => r.resumes !== null && r.caller?.run === parent.id && r.role === parent.role);
  const server = () => serverOf(root);
  function sql(callback: (db: DatabaseSync) => void) {
    const db = new DatabaseSync(controlDatabasePath(root)); db.exec('PRAGMA busy_timeout=10000');
    try { callback(db); } finally { db.close(); }
  }
  function integrity() {
    records().forEach(r => runRecordSchema.parse(r));
    sql(db => assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok'));
  }
  function oncePerRun() {
    for (const run of records()) {
      const prompt = getStore().getText(run.id)!.prompt;
      assert.ok(receipts(root).filter(r => r.branch === 'agent' && r.prompt === prompt).length <= 1, `${run.id} launched more than once`);
    }
  }
  projection=setInterval(()=>{if(paused||!store)return;try{const imported=new RunEventImporter(store).pass();planInputs(store);publishCommands(store);if(imported.some(id=>['succeeded','failed','cancelled'].includes(store.get(id)?.state??'')))void tick().catch(error=>{if(error.code!=='busy')throw error})}catch(error){if(!['busy','runs_unavailable'].includes((error as {code:string}).code))throw error}},100);
  return { root, config, project, task, placement, closeStore, getStore, records, seed, tick, waitState, ready, gate, release,
    continuations, server, sql, integrity, oncePerRun,
    currentTask: () => new ControlTaskStore(root).get(task!.id),
    request: (input: Parameters<RequestService['request']>[0], context: Parameters<RequestService['request']>[1]
      = { purpose: 'instruction', actor: { kind: 'human' } }) => {
      requests.push({ input: structuredClone(input), context });
      return new RequestService(root).request(input, context);
    } };
}
export type Harness = Awaited<ReturnType<typeof setup>>;
