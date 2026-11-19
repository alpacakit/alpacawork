/**
 * Placement mutations under the Task→Run lock order. Who may make each is authorize's, so they take the actor it
 * decided and check only the Task's and the placements' facts. A change's record goes through TaskTransition, and a
 * Task at work tells its new responsible in the same write by a handover notice, whose line return-lines draws.
 */
import { randomUUID } from 'node:crypto';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { TaskActor } from '@alpacawork/raw';
import type { Selection } from '@alpacawork/contract/agent-settings';
import { TaskRepository } from './task-store.js';
import { taskAtWork, PlacementStore, type PlacementRecord } from './placements.js';
import { TaskTransition, returnsAt, withControlWrite } from './task-transition.js';
import { readAgentsSettings, validateAgentSelection } from '../agents-settings.js';
import { placeAgentReceiptSchema, setResponsibleReceiptSchema, releaseAgentReceiptSchema,
  placeMemberReceiptSchema, releaseMemberReceiptSchema,
  type PlaceAgentInput, type SetResponsibleInput, type ReleaseAgentInput,
  type PlaceMemberInput, type ReleaseMemberInput } from '@alpacawork/contract/control';

/** What one write gives a command: the placements, and the records of their changes on the Task. */
type Write = {
  store: PlacementStore;
  /** Records a placement change on the Task by the command's actor; returns the record's ID. */
  record(kind: 'responsible_changed' | 'placement_changed', placement: PlacementRecord,
    effect: 'responsible' | 'member' | 'released', launchValues?: Selection): string;
  /** A replaced or handed-over responsible: a Task at work tells its new one, caused by the record `logId`. */
  handover(logId: string): void;
};

