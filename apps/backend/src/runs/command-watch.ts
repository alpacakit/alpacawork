/** One policy for both CLIs: a non-root session leader starts a command. The manager supplies its existing ticks. */
import { platform, type RunProcess } from '@alpacawork/core';
import { TerminationSequence } from './termination.js';
import type { EventJournal } from './execution-files.js';

type Command = { session: number; started: string; since: number; termination: TerminationSequence; members: Map<number, string> };
export class CommandWatch {
  private readonly commands = new Map<string, Command>();
  constructor(private readonly root: number, private readonly seconds: number, private readonly scope: string | null,
    private readonly journal: Pick<EventJournal, 'append'>) {}

  tick(now = performance.now()): void {
    const rows = platform.run.commandProcesses(this.root, this.scope);
    const current = new Map(rows.map(row => [row.pid, row]));
    // A surviving incarnation witnesses the original session after TERM ends its leader. A reused PID never does.
    for (const [key, command] of this.commands) {
      if (![...command.members].some(([pid, started]) => current.get(pid)?.started === started && current.get(pid)?.session === command.session))
        this.commands.delete(key);
    }
    for (const row of rows) if (row.pid !== this.root && row.pid === row.session) {
      const key = `${row.pid}:${row.started}`;
      if (!this.commands.has(key)) this.commands.set(key, { session: row.pid, started: row.started,
        since: now - row.ageMs, termination: new TerminationSequence(1000), members: new Map([[row.pid, row.started]]) });
    }
    for (const command of this.commands.values()) {
      const members = rows.filter(row => row.session === command.session && row.pid !== this.root);
      command.members = new Map(members.map(row => [row.pid, row.started]));
      if (now - command.since < this.seconds * 1000) continue;
      const signal = command.termination.next(now);
      if (!signal) continue;
      const pids: number[] = [], failed: Array<{ pid: number; code: 'EPERM' | 'ESRCH' }> = [];
      // A refused PID cannot prevent the rest of this session from receiving the same signal.
      for (const row of members) {
        const result = this.signal(row, signal);
        if (result === 'sent') pids.push(row.pid);
        else if (result !== 'stale') failed.push({ pid: row.pid, code: result });
      }
      if (pids.length || failed.length) this.journal.append('command_stopped', { session: command.session, started: command.started,
        signal, seconds: this.seconds, pids, failed });
    }
  }
  private signal(row: RunProcess, signal: NodeJS.Signals): 'sent' | 'stale' | 'EPERM' | 'ESRCH' {
    // Recheck incarnation immediately before every signal, including the one after the grace tick.
    if (platform.run.started(row.pid) !== row.started) return 'stale';
    try { process.kill(row.pid, signal); return 'sent'; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'EPERM') return code;
      throw error;
    }
  }
}
