/** The durable part of a Run's screen representation, shared by History and the live view. */
import { runUsageSource } from '@alpacawork/contract';
import type { ReadRunRecord } from '@alpacawork/contract/run';
import type { ControlRunDTO } from '@alpacawork/contract/control';

export function recordedRun(run: ReadRunRecord): ControlRunDTO {
  return { id: run.id, taskId: run.task, placementId: run.placementId, requestId: run.requestId,
    agent: run.agent, modelId: run.launch.values.model?.trim() || null, effort: run.launch.values.effort?.trim() || null,
    caller: run.caller ? { ...run.caller } : null, resumes: run.resumes, continues: run.continues,
    session: run.session ? { ...run.session } : null, cwd: run.cwd, reason: run.reason, into: run.into,
    // History and timeline use the persisted execution facts, not the input affordance of an open Run.
    takesInput: false, launchValues: { ...run.launch.values }, activity: null,
    ...(run.availability ? { availability: { ...run.availability } } : {}),
    ...(run.supersededBy ? { supersededBy: run.supersededBy } : {}),
    ...(run.newConversation ? { newConversation: { ...run.newConversation } } : {}),
    ...(run.compactions?.length ? { compactions: run.compactions.map(compaction => ({ ...compaction })) } : {}),
    ...runUsageSource(run), createdAt: run.created_at };
}
