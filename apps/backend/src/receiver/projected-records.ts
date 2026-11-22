/** Pure translations of the published records. No database or filesystem reads belong here. */
import type { ControlRequestDTO } from '@alpacawork/contract/control';
import type { RecordsReader } from './projection-contract.js';

export { recordedRun } from '../runs/run-view.js';

export function recordedRequests(records: RecordsReader, task: string): ControlRequestDTO[] {
  return (records.bundle(task)?.requests ?? []).map(saved => {
    const runId = saved.runId ?? records.runByRequest(saved.id);
    const run = runId ? records.run(runId) : undefined;
    return { id: saved.id, taskId: saved.taskId, placementId: saved.placementId, runId: saved.runId,
      recipientRole: run?.task === saved.taskId && run.placementId === saved.placementId ? run.role : null,
      aboutRunId: saved.aboutRunId, purpose: saved.purpose, author: saved.author, mode: saved.mode,
      body: saved.body, submittedAt: saved.submittedAt, deliveryState: saved.deliveryState };
  });
}
