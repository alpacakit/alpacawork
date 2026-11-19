/** One policy for stopping test-owned POSIX groups, including macOS exit races. */
import { setTimeout as delay } from 'node:timers/promises';
import { posixRun, processRows, isLiveProcess as isLive } from '../../packages/core/dist/platform/posix-process.js';
export { isLive, processRows };

export function killGroup(pgid: number) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error(`Invalid test process group: ${pgid}`);
  posixRun.signalGroup(pgid, 'SIGKILL');
}

/** A bridge owns its detached group; zombies/exiting members have stopped executing. */
export async function stopGroup(pgid: number, timeout = 5000) {
  killGroup(pgid);
  await until(() => !processRows().some(p => p.pgid === pgid && isLive(p)),
    `process group ${pgid} stopped`, timeout);
}
async function until(check: () => boolean, message: string, timeout: number) {
  const deadline = performance.now() + timeout;
  for (;;) {
    if (check()) return;
    if (performance.now() >= deadline) throw new Error(`Deadline: ${message}`);
    await delay(20);
  }
}
export function processes(root?: string) {
  return processRows().filter(p => root === undefined || p.command.includes(root))
    .map(({ pid, pgid }) => ({ pid, pgid }));
}
/** Roots discover current groups; only fixtures with authoritative receipts pass recorded PGIDs. */
export async function cleanupGroups(root: string, recorded: Iterable<number> = []) {
  const known = new Set(recorded);
  const signalled = new Set<number>();
  await until(() => {
    const left = processes(root);
    for (const p of left) known.add(p.pgid);
    // After SIGKILL, macOS can still list an exiting process while kill(-pgid, 0)
    // returns EPERM. Wait for the recorded groups to disappear from ps instead
    // of probing/signalling a group that is already being reaped.
    const rows = processRows();
    const present = new Set(rows.map(p => p.pgid));
    const groups = [...known].filter(pgid => pgid > 0 && present.has(pgid));
    for (const pgid of groups) if (!signalled.has(pgid)) {
      const members = rows.filter(p => p.pgid === pgid);
      if (members.every(p => !isLive(p))) continue;
      killGroup(pgid);
      signalled.add(pgid);
    }
    return !left.length && !groups.length;
  }, `all groups gone: ${root}`, 15_000);
}