export class PlacementCommands {
  private readonly transition = new TaskTransition();
  constructor(readonly root: string) {}
  private requireProfile(key: string | null, selected: Selection = {}): void {
    const settings = readAgentsSettings(this.root);
    if (!settings.ok) throw settings.error;
    if (key === null || !Object.hasOwn(settings.config.agents, key))
      throw new Problem(PROBLEM_CODE.invalidInput, 'Responsible placement requires a configured launch profile', undefined,
        { reason: { kind: 'responsible_placement_requires_configured_launch_profile' }, issues: [{ path: 'profile', code: 'unknown_profile', message: 'A configured launch profile is required' }] });
    validateAgentSelection(settings.config, key, selected);
  }
  /** One write about the active task `id` at `expectedTaskHash`, recorded as `actor`. */
  private async write<T>(id: string, expectedTaskHash: string, actor: TaskActor,
    operation: (write: Write) => T): Promise<T> {
    return withControlWrite(this.root, (tx, db) => {
      const repository = new TaskRepository(this.root, db);
      const task = repository.get(id);
      // placements_task_kind refuses too, but PlacementStore would report that as runs_unavailable.
      if (task.meta.kind === 'project')
        throw new Problem(PROBLEM_CODE.invalidInput, 'A project cannot have a responsible or a member', undefined,
          { reason: { kind: 'project_cannot_have_responsible_or_member' } });
      if (task.meta.lifecycle !== 'active')
        throw new Problem(PROBLEM_CODE.notFound, 'Active task does not exist', undefined, { reason: { kind: 'active_task_does_not_exist' } });
      if (task.hash !== expectedTaskHash)
        throw new Problem(PROBLEM_CODE.conflict, 'Task changed; reload before retrying', { hash: task.hash }, { reason: { kind: 'task_changed' } });
      const store = new PlacementStore(this.root, false, db);
      const record: Write['record'] = (kind, placement, effect, launchValues) => {
        // After the Task's last record, so its log keeps its order.
        const latestAt = task.meta.log.reduce((latest, entry) => Math.max(latest, Date.parse(entry.at)), 0);
        const logId = `L${randomUUID()}`;
        this.transition.appendRecord(tx, task.id, { id: logId, kind,
          at: new Date(Math.max(Date.now(), latestAt + 1)).toISOString(),
          title: null, description: null, actor, fromState: null, toState: null,
          placementId: placement.id, placementRevision: placement.revision, placementEffect: effect,
          ...(launchValues === undefined ? {} : { launchValues: { ...launchValues } }) });
        return logId;
      };
      const handover = (logId: string) => {
        if (taskAtWork(task.meta)) returnsAt(tx, task.id).notice('handover', task.id, logId);
      };
      try { return operation({ store, record, handover }); }
      finally { store.close(); }
    });
  }
  /** A member change by the Task's responsible, against the responsible's revision the caller read. */
  private withResponsibleAt<T>(input: { taskId: string; expectedTaskHash: string; expectedResponsibleRevision: number },
    actor: TaskActor, operation: (write: Write) => T): Promise<T> {
    return this.write(input.taskId, input.expectedTaskHash, actor, write => {
      const responsible = write.store.placements(input.taskId).find(item => item.active && item.responsible);
      if (responsible?.revision !== input.expectedResponsibleRevision)
        throw new Problem(PROBLEM_CODE.conflict, 'Responsible placement revision changed', { currentPlacementRevision: responsible?.revision ?? null },
          { reason: { kind: 'responsible_placement_revision_changed' } });
      return operation(write);
    });
  }
  placeNewResponsible(input: PlaceAgentInput, actor: TaskActor) {
    return this.write(input.taskId, input.expectedTaskHash, actor, ({ store, record, handover }) => {
      this.requireProfile(input.profileKey, input.selected);
      return placeAgentReceiptSchema.parse(input.replacePlacementId === undefined
        ? { ...store.createAndPlace({ taskId: input.taskId,
          profileKey: input.profileKey, responsible: true }, result =>
          record('responsible_changed', result.placement, 'responsible', input.selected ?? {})), previousPlacement: null }
        : store.createAndReplaceResponsible({ taskId: input.taskId,
          profileKey: input.profileKey, replacePlacementId: input.replacePlacementId,
          expectedPlacementRevision: input.expectedPlacementRevision! }, result =>
          handover(record('responsible_changed', result.placement, 'responsible', input.selected ?? {}))));
    });
  }
  setResponsible(input: SetResponsibleInput, actor: TaskActor) {
    return this.write(input.taskId, input.expectedTaskHash, actor, ({ store, record, handover }) => {
      const candidate = store.placements(input.taskId).find(item => item.id === input.placementId);
      if (!candidate) throw new Problem(PROBLEM_CODE.notFound, 'Placement does not belong to task', undefined, { reason: { kind: 'placement_does_not_belong_task' } });
      this.requireProfile(candidate.profileKey);
      return setResponsibleReceiptSchema.parse(store.setResponsible(input.placementId, input.expectedPlacementRevision,
        result => handover(record('responsible_changed', result.placement, 'responsible'))));
    });
  }
  release(input: ReleaseAgentInput, actor: TaskActor) {
    return this.write(input.taskId, input.expectedTaskHash, actor, ({ store, record }) => {
      const candidate = store.placements(input.taskId).find(item => item.id === input.placementId);
      if (!candidate) throw new Problem(PROBLEM_CODE.notFound, 'Placement does not belong to task', undefined, { reason: { kind: 'placement_does_not_belong_task' } });
      return releaseAgentReceiptSchema.parse({ placement: store.release(input.placementId, input.expectedPlacementRevision,
        result => record(candidate.responsible ? 'responsible_changed' : 'placement_changed', result, 'released')) });
    });
  }
  placeMember(input: PlaceMemberInput, actor: TaskActor) {
    return this.withResponsibleAt(input, actor, ({ store, record }) => {
      this.requireProfile(input.profileKey, input.selected);
      if (input.agentId === undefined)
        return placeMemberReceiptSchema.parse(store.createAndPlace({ taskId: input.taskId,
          profileKey: input.profileKey, responsible: false }, result =>
          record('placement_changed', result.placement, 'member', input.selected ?? {})));
      const agent = store.agents().find(item => item.id === input.agentId);
      if (!agent) throw new Problem(PROBLEM_CODE.notFound, 'Agent does not exist', undefined, { reason: { kind: 'agent_does_not_exist' } });
      const placement = store.place({ taskId: input.taskId, agentId: agent.id,
        profileKey: input.profileKey, responsible: false }, result => record('placement_changed', result, 'member', input.selected ?? {}));
      return placeMemberReceiptSchema.parse({ agent, placement });
    });
  }
  releaseMember(input: ReleaseMemberInput, actor: TaskActor) {
    return this.withResponsibleAt(input, actor, ({ store, record }) => {
      const placement = store.placements(input.taskId).find(item => item.id === input.placementId);
      if (!placement || !placement.active || placement.responsible)
        throw new Problem(PROBLEM_CODE.forbidden, 'Only an active member on this task can be released', undefined,
          { reason: { kind: 'only_active_member_on_task_can_released' } });
      return releaseMemberReceiptSchema.parse({ placement: store.release(placement.id, input.expectedPlacementRevision,
        result => record('placement_changed', result, 'released')) });
    });
  }
}
