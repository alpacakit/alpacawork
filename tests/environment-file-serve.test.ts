/**
 * The environment file through the real `serve` process, started as the installed service starts it: a HOME and a
 * configuration directory of the test's own, and nothing exported for it. What the file sets must reach the server's
 * readers (an agent whose settings list the name, the usage reporting switch) and must be written nowhere.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { environmentFileSchema } from '@alpacawork/contract';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { RunStore } from '@alpacawork/runs';
import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { currentTaskHash, initializeControlFixture } from './helpers/control-fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { cleanupGroups } from './helpers/process-groups.ts';

const backend = resolve('apps/backend/dist/backend.js'), cli = resolve('apps/cli/dist/cli.js');
const fake = resolve('tests/fixtures/fake-run-agent.mjs');
const SECRET = 'file-secret-5f2c9a71', OTHER = 'other-secret-83b1d6e4';

async function until<T>(check: () => T | false | null | undefined, message: string, timeout = 30_000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (performance.now() >= deadline) throw new Error(`Deadline: ${message}`);
    await delay(50);
  }
}

/** A workspace with two Tasks, each with a responsible: `keyed` lists FILE_KEY in its settings, `plain` lists nothing. */
async function workspace(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-environment-serve-')));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-environment-home-')));
  const file = join(home, '.config', 'alpacawork', 'env');
  mkdirSync(join(home, '.config', 'alpacawork'), { recursive: true });
  const servers = new Set<ChildProcess>();
  t.after(async () => {
    for (const server of servers) if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await once(server, 'close'); }
    try { await cleanupGroups(root); }
    finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });
  // The fixture seeds the stores in this process and moves this process's PATH to its stubs; the server gets that PATH
  // as its own below, and this process gets its PATH back.
  const path = process.env.PATH;
  try {
    const writer = new FileWriter(root);
    try {
      writer.save('config.yaml', null, Buffer.from(stringify({ limits: { parallel: 4, run_minutes: 0 }, agents: {
        keyed: { ...fixtureAgentSetting('claude'), env: ['FILE_KEY'] }, plain: { ...fixtureAgentSetting('claude'), env: [] } } })));
    } finally { writer.close(); }
    const project = initializeControlFixture(root);
    const agentPath = installAgentStub(root, 'claude', [process.execPath, fake, '--root', root, '--format', 'claude']);
    const tasks = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: null,
      tasks: [{ title: 'Keyed' }, { title: 'Plain' }] })).tasks;
    const people = new PlacementStore(root);
    try {
      const placements = (['keyed', 'plain'] as const).map((profileKey, index) => people.place({ taskId: tasks[index]!.id,
        agentId: people.createAgent(profileKey).id, profileKey, responsible: true }));
      return { root, home, file, servers, agentPath, tasks, placements };
    } finally { people.close(); }
  } finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; }
}

/** The Runs of `root` as recorded now. */
function runs(root: string) {
  const store = RunStore.openReadable(root, { busyTimeoutMs: 1000 });
  if (!store) return [];
  try { return store.read(); } finally { store.close(); }
}

/** The environment a service gives: no key, no switch, only where things are. NODE_TEST_CONTEXT keeps reporting off. */
function serviceEnvironment(home: string, path: string): NodeJS.ProcessEnv {
  const env = cleanCliEnv({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: path });
  for (const name of ['ALPACAWORK_TELEMETRY_DISABLED', 'DO_NOT_TRACK', 'CI', 'FILE_KEY', 'OTHER_KEY']) delete env[name];
  assert.ok(env.NODE_TEST_CONTEXT, 'the server must know it runs under a test');
  return env;
}

async function serve(h: { root: string; servers: Set<ChildProcess> }, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [backend, '--workspace', h.root, 'workspace', 'serve', '--port', '0'], { env, cwd: h.root, stdio: ['ignore', 'pipe', 'pipe'] });
  h.servers.add(child);
  const output = { stdout: '', stderr: '' };
  child.stdout!.on('data', data => { output.stdout += data; });
  child.stderr!.on('data', data => { output.stderr += data; });
  const lines = createInterface({ input: child.stdout! });
  const [line] = await Promise.race([once(lines, 'line'), once(child, 'close').then(() => { throw new Error(`serve ended before listening: ${output.stderr}`); })]) as [string];
  const url = (JSON.parse(line) as { url: string }).url;
  const read = async (path: string) => {
    const response = await fetch(new URL(path, url)), text = await response.text();
    assert.equal(response.status, 200, `${path}: ${text}`);
    return { text, body: JSON.parse(text) };
  };
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'close'); } };
  return { url, output, read, stop };
}

