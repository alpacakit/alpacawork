/** Rebuildable, Run-scoped diagnostics. Evidence stays on disk; these never own execution eligibility. */
import { faultReason, PROBLEM_CODE, type ProblemReason } from '@alpacawork/core';
import type { RunId } from '@alpacawork/contract/fields';
import { isRunEnded, runNumber, type RuntimeRunRecord } from '@alpacawork/contract/run';
import type { RunStore } from '@alpacawork/runs';
import { reconcileCompletedRunFiles } from './gc.js';

type RunReviewIssue = { code: string; message: string; path: string; reason?: ProblemReason };
type Area = 'cleanup' | 'recovery';
export class RunReviewState {
  private readonly groups = new Map<string, { run: RunId; area: Area; issues: RunReviewIssue[] }>();
  revision = 0;
  get issues(): RunReviewIssue[] { return [...this.groups.values()].flatMap(group => group.issues); }
  observe(run: RunId, area: Area, issues: RunReviewIssue[]): void {
    const projected = issues.map(({ code, message, path, reason }) => ({ code, message, path, ...(reason ? { reason } : {}) }));
    const key = `${run}:${area}`, previous = this.groups.get(key);
    if (JSON.stringify(previous?.issues ?? []) === JSON.stringify(projected)) return;
    if (projected.length) this.groups.set(key, { run, area, issues: projected });
    else this.groups.delete(key);
    this.revision++;
  }
  fault(run: RunId, area: Area, error: unknown): void {
    const message = `Run ${run} ${area} requires review: ${error instanceof Error ? error.message : String(error)}`;
    this.observe(run, area, [{ code: PROBLEM_CODE.readFailed, path: `.alpacawork/runs/${run}`, message,
      reason: faultReason(new Error(message)) }]);
  }
  cleanup(store: RunStore, run: Pick<RuntimeRunRecord, 'id' | 'state'>): void {
    const result = reconcileCompletedRunFiles(store, run);
    if (result.state !== 'skipped') this.observe(run.id, 'cleanup', result.issues);
  }
  /** Revisit only diagnosed Runs. A committed observation supersedes an earlier recovery fault. */
  retryCleanup(store: RunStore): void {
    for (const { run, area } of [...this.groups.values()]) {
      const current = store.runtimeGet(run);
      if (!current) continue;
      if (area === 'cleanup') this.cleanup(store, current);
      else if (isRunEnded(current.state) || store.connection.prepare('SELECT completed_digest FROM run_attempts WHERE run_no=?')
        .get(runNumber(run))?.completed_digest != null) this.observe(run, area, []);
    }
  }
}
