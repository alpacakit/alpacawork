/** Fixed local tarball acceptance in an ordinary offline prefix. Keep evidence on failure. */
import assert from 'node:assert/strict';
import { parse, stringify } from 'yaml';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const { values } = parseArgs({ options: { tarball: { type: 'string' }, output: { type: 'string' } } });
if (!values.tarball || !values.output) throw new Error('Need --tarball <local absolute file> --output <new absolute test root>');
const tarball = realpathSync(values.tarball), out = resolve(values.output), repo = realpathSync(new URL('..', import.meta.url));
const placement = relative(repo, join(realpathSync(dirname(out)), basename(out)));
if (placement === '' || !(placement === '..' || placement.startsWith('..' + sep)))
  throw new Error('Acceptance output must be outside the checkout');
if (existsSync(out)) throw new Error('Acceptance output must be new (failed evidence is never overwritten)');
mkdirSync(out, { mode: 0o700 });
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_') && !['NODE_PATH', 'NODE_OPTIONS', 'INIT_CWD', 'npm_config_prefix'].includes(key)));
Object.assign(env, { HOME: join(out, 'home'), XDG_CONFIG_HOME: join(out, 'home/.config'), XDG_CACHE_HOME: join(out, 'home/.cache'), npm_config_registry: 'http://127.0.0.1:9/', COREPACK_ENABLE_NETWORK: '0', npm_config_update_notifier: 'false' });
for (const dir of ['home', 'cwd', 'prefix', 'cache', 'fixture-cache']) mkdirSync(join(out, dir), { recursive: true, mode: 0o700 });
const commands: object[] = [], checks: Record<string, unknown> = {}, children: { pid: number; deadline: string; exited?: boolean }[] = [];
function command(label: string, args: string[], status = 0, environment = env) {
  const result = spawnSync(process.execPath, args, { cwd: join(out, 'cwd'), env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(out, label + '.stdout'), result.stdout ?? ''); writeFileSync(join(out, label + '.stderr'), result.stderr ?? '');
  commands.push({ label, executable: process.execPath, args, cwd: join(out, 'cwd'), status: result.status, error: result.error?.message });
  assert.equal(result.status, status, `${label}: ${result.error?.message ?? result.stderr}`); return result.stdout;
}
let server: ChildProcess | null = null, serverExit: Promise<void> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
async function stopServer() {
  if (!server) return;
  const child = server;
  child.kill('SIGTERM');
  await Promise.race([serverExit, delay(5000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await serverExit;
  children.at(-1)!.exited = true; server = null;
  if (deadline) clearTimeout(deadline); deadline = undefined;
}
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const)
  process.once(signal, () => { void stopServer().finally(() => process.exit(code)); });
async function startServer(label: string, backend: string, workspace: string) {
  server = spawn(process.execPath, [backend, '--workspace', workspace, 'workspace', 'serve', '--port', '0'], { cwd: join(out, 'cwd'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = server;
  serverExit = new Promise<void>((done, reject) => { child.once('exit', () => done()); child.once('error', reject); });
  children.push({ pid: child.pid!, deadline: new Date(Date.now() + 120_000).toISOString(), exited: false });
  deadline = setTimeout(() => child.kill('SIGKILL'), 120_000);
  let stdout = '', stderr = '', address: string | undefined;
  child.stdout!.on('data', data => { stdout += data; }); child.stderr!.on('data', data => { stderr += data; });
  for (let i = 0; i < 300; i++) {
    for (const line of stdout.split('\n')) { try { const result = JSON.parse(line); if (result.url) address = result.url; } catch {} }
    if (address || child.exitCode !== null || child.signalCode !== null) break;
    await delay(100);
  }
  writeFileSync(join(out, label + '.stdout'), stdout); writeFileSync(join(out, label + '.stderr'), stderr);
  assert.ok(address, `server did not become ready: ${stderr}`);
  const ready = await fetch(new URL('/api/runtime/readiness', address));
  assert.equal(ready.status, 200); assert.equal((await ready.json()).state, 'accepting');
  return address;
}
try {
  const fixture = join(repo, 'scripts/dev-fixtures/fixture.ts');
  const made = JSON.parse(command('fixture-create', [fixture, 'create', '--profile', 'small', '--cache', join(out, 'fixture-cache'), '--seed', 'npm-package']));
  const original = made.root;
  assert.equal(typeof original, 'string', 'fixture generator root');
  const workspace = join(out, 'data');
  command('fixture-copy', [fixture, 'copy', '--source', original, '--dest', workspace]);
  // No live provider may be admitted, even from a pending return in the common fixture.
  const configFile = join(workspace, 'config.yaml'), config = parse(readFileSync(configFile, 'utf8'));
  config.limits = { ...config.limits, automatic_per_placement: 0 };
  writeFileSync(configFile, stringify(config));
  const npm = realpathSync(join(process.execPath, '..', 'npm'));
  const userConfig = join(out, 'user.npmrc'), globalConfig = join(out, 'global.npmrc'); writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
  command('npm-install', [npm, 'install', '--global', '--prefix', join(out, 'prefix'), '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', join(out, 'cache'), '--userconfig', userConfig, '--globalconfig', globalConfig, tarball]);
  const list = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); assert.equal(list.status, 0);
  writeFileSync(join(out, 'tarball-files.txt'), list.stdout);
  const packed = spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); assert.equal(packed.status, 0, packed.stderr);
  const identity = JSON.parse(packed.stdout);
  const root = join(out, 'prefix/lib/node_modules', identity.name), bin = join(out, 'prefix/bin/alpacawork'), backend = join(out, 'prefix/bin/alpacawork-backend');
  assert.equal(command('version', [bin, '--version']).trim(), identity.version);
  assert.deepEqual(JSON.parse(command('version-facts', [bin, 'version'])).schema, identity.alpacawork.schema);
  command('pending-setup', [bin, 'setup'], 2); command('pending-client', [bin, 'client', 'update'], 2);
  command('cli-help', [bin, 'task', 'get', '-h']); command('backend-help', [backend, '-h']);
  command('native-load', ['--input-type=module', '-e', `import {createRequire} from 'node:module';const req=createRequire(${JSON.stringify(join(root, 'package.json'))});const koffi=req('koffi');const libc=koffi.load('libc.so.6');if(libc.func('int getpid()')()!==process.pid)throw Error('Koffi ABI');console.log('Koffi ignore-scripts closure loaded');`]);
  command('agent-import', [join(out, 'prefix/bin/alpacawork-agent')], 1);
  assert.match(readFileSync(join(out, 'agent-import.stderr'), 'utf8'), /agent name is required/);

  const address = await startServer('serve', backend, workspace);
  checks.cliRead = JSON.parse(command('cli-read', [bin, '--server', address, 'task', 'list']));
  assert.ok(checks.cliRead);
  const response = await fetch(address); assert.equal(response.status, 200); assert.match(await response.text(), /<script/);
  const assets = JSON.parse(readFileSync(join(root, 'apps/backend/public/asset-manifest.json'), 'utf8'));
  const web = await fetch(new URL('/' + assets['index.html'].file, address)); assert.equal(web.status, 200); assert.ok((await web.text()).length > 100);
  checks.web = { html: true, asset: assets['index.html'].file, status: web.status };
  await stopServer();

  const fresh = join(out, 'fresh'); mkdirSync(fresh, { mode: 0o700 });
  command('fresh-init', [backend, '--workspace', fresh, 'workspace', 'init'], 0, { ...env, XDG_CONFIG_HOME: join(out, 'fresh-config') });
  // Serve creates the host database through its ordinary migrator; no internal package import.
  await startServer('fresh-serve', backend, fresh); await stopServer();
  const maintenance = join(root, 'apps/backend/dist/maintenance.js');
  command('fresh-migrate', [maintenance, 'migrate', fresh]);
  const history = JSON.parse(command('fresh-inspect', [maintenance, 'inspect', fresh]));
  assert.equal(history.schema, identity.alpacawork.schema.control.version);
  assert.deepEqual(history.control, { version: history.schema, history: identity.alpacawork.schema.control.history });
  assert.deepEqual(history.host, identity.alpacawork.schema.host);
  checks.dbHistories = { control: history.control, host: history.host };
  const historyRefusals: string[] = [];
  for (const kind of ['control', 'host'] as const) {
    const label = `reject-history-${kind}`, copy = join(out, label); cpSync(fresh, copy, { recursive: true });
    const file = join(copy, '.alpacawork', kind === 'control' ? 'alpacawork.sqlite' : 'host.sqlite');
    command(label + '-input', ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(file)});try{const result=db.prepare("UPDATE __drizzle_migrations SET hash=printf('%064d',1)").run();if(!result.changes)throw Error('No migration history was changed');}finally{db.close();}`]);
    command(label, [maintenance, 'inspect', copy], 1);
    assert.match(readFileSync(join(out, label + '.stderr'), 'utf8'), /Unknown or modified.*history/i);
    historyRefusals.push(label);
  }
  checks.dbHistoryRefusals = historyRefusals;
  const distribution = JSON.parse(readFileSync(join(root, 'DISTRIBUTION.json'), 'utf8'));
  checks.skills = Object.keys(distribution).filter(file => file.startsWith('skills/'));
  checks.sql = Object.keys(distribution).filter(file => file.endsWith('.sql'));
  command('fixture-remove', [fixture, 'remove', '--root', workspace]);
  command('fixture-original-remove', [fixture, 'remove', '--root', original]);
  checks.success = true;
} catch (error) {
  checks.failure = error instanceof Error ? error.stack : String(error); throw error;
} finally {
  await stopServer();
  writeFileSync(join(out, 'commands.json'), JSON.stringify(commands, null, 2));
  writeFileSync(join(out, 'result.json'), JSON.stringify({ tarball, bytes: readFileSync(tarball).length, sha256: sha(readFileSync(tarball)), checks, children }, null, 2));
}
