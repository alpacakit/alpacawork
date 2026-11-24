/** Run intervals and additive usage shared by CLI and browser views. */
import type { ControlRunDTO } from './control-contract.js';
import { TOKEN_COUNTER_KEYS, type ReadRunRecord, type TokenCounters } from './run-contract.js';

type TimedRun = Pick<ControlRunDTO, 'startedAt' | 'endedAt' | 'state'>;

/** An open interval is projected to the clock only while the Run is running. */
export function runSpan(run: TimedRun, now: number | null): { from: number; to: number | null } | null {
  if (run.startedAt === null) return null;
  const from = Date.parse(run.startedAt);
  if (!Number.isFinite(from)) return null;
  const to = run.endedAt === null ? run.state === 'running' ? now : NaN : Date.parse(run.endedAt);
  if (to !== null && (!Number.isFinite(to) || to <= from)) return null;
  return { from, to };
}

type UsageSource = Pick<ControlRunDTO, 'startedAt' | 'endedAt' | 'state' | 'processStarted' | 'usage'>;

export function runUsageSource(run: Pick<ReadRunRecord, 'started_at' | 'ended_at' | 'state' | 'pids' | 'usage'>): UsageSource {
  return { startedAt: run.started_at, endedAt: run.ended_at, state: run.state,
    processStarted: run.pids.agent !== null,
    usage: run.usage ? { run: run.usage.run, includesEarlier: run.usage.includesEarlier } : null };
}

export type RunContribution = { started: number; ended: number | null; live: boolean; tokens: TokenCounters | null };

/** A reservation records a timestamp before the process starts. Count only witnessed launches. */
export function runUsage(run: UsageSource): RunContribution | null {
  if (!run.processStarted || run.startedAt === null || run.state === 'queued' || run.state === 'joined') return null;
  const started = Date.parse(run.startedAt);
  if (!Number.isFinite(started)) return null;
  const end = run.endedAt === null ? NaN : Date.parse(run.endedAt);
  return { started, ended: Number.isFinite(end) ? end : null,
    live: run.state === 'running' && run.endedAt === null, tokens: run.usage?.run ?? null };
}

/** Passing no clock keeps live time out of a saved total; the reader can add it from the recorded start. */
export function runUsageMs(run: RunContribution, now: number | null): number {
  return Math.max(0, (run.ended ?? (run.live ? now : null) ?? run.started) - run.started);
}

export type UsageTotal = {
  runs: number;
  runMs: number;
  tokens: TokenCounters | null;
  tokensUnknown: number;
};

export function sumUsage(runs: readonly UsageSource[], now: number | null): UsageTotal {
  return sumRunUsage(runs.map(runUsage), now);
}

export function sumRunUsage(runs: Iterable<RunContribution | null>, now: number | null): UsageTotal {
  let count = 0, runMs = 0, tokensUnknown = 0;
  let tokens: TokenCounters | null = null;
  for (const usage of runs) {
    if (!usage) continue;
    count++;
    runMs += runUsageMs(usage, now);
    if (!usage.tokens) { tokensUnknown++; continue; }
    tokens ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const key of TOKEN_COUNTER_KEYS) tokens[key] += usage.tokens[key];
  }
  return { runs: count, runMs, tokens, tokensUnknown };
}
