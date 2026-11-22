import { execFileSync, spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hasCode } from '../errors.js';
import type { RunProcess, HostAdapter } from './types.js';
import { posixRun, processDescendants } from './posix-process.js';

/**
 * systemd stops every process in a service's cgroup with the service. A process given a `unit` therefore starts
 * in its own transient scope of the user's systemd, where restarting serve's service cannot reach it.
 * `systemd-run --scope` execs the command in place: the PID, process group and inherited descriptors stay.
 */
const scopes = new Map<string, boolean>();
/** Tells a process started in its own scope that scope's unit, so it never takes a scope it shares for its own. */
const UNIT = 'ALPACAWORK_UNIT';
/** Whether the user's systemd is reachable from `env`; one probe per runtime directory. */
function userScopes(env: NodeJS.ProcessEnv): boolean {
  const runtime = env.XDG_RUNTIME_DIR;
  if (!runtime) return false;
  let reachable = scopes.get(runtime);
  if (reachable === undefined) {
    reachable = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'true'],
      { env, stdio: 'ignore', timeout: 5000 }).status === 0;
    if (!reachable) console.error('systemd user scopes are unavailable; Runs started here stop with this service');
    scopes.set(runtime, reachable);
  }
  return reachable;
}

/** The file spawn would execute, found as execvp finds it; null when spawn would fail to start it. */
function executable(command: string, env: NodeJS.ProcessEnv, cwd: string): string | null {
  const runnable = (path: string) => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
    catch { return false; }
  };
  const find = (name: string) => {
    if (name.includes('/')) {
      const path = isAbsolute(name) ? name : resolve(cwd, name);
      return runnable(path) ? path : null;
    }
    for (const directory of (env.PATH ?? '').split(delimiter)) {
      const path = resolve(cwd, directory || '.', name);
      if (runnable(path)) return path;
    }
    return null;
  };
  const path = find(command);
  if (path === null) return null;
  // A script starts only when its interpreter does (`#!/usr/bin/env node` also needs `node` on PATH).
  const [interpreter, argument] = shebang(path);
  if (interpreter === null) return path;
  if (!runnable(interpreter)) return null;
  return interpreter.endsWith('/env') && argument && !argument.startsWith('-') && find(argument) === null ? null : path;
}
function shebang(path: string): [string | null, string | undefined] {
  const head = Buffer.alloc(256);
  let length = 0;
  try {
    const fd = openSync(path, 'r');
    try { length = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  } catch { return [null, undefined]; }
  const line = head.subarray(0, length).toString('latin1');
  if (!line.startsWith('#!')) return [null, undefined];
  // As the kernel reads it: up to the newline, split at spaces and tabs only (a CR stays in the name).
  const [interpreter, argument] = line.slice(2).split('\n')[0]!.replace(/^[ \t]+/, '').split(/[ \t]+/);
  return [interpreter || null, argument];
}

/** Field 22 is the incarnation; read all metadata from that same /proc stat row. */
function processStat(pid: number): { state: string; parent: number; session: number; started: string } | null {
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { if (hasCode(error, 'ENOENT') || hasCode(error, 'ESRCH')) return null; throw error; }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const started = fields[19];
  if (!started) throw new Error(`Invalid process stat for PID ${pid}`);
  return { state: fields[0]!, parent: Number(fields[1]), session: Number(fields[3]), started };
}

/** cgroup v2 names a process's group on its `0::` line, and systemd names a scope's group after the unit. */
const groupOf = (cgroup: string) => /^0::(\/.*)$/m.exec(cgroup)?.[1];
const cgroup2Mount = () => readFileSync('/proc/self/mounts', 'utf8').split('\n').map(line => line.split(' '))
  .find(fields => fields[2] === 'cgroup2')?.[1];
/**
 * Who is in a group now, its nested groups included: the user owns its scopes, so a command can make a group inside
 * one and move there. systemd removes a collected scope once nothing is left in it.
 */
function groupMembers(mount: string, group: string): number[] {
  let procs: string, nested: string[];
  try {
    procs = readFileSync(`${mount}${group}/cgroup.procs`, 'utf8');
    nested = readdirSync(`${mount}${group}`, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch (error) {
    // A group removed while it is read (ENODEV once opened), or a nested group made threaded, has no one to stop.
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENODEV') || hasCode(error, 'EOPNOTSUPP')) return [];
    throw error;
  }
  return [...procs.split(/\s+/).filter(Boolean).map(Number), ...nested.flatMap(name => groupMembers(mount, `${group}/${name}`))];
}

let clockTicks: number | undefined;

export const linuxRun: HostAdapter['run'] = {
  spawnDetached(command: string, args: readonly string[], options: SpawnOptions, unit?: string) {
    const env = options.env ?? process.env;
    // A command that cannot start keeps spawn's own error: systemd-run would turn it into an exit status.
    const path = unit === undefined ? null : executable(command, env, String(options.cwd ?? process.cwd()));
    if (path === null || !userScopes(env)) return posixRun.spawnDetached(command, args, options);
    // systemd adds INVOCATION_ID to what it starts; the process gets the caller's environment and its unit's name.
    return spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--',
      '/usr/bin/env', '-u', 'INVOCATION_ID', `${UNIT}=${unit}`, path, ...args], { ...options, detached: true });
  },
  signalGroup: posixRun.signalGroup,
  commandProcesses(root, scope) {
    clockTicks ??= Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5000 }).trim());
    if (!(clockTicks > 0)) throw new Error('Invalid host clock tick rate');
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
    const readProcess = (pid: number): RunProcess[] => {
      const stat = processStat(pid);
      if (!stat || stat.state === 'Z' || stat.state === 'X') return [];
      return [{ pid, parent: stat.parent, session: stat.session, started: stat.started,
        ageMs: Math.max(0, uptime - Number(stat.started) * 1000 / clockTicks!) }];
    };
    // ps discovers candidate descendants once. Rebuild ancestry from the same stat that supplies each
    // incarnation: a PID replaced between ps and /proc must not inherit the old process's age or ownership.
    const descendants = () => processDescendants(posixRun.commandProcesses(root, null)
      .flatMap(row => readProcess(row.pid)), root);
    const group = scope ? groupOf(scope) : undefined;
    if (!group?.endsWith('.scope')) return descendants();
    const mount = cgroup2Mount();
    if (!mount) return descendants();
    return [...new Set(groupMembers(mount, group))]
      .filter(pid => pid !== process.pid || pid === root).flatMap(readProcess);
  },
  async stopUnitOthers(recorded) {
    const own = groupOf(readFileSync('/proc/self/cgroup', 'utf8'));
    const unit = recorded === undefined ? process.env[UNIT] : undefined;
    const group = recorded === undefined ? own : groupOf(recorded.scope);
    const mount = cgroup2Mount();
    // Outside cgroup v2 or outside a scope named for the unit, nothing that shares the group is the unit's own.
    if (group === undefined || mount === undefined || !group.endsWith('.scope')) return false;
    if (recorded === undefined ? !unit || basename(group) !== `${unit}.scope`
      : group === own || !recorded.ours(basename(group).slice(0, -'.scope'.length))) return false;
    const others = () => groupMembers(mount, group).filter(pid => pid !== process.pid);
    const deadline = performance.now() + 10_000;
    let left = others();
    const interrupted = left.length > 0;
    for (; left.length; left = others()) {
      if (performance.now() >= deadline) throw new Error(`Unit ${basename(group)} keeps PID ${left.join(', ')} after SIGKILL`);
      for (const pid of left) {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if (!hasCode(error, 'ESRCH')) throw error; }
      }
      await delay(100);
    }
    return interrupted;
  },
  // A Run's manager starts the next Run's manager; it reaches the user's systemd as serve does.
  environment: ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'],
  processes() {
    const uid = process.getuid?.();
    return readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).flatMap(entry => {
      try {
        if (statSync(`/proc/${entry}`).uid !== uid) return [];
        const command = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
        return command ? [{ pid: Number(entry), command }] : [];
      } catch { return []; }
    });
  },
  bootId() { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); },
  scope(pid) {
    try { return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim(); }
    catch { return null; /* PID ended. */ }
  },
  started(pid: number) {
    try { return processStat(pid)?.started ?? null; }
    catch { return null; }
  },
};
