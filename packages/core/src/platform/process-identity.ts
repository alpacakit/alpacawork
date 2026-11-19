/** Evidence for recovery is bound to this boot and this incarnation of a PID. */
import { processRows, isLiveProcess } from './posix-process.js';
import { platform } from './index.js';
let boot: string | undefined;
export function bootIdentity(): string {
  return boot ??= platform.run.bootId();
}
export function processIdentity(pid: number) {
  const scope = platform.run.scope(pid);
  return { pid, started: platform.run.started(pid), bootId: bootIdentity(), group: pid, scope };
}
export function sameProcess(identity: { pid: number; started: string | null; bootId: string }): boolean {
  return identity.bootId === bootIdentity() && identity.started !== null && platform.run.started(identity.pid) === identity.started;
}

/** Leader identity authorizes signalling; only group absence proves the invocation stopped.
 * A surviving group after leader loss may be a reused numeric ID: leave it unconfirmed.
 * On another boot the recorded incarnation is gone, without signalling any current PID.
 */
export function processGroupState(identity: { pid: number; started: string | null; bootId: string; group: number }): 'gone' | 'owned' | 'unknown' {
  if (identity.bootId !== bootIdentity()) return 'gone';
  if (!platform.run.signalGroup(identity.group, 0)) return 'gone';
  return identity.group === identity.pid && sameProcess(identity) ? 'owned' : 'unknown';
}

/** A witness lasts only for this supervision operation. Capture members while the recorded
 * leader still anchors the group. A surviving captured incarnation anchors that same group
 * after TERM killed the leader; an unobserved/reused group never gains this authority.
 */
export function watchProcessGroup(identity: Parameters<typeof processGroupState>[0]): () => ReturnType<typeof processGroupState> {
  let witnesses: Array<{ pid: number; started: string | null; bootId: string }> = [];
  if (processGroupState(identity) === 'owned') {
    witnesses = processRows().filter(p => p.pgid === identity.group && isLiveProcess(p))
      .map(p => ({ pid: p.pid, started: platform.run.started(p.pid), bootId: identity.bootId }));
    if (!sameProcess(identity)) witnesses = [];
  }
  return () => {
    const state = processGroupState(identity);
    if (state !== 'unknown' || !witnesses.length) return state;
    const members = new Set(processRows().filter(p => p.pgid === identity.group && isLiveProcess(p)).map(p => p.pid));
    return witnesses.some(w => members.has(w.pid) && sameProcess(w)) ? 'owned' : 'unknown';
  };
}
