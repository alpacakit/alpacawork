import { platform, processGroupState, watchProcessGroup } from '@alpacawork/core';
import { setTimeout as delay } from 'node:timers/promises';

/** One TERM→grace→KILL sequence, advanced by the caller's observations; each signal is due once. */
export class TerminationSequence {
  private termAt: number | null = null;
  private killed: number | null = null;
  constructor(private readonly graceMs: number) {}
  get killedAt(): number | null { return this.killed; }
  next(now: number): 'SIGTERM' | 'SIGKILL' | null {
    if (this.termAt === null) { this.termAt = now; return 'SIGTERM'; }
    if (this.killed !== null || now - this.termAt < this.graceMs) return null;
    this.killed = now; return 'SIGKILL';
  }
}

/** Group authority and post-KILL confirmation belong to the group caller, not to the signal sequence. */
async function terminateGroup(pid: number, observe: () => ReturnType<typeof processGroupState>): Promise<boolean> {
  const sequence = new TerminationSequence(10_000);
  for (;;) {
    const state = observe();
    if (state === 'gone') return true;
    if (state === 'unknown') return false;
    const now = performance.now(), signal = sequence.next(now);
    if (signal) platform.run.signalGroup(pid, signal);
    if (sequence.killedAt !== null && now - sequence.killedAt >= 10_000)
      throw new Error(`Agent process group ${pid} remains after SIGKILL`);
    await delay(100);
  }
}

/** The manager owns its child handle and observes its group throughout shutdown. */
export async function terminateAgent(pid: number): Promise<void> {
  await terminateGroup(pid, () => platform.run.signalGroup(pid, 0) ? 'owned' : 'gone');
}

/** Recovery needs an incarnation witness; leader loss never authorizes a reused group. */
export function terminateRecordedGroup(identity: Parameters<typeof processGroupState>[0]): Promise<boolean> {
  return terminateGroup(identity.group, watchProcessGroup(identity));
}
