import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { Caller } from '@alpacawork/contract/command-access';
import { taskActorSchema } from '@alpacawork/raw/task-log-schema';
import { restoreId } from '../release/journal.js';

export type ProgramCaller = Extract<Caller, { kind: 'program' }>;

export function resolveProgramCredential(root: string, db: DatabaseSync | undefined, token: string): ProgramCaller {
  if (!db || !/^[0-9a-f]{64}$/.test(token))
    throw new Problem(PROBLEM_CODE.forbidden, 'Automation credential is not active');
  const digest = createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`SELECT r.*,a.external_id,a.revision AS automation_revision,a.live_digest,a.deleted,
    a.activation_epoch AS active,p.external_id AS project,d.event FROM automation_runs r JOIN automations a ON a.id=r.automation_id
    JOIN tasks p ON p.id=a.project_task_id LEFT JOIN automation_run_data d ON d.automation_id=r.automation_id AND d.run_number=r.number
    WHERE r.state='running' AND r.phase IN ('trigger','run') AND a.deleted=0
    AND r.activation_epoch IS a.activation_epoch AND json_extract(r.attempt,'$.identity.pid') IS NOT NULL
    AND json_extract(r.attempt,'$.tokenDigest')=? AND json_extract(r.attempt,'$.generation')=?`).get(digest, restoreId(root));
  if (!row) {
    const preview = db.prepare(`SELECT v.id,v.attempt,p.external_id AS project FROM automation_previews v JOIN tasks p ON p.id=v.project_task_id
      LEFT JOIN automations a ON a.id=v.automation_id WHERE v.result IS NULL AND coalesce(a.deleted,0)=0
      AND json_extract(v.attempt,'$.phase') IN ('trigger','run') AND json_extract(v.attempt,'$.identity.pid') IS NOT NULL AND json_extract(v.attempt,'$.tokenDigest')=?
      AND json_extract(v.attempt,'$.generation')=?`).get(digest, restoreId(root));
    if (!preview) throw new Problem(PROBLEM_CODE.forbidden, 'Automation credential is not active');
    const marker = JSON.parse(String(preview.attempt));
    return { kind: 'program', attemptId: String(preview.id), project: String(preview.project),
      previewActor: taskActorSchema.parse(marker.by), stage: marker.phase === 'run' ? 'action' : 'condition' };
  }
  const marker = JSON.parse(String(row.attempt));
  const event = typeof row.event === 'string' ? JSON.parse(row.event) : null;
  return { kind: 'program', attemptId: marker.id, automationUuid: String(row.automation_id), automationId: String(row.external_id),
    revision: Number(row.activation_revision ?? row.automation_revision), runNumber: Number(row.number), stage: row.phase === 'trigger' ? 'condition' : 'action',
    project: String(row.project), triggerTaskId: event?.task?.id ?? null, trial: row.mode === 'trial' };
}
