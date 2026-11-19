/** Run intervals and additive usage shared by CLI and browser views. */
import type { ControlRunDTO } from './control-contract.js';
import type { TokenCounters } from './run-contract.js';

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

export type UsageTotal = {
  runs: number;
  runMs: number;
  tokens: TokenCounters | null;
  tokensUnknown: number;
};

/** Add stored per-Run deltas; unknown and live Runs make the known sum a lower bound. */
export function sumUsage(runs: readonly ControlRunDTO[], now: number): UsageTotal {
  let count = 0, runMs = 0, tokensUnknown = 0;
  let tokens: TokenCounters | null = null;
  for (const run of runs) {
    if (run.startedAt === null) continue;
    count++;
    const span = runSpan(run, now);
    if (span && span.to !== null) runMs += span.to - span.from;
    const known = run.endedAt !== null ? run.usage?.run : null;
    if (!known) { tokensUnknown++; continue; }
    if (!tokens) tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    tokens.input += known.input;
    tokens.cacheRead += known.cacheRead;
    tokens.cacheWrite += known.cacheWrite;
    tokens.output += known.output;
  }
  return { runs: count, runMs, tokens, tokensUnknown };
}
