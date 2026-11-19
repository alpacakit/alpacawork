/** Pure translations of the published records. No database or filesystem reads belong here. */
import type { ReadRunRecord } from '@alpacawork/contract';
import type { ControlRequestDTO, ControlRunDTO } from '@alpacawork/contract/control';
import type { RecordsReader } from './projection-contract.js';

export function recordedRun(run: ReadRunRecord): ControlRunDTO {
  return { id: run.id, taskId: run.task, placementId: run.placementId, requestId: run.requestId,
    agent: run.agent, modelId: run.launch.values.model?.trim() || null, effort: run.launch.values.effort?.trim() || null,
    caller: run.caller ? { ...run.caller } : null, resumes: run.resumes, continues: run.continues,
    session: run.session ? { ...run.session } : null, cwd: run.cwd, state: run.state, reason: run.reason, into: run.into,
    // History and timeline use the persisted execution facts, not the input affordance of an open Run.
    takesInput: false, launchValues: { ...run.launch.values }, activity: null,
    createdAt: run.created_at, startedAt: run.started_at, endedAt: run.ended_at,
    usage: run.usage ? { run: run.usage.run ? { ...run.usage.run } : null, includesEarlier: run.usage.includesEarlier } : null };
}

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
