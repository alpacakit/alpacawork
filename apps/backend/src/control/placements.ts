import { TASK_POLICY, evaluate } from '@alpacawork/contract/task-policy';
/** The Run database owns person identity and task/person placement intervals. */
import { isTaskReview } from '@alpacawork/contract';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { currentControlConnection, inTransaction, openControlDatabase, touch } from '@alpacawork/db';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { taskId, taskState, text, type TaskState, type TaskBaseState } from '@alpacawork/raw';
import { UNFINISHED_SQL, parseStoredAgent, parseStoredPlacement, runsUnavailable, type StoredAgent, type StoredPlacement } from '@alpacawork/runs';

type AgentRecord = StoredAgent;
export type PlacementRecord = StoredPlacement;
/**
 * The states a Task is at work in: an active Task in one needs its responsible (uncoveredTasks), and a new responsible
 * takes such a Task over.
 */
export const taskAtWork = (task: Parameters<typeof isTaskReview>[0]) =>
  evaluate(TASK_POLICY.seat, { baseState: task.baseState, snapshotReview: isTaskReview(task) }).code === 'required';

export class PlacementStore {
  private readonly db: { $client: DatabaseSync };
  private readonly borrowed: boolean;
  constructor(private readonly root: string, readOnly = false, connection?: DatabaseSync) {
    const shared = connection ?? currentControlConnection(root);
    this.borrowed = shared !== undefined;
    this.db = { $client: shared ?? openControlDatabase(root, { busyTimeoutMs: 10_000 }, readOnly) };
  }
  close() { if (!this.borrowed) this.db.$client.close(); }
  private transaction<T>(callback: () => T): T {
    try {
      return inTransaction({ root: this.root, db: this.db.$client, borrowed: this.borrowed, savepoint: 'placement',
        exec: sql => this.db.$client.exec(sql),
        notSynchronous: () => new Problem(PROBLEM_CODE.invalidInput, 'Placement transaction callback must be synchronous'),
      }, 'BEGIN IMMEDIATE', callback);
    } catch (error) {
      if (error instanceof Problem) throw error;
      throw runsUnavailable(error);
    }
  }
  agents(): AgentRecord[] {
    try { return this.db.$client.prepare('SELECT * FROM agents ORDER BY created_at, id').all().map(parseStoredAgent); }
    catch (error) { throw runsUnavailable(error); }
  }
  placements(task?: string): PlacementRecord[] {
    try {
      const query = task === undefined ? this.db.$client.prepare('SELECT * FROM placements ORDER BY started_at, id') :
        this.db.$client.prepare('SELECT * FROM placements WHERE task_id = ? ORDER BY started_at, id');
      return query.all(...(task === undefined ? [] : [taskId(task)])).map(parseStoredPlacement);
    } catch (error) { if (error instanceof Problem) throw error; throw runsUnavailable(error); }
  }
  createAgent(): AgentRecord {
    return this.transaction(() => this.insertAgent());
  }
  private insertAgent(): AgentRecord {
    const agent: AgentRecord = { id: `A${randomUUID()}`, createdAt: new Date().toISOString() };
    this.db.$client.prepare('INSERT INTO agents(id, created_at) VALUES (?, ?)')
      .run(agent.id, agent.createdAt);
    return agent;
  }
  /** A missing Task fails its foreign key and a project fails placements_task_kind. */
  private insertPlacement(task: string, agentId: string, profileKey: string, responsible: boolean): PlacementRecord {
      if (this.db.$client.prepare('SELECT 1 FROM placements WHERE task_id = ? AND agent_id = ? AND ended_at IS NULL').get(task, agentId))
        throw new Problem(PROBLEM_CODE.conflict, 'Person is already active on this task', undefined, { reason: { kind: 'person_already_active_on_task' } });
      if (responsible && this.db.$client.prepare('SELECT 1 FROM placements WHERE task_id = ? AND ended_at IS NULL AND responsible = 1').get(task))
        throw new Problem(PROBLEM_CODE.conflict, 'Task already has a responsible placement', undefined, { reason: { kind: 'task_already_has_responsible_placement' } });
      const placement: PlacementRecord = { id: `P${randomUUID()}`, taskId: task, agentId, profileKey,
        responsible, active: true, revision: 1, startedAt: new Date().toISOString(), endedAt: null };
      this.db.$client.prepare(`INSERT INTO placements
        (id, task_id, agent_id, profile_key, responsible, revision, started_at, ended_at) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`)
        .run(placement.id, task, agentId, profileKey, responsible ? 1 : 0, placement.startedAt);
      touch(this.db.$client, { kind: 'placement', id: placement.id });
      return placement;
  }
  place(input: { taskId: string; agentId: string; profileKey: string; responsible: boolean },
    beforeCommit?: (result: PlacementRecord) => void): PlacementRecord {
    const task = taskId(input.taskId), agentId = text(input.agentId, 'agentId', 128);
    const profileKey = text(input.profileKey, 'profileKey', 128);
    return this.transaction(() => {
      if (!this.db.$client.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId))
        throw new Problem(PROBLEM_CODE.notFound, 'Agent does not exist', undefined, { reason: { kind: 'agent_does_not_exist' } });
      const result = this.insertPlacement(task, agentId, profileKey, input.responsible);
      beforeCommit?.(result);
      return result;
    });
  }
  createAndPlace(input: { taskId: string; profileKey: string; responsible: boolean },
    beforeCommit?: (result: { agent: AgentRecord; placement: PlacementRecord }) => void) {
    const task = taskId(input.taskId);
    const profileKey = text(input.profileKey, 'profileKey', 128);
    return this.transaction(() => {
      const agent = this.insertAgent();
      const result = { agent, placement: this.insertPlacement(task, agent.id, profileKey, input.responsible) };
      beforeCommit?.(result);
      return result;
    });
  }
  createAndReplaceResponsible(input: { taskId: string; profileKey: string;
    replacePlacementId: string; expectedPlacementRevision: number },
    beforeCommit?: (result: { agent: AgentRecord; placement: PlacementRecord;
      previousPlacement: PlacementRecord }) => void) {
    const task = taskId(input.taskId);
    const profileKey = text(input.profileKey, 'profileKey', 128);
    return this.transaction(() => {
      const row = this.db.$client.prepare('SELECT * FROM placements WHERE id = ?').get(input.replacePlacementId);
      if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Current responsible placement does not exist', undefined,
        { reason: { kind: 'current_responsible_placement_does_not_exist' } });
      const current = parseStoredPlacement(row);
      if (current.taskId !== task || !current.active || !current.responsible ||
        current.revision !== input.expectedPlacementRevision)
        throw new Problem(PROBLEM_CODE.conflict, 'Responsible placement changed', undefined, { reason: { kind: 'responsible_placement_changed' } });
      this.assertCurrentIdle(current);
      const previousPlacement = this.endPlacement(current);
      const agent = this.insertAgent();
      const result = { agent, placement: this.insertPlacement(task, agent.id, profileKey, true), previousPlacement };
      beforeCommit?.(result);
      return result;
    });
  }
  setResponsible(placementId: string, expectedRevision: number,
    beforeCommit?: (result: { placement: PlacementRecord; previousPlacement: PlacementRecord | null }) => void) {
    return this.transaction(() => {
      const row = this.db.$client.prepare('SELECT * FROM placements WHERE id = ?').get(placementId);
      if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Placement does not exist', undefined, { reason: { kind: 'placement_does_not_exist' } });
      const target = parseStoredPlacement(row);
      if (!target.active) throw new Problem(PROBLEM_CODE.conflict, 'Placement is inactive', undefined, { reason: { kind: 'placement_inactive' } });
      if (target.revision !== expectedRevision)
        throw new Problem(PROBLEM_CODE.conflict, 'Placement revision changed', { revision: target.revision }, { reason: { kind: 'placement_revision_changed' } });
      if (target.responsible) return { placement: target, previousPlacement: null };
      const currentRow = this.db.$client.prepare(`SELECT * FROM placements WHERE task_id = ?
        AND ended_at IS NULL AND responsible = 1`).get(target.taskId);
      const current = currentRow ? parseStoredPlacement(currentRow) : null;
      if (current) this.assertCurrentIdle(current);
      const previousPlacement = current ? this.endPlacement(current) : null;
      this.db.$client.prepare('UPDATE placements SET responsible = 1, revision = revision + 1 WHERE id = ?')
        .run(placementId);
      touch(this.db.$client, { kind: 'placement', id: placementId });
      const result = { placement: { ...target, responsible: true, revision: target.revision + 1 }, previousPlacement };
      beforeCommit?.(result);
      return result;
    });
  }
  /**
   * Ends an idle placement. A responsible ends alone only where its Task needs none (uncoveredTasks): one with children
   * or at work changes hands by a replacement or a handover instead.
   */
  release(placementId: string, expectedRevision: number,
    beforeCommit?: (result: PlacementRecord) => void): PlacementRecord {
    return this.transaction(() => {
      const row = this.db.$client.prepare('SELECT * FROM placements WHERE id = ?').get(placementId);
      if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Placement does not exist', undefined, { reason: { kind: 'placement_does_not_exist' } });
      const placement = parseStoredPlacement(row);
      if (!placement.active || placement.revision !== expectedRevision)
        throw new Problem(PROBLEM_CODE.conflict, 'Placement changed', { revision: placement.revision }, { reason: { kind: 'placement_changed' } });
      if (this.hasUnfinishedRuns(placement.id))
        throw new Problem(PROBLEM_CODE.handoffPending, 'Placement has unfinished runs', undefined, { reason: { kind: 'placement_has_unfinished_runs' } });
      const result = this.endPlacement(placement);
      const [uncovered] = placement.responsible ? this.uncoveredTasks([placement.taskId]) : [];
      if (uncovered) throw new Problem(PROBLEM_CODE.handoverRequired, `${uncovered.taskId} keeps a responsible while it has children or work under way: ` +
        'hand it over with agent handover or replace it with agent assign --replace', { task: uncovered.taskId, hasChildren: uncovered.hasChildren, state: uncovered.state },
        { reason: { kind: 'keeps_responsible_while_it_has_children_or_work_under_way_hand_it_over_with_agent_handover_or_replace_it_with', uncoveredTaskId: String(uncovered.taskId) } });
      beforeCommit?.(result);
      return result;
    });
  }
  /**
   * The responsible seat invariant: a task with an undeleted child, or an active task that is doing, waiting,
   * or in error (also while held from those states), has a current responsible. Returns the tasks that break it; without ids, the whole workspace.
   */
  uncoveredTasks(taskIds?: readonly string[]): { taskId: string; hasChildren: boolean; state: TaskState }[] {
    const only = taskIds === undefined ? [] : [JSON.stringify(taskIds.map(id => taskId(id)))];
    try {
      return this.db.$client.prepare(`SELECT external_id, state, base_state, has_children, log FROM (
          SELECT t.number, t.external_id, t.lifecycle, t.state, t.base_state,
            (SELECT json_group_array(json(entry)) FROM
              (SELECT entry FROM task_log l WHERE l.task_id = t.id ORDER BY ordinal)) AS log,
            EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.lifecycle <> 'deleted') AS has_children
          FROM tasks t WHERE t.kind = 'task' ${taskIds === undefined ? '' : 'AND t.external_id IN (SELECT value FROM json_each(?))'}
            AND NOT EXISTS(SELECT 1 FROM placements p WHERE p.task_id = t.external_id AND p.ended_at IS NULL AND p.responsible = 1))
        WHERE has_children OR lifecycle = 'active'
        ORDER BY number`).all(...only)
        .filter(row => Boolean(row.has_children) || taskAtWork({ baseState: taskState(row.base_state) as TaskBaseState,
          log: JSON.parse(String(row.log)) }))
        .map(row => ({ taskId: String(row.external_id), hasChildren: Boolean(row.has_children), state: taskState(row.state) }));
    } catch (error) { if (error instanceof Problem) throw error; throw runsUnavailable(error); }
  }
  /** The one way a placement ends: its next revision, stopped now. Returns it as ended. */
  private endPlacement(placement: PlacementRecord): PlacementRecord {
    const endedAt = new Date().toISOString();
    this.db.$client.prepare('UPDATE placements SET revision = revision + 1, ended_at = ? WHERE id = ?')
      .run(endedAt, placement.id);
    touch(this.db.$client, { kind: 'placement', id: placement.id });
    return { ...placement, active: false, revision: placement.revision + 1, endedAt };
  }
  /** A responsible hands over only while none of its Runs is unfinished. */
  private assertCurrentIdle(current: PlacementRecord): void {
    if (this.hasUnfinishedRuns(current.id))
      throw new Problem(PROBLEM_CODE.handoffPending, 'Current responsible placement has unfinished runs', undefined,
        { reason: { kind: 'current_responsible_placement_has_unfinished_runs' } });
  }
  private hasUnfinishedRuns(placementId: string): boolean {
    return !!this.db.$client.prepare(`SELECT 1 FROM runs WHERE
      placement_id = ? AND state IN (${UNFINISHED_SQL}) LIMIT 1`).get(placementId);
  }
}
