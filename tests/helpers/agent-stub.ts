/** Local executables for built-in adapter protocols; PATH never falls through to a provider install. */
import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { agentLaunchSchema, compileAgentSetting, prepareAgentLaunch, defaultAgentSetting, type AgentLaunch, type Selection, type AgentSetting } from '@alpacawork/contract';
import { BUILTIN_ADAPTER_IDS, optionsBase, type BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';

// Adapter IDs plus executable aliases used by the installed bridges/private provider guard.
export const FIXTURE_PROVIDER_COMMANDS = [...BUILTIN_ADAPTER_IDS, 'gemini', 'alpacawork-agent'];
const stubCommands = ['claude', 'alpacawork-agent', 'codex', 'grok', 'agy', 'pi'] as const;
const quote = (word: string) => "'" + word.replaceAll("'", "'\\''") + "'";
// A real provider command is not a shell script. Where /bin/sh is bash (macOS), its exec exports SHLVL=0, which the
// launch never gave; drop it so the agent sees the launch's environment. Test (l) checks that environment without a stub.
const stubSource = (argv: string[]) => `#!/bin/sh\nexec /usr/bin/env -u SHLVL ${argv.map(quote).join(' ')} "$@"\n`;

function assertFixtureDirectories(root: string): void {
  for (const name of ['agent-bin', 'tool-bin']) {
    const directory = join(root, name);
    try {
      if (!lstatSync(directory).isDirectory()) throw new Error(`Fixture directory is not a regular directory: ${directory}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Entries belong to this fresh fixture only; no shell parsing or cross-instance recovery. */
function stubTarget(root: string, command: string) { return join(root, `fixture-${command}.sh`); }
function checkStub(root: string, command: string): boolean {
  const file = join(root, 'agent-bin', command);
  try {
    if (!lstatSync(file).isSymbolicLink() || readlinkSync(file) !== stubTarget(root, command))
      throw new Error(`Fixture PATH exposes a provider outside its declared stubs: ${file}`);
    if (!lstatSync(stubTarget(root, command)).isFile()) throw new Error(`Fixture stub is not a regular file: ${file}`);
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function executable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return statSync(file).isFile(); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code!)) return false;
    throw error;
  }
}

/** Share only named tools, never their personal installation directory or the caller's PATH. */
export function fixturePath(root: string): string {
  assertFixtureDirectories(root);
  for (const name of stubCommands) if (!checkStub(root, name)) throw new Error(`Fixture stub is missing: ${name}`);
  const bin = join(root, 'agent-bin'), tools = join(root, 'tool-bin');
  mkdirSync(tools, { recursive: true });
  const sources: [string, string][] = [
    ...['node', 'pnpm', 'corepack'].map((name): [string, string] => [name, name === 'node' ? process.execPath : join(dirname(process.execPath), name)]),
    // Shell/descendant fixtures; these tools live in /bin on both supported Unix hosts.
    ...['sh', 'bash', 'sleep', 'ps'].map((name): [string, string] => [name, `/bin/${name}`]),
    // Source/archive/HTTP fixtures and the existing syscall audit.
    ...['git', 'tar', 'gzip', 'curl', 'strace'].map((name): [string, string] => [name, `/usr/bin/${name}`]),
    // The process adapter's identity and existing user-scope/service commands.
    ...['getconf', 'systemd-run', 'true', 'systemctl'].map((name): [string, string] => [name, `/usr/bin/${name}`]),
    ['sysctl', '/usr/sbin/sysctl'],
  ];
  for (const [name, source] of sources) {
    if (!executable(source)) continue;
    const target = join(tools, name);
    try { symlinkSync(source, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!lstatSync(target).isSymbolicLink() || realpathSync(target) !== realpathSync(source))
        throw new Error(`Fixture tool has an unexpected target: ${target}`);
    }
  }
  const directories = [bin, tools];
  // Static precondition: do not probe providers, even with --version/help/auth/status.
  for (const name of FIXTURE_PROVIDER_COMMANDS) for (const directory of directories) {
    const file = join(directory, name);
    if (!executable(file)) continue;
    if (!stubCommands.some(stub => name === stub) || directory !== bin || !checkStub(root, name))
      throw new Error(`Fixture PATH exposes a provider outside its declared stubs: ${file}`);
  }
  return directories.join(delimiter);
}

export function fixtureAgentSetting(adapter: BuiltinAdapterId, options?: { start: string; resume: string }): AgentSetting {
  const { params, env, without } = defaultAgentSetting(adapter);
  return { params, adapter, ...(env.length ? { env } : {}), ...(Object.keys(without).length ? { without } : {}),
    ...(options ? { options: { base: optionsBase(adapter), ...options } } : {}) };
}
export function installAgentStub(root: string, command: 'claude' | 'alpacawork-agent', argv: string[] = ['/usr/bin/false']) {
  const bin = join(root, 'agent-bin');
  assertFixtureDirectories(root);
  const installed = stubCommands.map(name => checkStub(root, name));
  if (!argv.length) throw new Error('Fixture stub needs a literal executable');
  mkdirSync(bin, { recursive: true });
  for (const [index, name] of stubCommands.entries()) {
    if (name !== command && installed[index]) continue;
    const fd = openSync(stubTarget(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o700);
    try { writeFileSync(fd, stubSource(name === command ? argv : ['/usr/bin/false'])); } finally { closeSync(fd); }
    if (!installed[index]) symlinkSync(stubTarget(root, name), join(bin, name));
  }
  return fixturePath(root);
}

const inertLaunches = new Map<BuiltinAdapterId, AgentLaunch>();

/** Synthetic admission facts for ended history; values are supplied by the fixture, never read from labels. */
export function inertFixtureLaunch(adapter: BuiltinAdapterId, values: Selection = {}): AgentLaunch {
  let launch = inertLaunches.get(adapter);
  if (!launch) {
    launch = prepareAgentLaunch(compileAgentSetting(adapter, defaultAgentSetting(adapter)),
      { mode: 'start', path: '/usr/bin:/bin' }).launch;
    inertLaunches.set(adapter, launch);
  }
  return agentLaunchSchema.parse({ ...launch, argv: ['/usr/bin/false'], values });
}
