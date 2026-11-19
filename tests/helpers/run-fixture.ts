import { grantFixtureRequest } from './control-fixture.ts';
import { randomUUID } from 'node:crypto';
import type { CreateRunFields, RunTransaction } from '@alpacawork/runs';
import type { RunStore } from '@alpacawork/runs';

/**
 * A synthetic Run has the placement and request witnesses of a received request: a placement its Task lacks is added
 * as a worker seat, and a request it lacks is added for that placement.
 */
export function createFixtureRun(store: RunStore, tx: RunTransaction, fields: CreateRunFields, prompt: string) {
  const db = store.connection;
  const task = db.prepare(`SELECT 1 FROM tasks WHERE external_id=? AND kind='task'`).get(fields.task);
  if (!task) return tx.create(fields, prompt);
  if (!tx.getPlacement(fields.placementId)) {
    const agentId = `A${randomUUID()}`;
    db.prepare('INSERT INTO agents(id,created_at) VALUES (?,?)').run(agentId, new Date().toISOString());
    db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at)
      VALUES (?,?,?,?,0,1,?)`).run(fields.placementId, fields.task, agentId, fields.agent, new Date().toISOString());
  }
  if (!tx.getRequest(fields.requestId)) tx.insertRequest({
    id: fields.requestId, taskId: fields.task, placementId: fields.placementId,
    placementRevision: tx.getPlacement(fields.placementId)?.revision ?? 1,
    taskHash: '0'.repeat(64), waitCycleId: null, headRunId: null, mode: 'new', body: prompt,
    purpose: 'instruction', author: { kind: 'human' }, submittedAt: new Date().toISOString(), deliveryState: 'queued',
  });
  if (!db.prepare('SELECT 1 FROM task_start_grants WHERE request_id=?').get(fields.requestId)) grantFixtureRequest(store, tx, fields.requestId);
  return tx.create(fields, prompt);
}
