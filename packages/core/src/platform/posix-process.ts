import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { hasCode } from '../errors.js';
import type { RunProcess, HostAdapter } from './types.js';

/**
 * Zombies and exiting processes no longer execute. Darwin's ps marks an exiting process (P_WEXIT) with an `E`
 * after its run state (`RE`, `UE`, `?Es`); XNU's killpg skips such a process before it turns into a zombie.
 */
export const isLiveProcess = (p: { state: string }): boolean => !p.state.startsWith('Z') && !p.state.includes('E', 1);

/** Every ps-derived identity uses the same locale, executable and whitespace normalization. */
function ps(args: string[]): string {
  return execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: 5000,
    env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
}
const startIdentity = (value: string): string => value.trim().replace(/\s+/g, ' ');

/** One POSIX process snapshot for group liveness and test-owned cleanup. Fail closed on unreadable rows. */
export function processRows() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat=,command='], { encoding: 'utf8', timeout: 5000 }).split('\n')
    .filter(line => line.trim()).map(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) throw new Error('Invalid POSIX process row');
      return { pid: Number(match[1]), pgid: Number(match[2]), state: match[3]!, command: match[4]! };
    });
}

/** Keep ancestry and identity in the same snapshot; a PID reused outside this tree is never adopted. */
export function processDescendants<T extends { pid: number; parent: number }>(rows: T[], root: number): T[] {
  const owned = new Set([root]);
  for (let count = -1; count !== owned.size;) {
    count = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  }
  return rows.filter(row => owned.has(row.pid));
}

/**
 * A detached POSIX child leads a process group, which can outlive its manager. launchd stops only a job's own
 * process group, so on macOS this also outlives serve's job; `unit` has nothing more to do.
 */
export const posixRun: HostAdapter['run'] = {
  spawnDetached(command: string, args: readonly string[], options: SpawnOptions) {
    return spawn(command, [...args], { ...options, detached: true });
  },
  signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process group: ${pid}`);
    try { process.kill(-pid, signal); return true; }
    catch (error) {
      if (hasCode(error, 'ESRCH')) return false;
      if (!hasCode(error, 'EPERM')) throw error;
      // XNU killpg1 skips zombies and exiting processes (no longer found by pid), returning EPERM when none is left.
      // Permission refusal and a stopped group are different outcomes, also for probes.
      let members;
      try { members = processRows().filter(p => p.pgid === pid); }
      catch (inspection) {
        throw new Error(`Cannot inspect process group ${pid} after ${signal} EPERM`, {
          cause: new AggregateError([error, inspection], 'Signal denied and process inspection failed'),
        });
      }
      if (!members.some(isLiveProcess)) return false;
      if (signal === 0) return true;
      // Every member's ps state, so the next refusal shows why the kernel found no target.
      const states = members.map(p => `${p.pid} ${p.state}`).join(', ');
      throw new Error(`Cannot ${signal} process group ${pid}; live PID ${members.filter(isLiveProcess).map(p => p.pid).join(', ')}` +
        ` (ps pid stat: ${states})`, { cause: error });
    }
  },
  // Nothing places a process in a unit of its own here: it has only its group, which its starter stops.
  stopUnitOthers: () => Promise.resolve(),
  environment: [],
  processes() {
    return execFileSync('ps', ['-xww', '-o', 'pid=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').flatMap(line => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        return match ? [{ pid: Number(match[1]), command: match[2]! }] : [];
      });
  },
  /**
   * Darwin's ps reports every session as 0, so the process group stands for it: a command started with setsid
   * leads both, and its members stay in that group unless they move to a group of their own.
   */
  commandProcesses(root: number) {
    const rows: RunProcess[] = ps(['-axo', 'pid=,ppid=,pgid=,lstart=,etime=,stat=']).split('\n').filter(line => line.trim()).flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+([\d:-]+)\s+(\S+)\s*$/.exec(line);
        if (!match) throw new Error('Invalid command process row');
        if (!isLiveProcess({ state: match[6]! })) return [];
        const parts = match[5]!.split(/[-:]/).map(Number).reverse();
        const ageMs = parts.reduce((sum, value, index) => sum + value * [1000, 60_000, 3_600_000, 86_400_000][index]!, 0);
        return [{ pid: Number(match[1]), parent: Number(match[2]), session: Number(match[3]),
          started: startIdentity(match[4]!), ageMs }];
      });
    return processDescendants(rows, root);
  },
  bootId() { return execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }).trim(); },
  scope: () => null,
  started(pid: number): string | null {
    try {
      return startIdentity(ps(['-o', 'lstart=', '-p', String(pid)])) || null;
    } catch { return null; }
  },
};
