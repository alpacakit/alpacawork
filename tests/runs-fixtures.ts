import { inertFixtureLaunch } from './helpers/agent-stub.ts';
/** Shared complete records for run foundation tests. */
import { coordinatorRunRecordSchema, type CoordinatorRunRecord, type RunRecord } from '@alpacawork/contract/run';
import type { CreateRunFields, CreateCoordinatorRunFields } from '@alpacawork/runs';
export const time = '2026-09-25T00:00:00Z';
export function record(id = 'R1', fields: Partial<RunRecord> = {}): RunRecord {
  return { id, task: 'T1', placementId: 'Ptest', requestId: `request-${id}`, agent: 'fake', role: 'owner', resumes: null, continues: false, session: null,
    caller: null, cwd: '/tmp', launch: inertFixtureLaunch('codex'),
    state: 'queued', reason: null, into: null, stop_requested: false, exit: null, usage: null,
    created_at: time, started_at: null, ended_at: null, pids: { manager: null, agent: null }, ...fields };
}
export function fields(overrides: Partial<CreateRunFields> = {}): CreateRunFields {
  const { task, placementId, requestId, agent, role, resumes, continues, session, caller, cwd, launch } = record();
  return { task, placementId, requestId: globalThis.crypto.randomUUID(), agent, role, resumes, continues, session, caller, cwd, launch, ...overrides };
}
export const ended = (id = 'R1', extra: Partial<RunRecord> = {}) => record(id, { state: 'succeeded', ended_at: time, ...extra });
export const ids = (runs: RunRecord[]) => runs.map(run => run.id);

/** A synthetic new coordinator turn, validated as the persisted execution record. */
export function coordinatorRecord(id = 'R1', overrides: Partial<CoordinatorRunRecord> = {}): CoordinatorRunRecord {
  return coordinatorRunRecordSchema.parse({ ...record(id), task: null, placementId: null, role: 'coordinator', caller: null,
    conversationId: '00000000-0000-4000-8000-000000000000',
    message: { context: null, attachments: [], intent: null }, ...overrides });
}
export function coordinatorFields(overrides: Partial<CreateCoordinatorRunFields> = {}): CreateCoordinatorRunFields {
  const { conversationId, agent, resumes, session, cwd, launch, message } = coordinatorRecord();
  return { conversationId, requestId: globalThis.crypto.randomUUID(), agent, resumes, session, cwd, launch, message, ...overrides };
}