function command(url: string, env: NodeJS.ProcessEnv, args: string[]) {
  const child = spawn(process.execPath, [cli, '--server', url, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout!.on('data', data => { stdout += data; }); child.stderr!.on('data', data => { stderr += data; });
  return once(child, 'close').then(([code]) => ({ code: code as number | null, stdout, stderr }));
}

/** Every file below `folder` that holds `text`, read as bytes (the databases included). */
function filesHolding(folder: string, text: string, skip: (path: string) => boolean): string[] {
  const found: string[] = [];
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (skip(path)) continue;
    const facts = statSync(path, { throwIfNoEntry: false });
    if (facts?.isDirectory()) found.push(...filesHolding(path, text, skip));
    else if (facts?.isFile() && readFileSync(path).includes(text)) found.push(path);
  }
  return found;
}

test('a key in the file reaches the agent that lists its name and no other, and is written nowhere', async t => {
  const h = await workspace(t);
  writeFileSync(h.file, [`FILE_KEY=${SECRET}`, `OTHER_KEY="${OTHER}"`, 'PATH=/pinned/by/the/file', 'DO_NOT_TRACK=1', `export BROKEN=${SECRET}`, ''].join('\n'));
  chmodSync(h.file, 0o600);
  const env = serviceEnvironment(h.home, h.agentPath), server = await serve(h, env);

  // The server says what it read without quoting it, and the switch in the file is the one its readers see.
  const report = await server.read('/api/environment-file');
  assert.deepEqual(environmentFileSchema.parse(report.body),
    { path: h.file, state: 'read', applied: 3, skipped: [{ line: 3, reason: 'reserved' }, { line: 5, reason: 'malformed' }] });
  assert.equal((await server.read('/api/telemetry/status')).body.blockedBy, 'env');

  for (const [index, name] of (['keyed', 'plain'] as const).entries()) {
    const instruction = join(h.home, `${name}.md`);
    writeFileSync(instruction, `${name}-instruction`);
    const task = h.tasks[index]!.id;
    const requested = await command(server.url, env, ['task', 'request', '--task', task, '--instruction-file', instruction, '--op-id', randomUUID(),
      '--expected-task-hash', currentTaskHash(h.root, task), '--expected-placement-revision', String(h.placements[index]!.revision)]);
    assert.equal(requested.code, 0, requested.stderr);
  }
  // The fake agent leaves what it was started with in its own receipt (the fixture's file, not the product's).
  const receipts = join(h.root, 'processes');
  const started = await until(() => {
    if (!existsSync(receipts)) return false;
    // A receipt read while it is being written is read again on the next look.
    const agents = readdirSync(receipts).flatMap(name => {
      try { return [JSON.parse(readFileSync(join(receipts, name), 'utf8')) as { env?: Record<string, string>; prompt?: string }]; } catch { return []; }
    });
    const of = (name: string) => agents.find(receipt => receipt.env && receipt.prompt?.includes(`${name}-instruction`))?.env;
    const keyed = of('keyed'), plain = of('plain');
    return keyed && plain ? { keyed, plain } : false;
  }, 'both agents started');
  assert.equal(started.keyed.FILE_KEY, SECRET);
  assert.equal(started.keyed.OTHER_KEY, undefined, 'a name its settings do not list stays with the server');
  assert.equal(started.plain.FILE_KEY, undefined);
  assert.equal(started.plain.OTHER_KEY, undefined);
  for (const agent of [started.keyed, started.plain]) {
    assert.equal(agent.PATH, h.agentPath, 'PATH is the launch snapshot\'s; the file never sets it');
    assert.equal(agent.HOME, h.home);
  }

  // Both Runs have ended, so everything a Run records is written before the records are searched.
  await until(() => { const all = runs(h.root); return all.length === 2 && all.every(run => ['succeeded', 'failed', 'cancelled'].includes(run.state)); }, 'both Runs ended');
  const settings = await server.read('/api/commands/config/get');
  await server.stop();
  assert.ok(filesHolding(h.root, 'keyed-instruction', path => path === receipts).length > 0, 'the search reads where a Request is recorded');
  for (const value of [SECRET, OTHER]) {
    for (const said of [report.text, settings.text, server.output.stdout, server.output.stderr])
      assert.equal(said.includes(value), false, 'the server quoted a value of the file');
    assert.deepEqual(filesHolding(h.root, value, path => path === receipts), [], 'a value of the file is in the workspace\'s records');
    assert.deepEqual(filesHolding(h.home, value, path => path === h.file), [], 'a value of the file is copied below HOME');
  }
  // The log names the file and the lines, for whoever reads it; the screen says the same.
  assert.match(server.output.stderr, /Environment file .+ line 3 was skipped \(reserved\)/);
  assert.match(server.output.stderr, /Environment file .+ line 5 was skipped \(malformed\)/);
});

test('a file others can read is not applied and says why; no file is as before', async t => {
  const h = await workspace(t);
  const env = serviceEnvironment(h.home, h.agentPath);

  writeFileSync(h.file, `FILE_KEY=${SECRET}\nDO_NOT_TRACK=1\n`);
  chmodSync(h.file, 0o644);
  let server = await serve(h, env);
  assert.deepEqual((await server.read('/api/environment-file')).body, { path: h.file, state: 'permissions', applied: 0, skipped: [] });
  // The switch in the unread file is not seen: reporting is held back by the test alone.
  assert.equal((await server.read('/api/telemetry/status')).body.blockedBy, 'test');
  await server.stop();
  assert.match(server.output.stderr, /Environment file .+ was not read \(permissions\); none of it is set/);
  assert.equal(server.output.stderr.includes(SECRET) || server.output.stdout.includes(SECRET), false);

  rmSync(h.file);
  server = await serve(h, env);
  assert.deepEqual((await server.read('/api/environment-file')).body, { path: h.file, state: 'absent', applied: 0, skipped: [] });
  assert.equal((await server.read('/api/telemetry/status')).body.blockedBy, 'test');
  await server.stop();
  assert.equal(server.output.stderr.includes('Environment file'), false, 'no file is no problem');
});
