import { assertDependencyAcyclic, dependencyStatus, replaceDependencies } from './dependencies.js';
import { taskShelfIn } from './project-shelf.js';
import { expireInvalidDestinations } from './task-questions.js';
import { controlTaskHead } from './task-dto.js';
/**
 * The structure commands: a Task's creation, its title, values and mark, a project's settings and schema, its move, its archive,
 * deletion and restore. Who may make each is authorize's, so they take the actor it decided and check only the Tasks'
 * facts. Each is one write whose records go through TaskTransition (a creation through TaskRepository.create), which
 * also sends back the ancestors the change reopens.
 */
import { randomUUID } from 'node:crypto';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { initialControlDocument, now, validateTaskSettings, type ControlTask, type TaskActor, type TaskKind,
  type TaskLog } from '@alpacawork/raw';
import { awaitsReview } from '@alpacawork/contract';
import { taskAtWork, PlacementStore } from './placements.js';
import { ownSchema, patchedValues, readTaskFields, schemaAlong, schemaFor, writeProjectSchema } from './task-values-store.js';
import { TaskRepository, TaskTree, assertActive, assertAtHash, type ControlSnapshot } from './task-store.js';
import { TaskTransition, returnsAt, withControlWrite, type ControlTx } from './task-transition.js';

const TASK_PARENT = 'A task needs a parent: its project or a task of that project';
/** One Task to create: its title and the values it starts with (a write's values, checked against its schema). */
type TaskDraft = { title: string; values?: unknown };
/** What each lifecycle action makes the Task, and the record it writes. */
const LIFECYCLE = {
  archive: { lifecycle: 'archived', record: 'archived' },
  delete: { lifecycle: 'deleted', record: 'deleted' },
  restore: { lifecycle: 'active', record: 'restored' },
} as const;

function find(snapshot: ControlSnapshot, id: string, expectedHash?: string): ControlTask {
  const task = snapshot.tasks.find(item => item.id === id);
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
  return checkedTask(task, expectedHash);
}
function checkedTask(task: ControlTask, expectedHash?: string): ControlTask {
  if (expectedHash) assertAtHash(task, expectedHash);
  return task;
}
/**
 * The responsible seat invariant (PlacementStore.uncoveredTasks) after a change that gives a task a child or brings its
 * work back: refused until each of these tasks that needs a responsible has one.
 */
function assertCovered(tx: ControlTx, taskIds: readonly string[]): void {
  const uncovered = new PlacementStore(tx.store.root, false, tx.store.connection).uncoveredTasks(taskIds)
    .map(task => task.taskId);
  if (uncovered.length) throw new Problem(PROBLEM_CODE.responsibleMissing, `Assign a responsible to ${uncovered.join(', ')} first: a task with children or work under way has one`, { tasks: uncovered },
    { reason: { kind: 'assign_responsible_first_task_with_children_or_work_under_way_has_one', tasks: String(uncovered.join(', ')) } });
}

/** The mark belongs only to a Task immediately below a project. Reads deliberately accept old marks. */
function markFits(parentKind: TaskKind, mark: boolean): void {
  if (mark && parentKind !== 'project')
    throw new Problem(PROBLEM_CODE.invalidInput,
      'The user request mark belongs only to a Task below a project. Children are created by their parent’s responsible; ask that responsible for additional results with task request',
      undefined, { reason: { kind: 'user_request_belongs_to_top' } });
}

function mayRemoveMark(task: ControlTask): void {
  if (awaitsReview(task.meta))
    throw new Problem(PROBLEM_CODE.conflict, `${task.id} awaits the user's review: confirm it or send it back first`, { task: task.id },
      { reason: { kind: 'awaits_user_s_review_confirm_it_or_send_it_back_first', task: task.id } });
}

export class ControlTaskCommands {
  private readonly transition = new TaskTransition();
  /** `actor` is the one authorize decided for the command; nothing here asks who may make it. */
  constructor(readonly root: string, readonly actor: TaskActor) {}

  /** One write: the Task store and the Run store's transaction on the same connection, as TaskTransition takes them. */
  private write<T>(execute: (writer: TaskRepository, tx: ControlTx) => T): Promise<T> {
    return Promise.resolve().then(() => withControlWrite(this.root, (tx, db) => execute(new TaskRepository(this.root, db), tx)));
  }
  /** One write about Task `id`, reading the project it belongs to (`TaskRepository.projectFor`); returns its view. */
  private change(id: string, mutate: (writer: TaskRepository, tx: ControlTx, snapshot: ControlSnapshot) => void,
    extra: readonly string[] = []) {
    return this.write((writer, tx) => {
      const snapshot = writer.related(id, extra);
      mutate(writer, tx, snapshot);
      return { task: controlTaskHead(writer.get(id)), shelf: taskShelfIn(tx.store.connection, id) };
    });
  }
  /** A record of this command's actor that keeps the Task's state. */
  private record(kind: TaskLog['kind'],
    fields: Pick<TaskLog, 'formerAncestors' | 'runIds' | 'userRequested'> = {}): TaskLog {
    return { id: `L${randomUUID()}`, kind, at: now(), title: null, description: null, actor: this.actor,
      fromState: null, toState: null, ...fields };
  }
  /**
   * Creates `tasks` as siblings under one parent in one write (one Task, or a --plan-file's), all with one mark of the
   * user's request: a Run's are not; a person's are unless --no-from-user; the coordinator names it (authorize refuses its
   * creation without --from-user or --no-from-user); a project never is. A project's parent is a project or none; a task's
   * is a project or a task, and it belongs to that project or to that task's. A Task created without a parent got its
   * default from the entry (`defaultParentAt`). Only the parent’s responsible Run creates its unmarked children.
   */
  create(input: { kind?: TaskKind; color?: string; parentId: string | null; userRequested: boolean | null; tasks: readonly TaskDraft[];
    expectedParentHash?: string }) {
    const kind = input.kind ?? 'task';
    const settings = validateTaskSettings(kind, input.color === undefined ? null : { color: input.color });
    if (kind === 'task' && input.parentId === null)
      throw new Problem(PROBLEM_CODE.invalidInput, TASK_PARENT, undefined,
        { reason: { kind: 'task_needs_parent_project_or_task_project' }, issues: [{ path: 'parent', code: 'required', message: '--parent is required' }] });
    const userRequested = kind === 'task' && (input.userRequested ?? this.actor.kind === 'human');
    return this.write((writer, tx) => {
      const parent = input.parentId === null ? null : checkedTask(writer.get(input.parentId), input.expectedParentHash);
      if (parent) assertActive(parent);
      if (kind === 'project' && parent && parent.meta.kind !== 'project')
        throw new Problem(PROBLEM_CODE.invalidInput, `A project's parent is a project; ${parent.id} is a task`, undefined,
          { reason: { kind: 'project_s_parent_project_task', parent: String(parent.id) } });
      const depth = parent ? new TaskTree(writer.branch(writer.projectFor(parent.id))).depth(parent.id) + 1 : 1;
      if (depth > 32) throw new Problem(PROBLEM_CODE.tooDeep, 'Logical task depth exceeds 32 levels', undefined, { reason: { kind: 'logical_task_depth_exceeds_32_levels' } });
      if (kind === 'task') markFits(parent!.meta.kind, userRequested);
      // A new task takes its parent's schema; a project has a fixed schema for its own values.
      const fields = readTaskFields(tx.store.connection);
      const schema = ownSchema(kind, schemaAlong(parent ? writer.ancestry(parent.id) : [], fields.schemas));
      const ids = input.tasks.map(draft => writer.create(kind, id => {
        const meta = initialControlDocument(id, parent?.id ?? null, draft.title, { kind, userRequested, actor: this.actor });
        const values = draft.values === undefined ? {} : patchedValues(id, {}, draft.values, schema, fields.catalog);
        return { meta, values, ...(settings === null ? {} : { settings }) };
      }));
      if (parent?.meta.kind === 'task') assertCovered(tx, [parent.id]);
      // Also refuses a new Task below a finished one (the finished-branch rule).
      for (const id of ids) this.transition.reopenAncestors(tx, { taskId: id, kind: 'created' });
      return { tasks: ids.map(id => controlTaskHead(writer.get(id))) };
    });
  }
  /** A task moves within its project, below a parent that keeps its responsible; a project does not move. */
  move(input: { id: string; parentId: string | null; expectedTaskHash: string }) {
    return this.change(input.id, (writer, tx, snapshot) => {
      const task = find(snapshot, input.id, input.expectedTaskHash); assertActive(task);
      if (task.meta.kind === 'project') throw new Problem(PROBLEM_CODE.invalidInput, `${task.id} is a project; a project does not move`, undefined,
        { reason: { kind: 'project_project_does_not_move', task: String(task.id) } });
      if (input.parentId === null) throw new Problem(PROBLEM_CODE.invalidInput, TASK_PARENT, undefined, { reason: { kind: 'task_needs_parent_project_or_task_project' } });
      const tree = new TaskTree(snapshot.tasks), project = tree.owningProject(task.id);
      // The snapshot holds every project and this project's tasks, so a parent missing from it is another project's task.
      const parent = snapshot.tasks.find(item => item.id === input.parentId);
      if (!parent) writer.get(input.parentId);
      if (!parent || tree.owningProject(parent.id) !== project)
        throw new Problem(PROBLEM_CODE.invalidInput, `${task.id} moves only within its project ${project}`, undefined,
          { reason: { kind: 'moves_only_within_project', task: String(task.id), project: String(project) } });
      assertActive(parent);
      if (parent.id === task.id) throw new Problem(PROBLEM_CODE.conflict, 'A task cannot parent itself', undefined, { reason: { kind: 'task_cannot_parent_itself' } });
      if (task.meta.parentId === parent.id) return;
      if (tree.descendants(task.id).some(child => child.id === parent.id))
        throw new Problem(PROBLEM_CODE.conflict, 'Logical parent cycle', undefined, { reason: { kind: 'logical_parent_cycle' } });
      const depth = tree.depth(parent.id) + 1;
      if (depth + tree.height(task.id) - 1 > 32)
        throw new Problem(PROBLEM_CODE.tooDeep, 'Logical task depth exceeds 32 levels', undefined, { reason: { kind: 'logical_task_depth_exceeds_32_levels' } });
      const unmark = parent.meta.kind === 'task' && task.meta.userRequested;
      if (unmark) mayRemoveMark(task);
      markFits(parent.meta.kind, unmark ? false : task.meta.userRequested);
      const moved = this.record('moved', { formerAncestors: tree.ancestors(task.id).map(ancestor => ancestor.id) });
      this.transition.appendRecords(tx, task.id,
        [moved, ...(unmark ? [this.record('user_request_changed', { userRequested: false })] : [])], undefined,
        { parentId: parent.id });
      assertDependencyAcyclic(tx.store.connection);
      if (parent.meta.kind === 'task') {
        const responsible = tx.runs.responsiblePlacements(project, [parent.id])[0];
        if (this.actor.kind !== 'placement' || this.actor.placementId !== responsible?.id)
          returnsAt(tx, parent.id).notice('work_changed', parent.id, moved.id);
      }
      expireInvalidDestinations(tx, [task.id, ...tree.descendants(task.id).map(child => child.id)], this.actor);
      assertCovered(tx, [parent.id]);
    }, input.parentId === null ? [] : [input.parentId]);
  }
  /**
   * An archived project keeps everything below it as it is, so nothing there may still be at work. A task is archived
   * or deleted with no child left and no Run unfinished. A restored Task comes back below an active parent, and both
   * keep their responsible.
   */
  lifecycle(input: { id: string; action: 'archive' | 'delete' | 'restore'; expectedTaskHash: string }) {
    return this.change(input.id, (writer, tx, snapshot) => {
      const task = find(snapshot, input.id, input.expectedTaskHash);
      const { lifecycle, record } = LIFECYCLE[input.action];
      if (task.meta.lifecycle === lifecycle) return;
      if (input.action === 'restore') {
        if (task.meta.parentId) assertActive(find(snapshot, task.meta.parentId));
      } else if (input.action === 'archive' && task.meta.kind === 'project') {
        assertActive(task);
        // Below a project are nested projects and their Tasks, which the project's own snapshot does not hold.
        const below = [task, ...new TaskTree(writer.branch()).descendants(task.id)];
        const working = below.filter(item => {
          if (item.meta.lifecycle !== 'active') return false;
          const meta = item.meta.baseState === 'waiting'
            ? writer.get(item.id).meta : { ...item.meta, log: [] };
          // A review still needs the user even when its snapshot needs no responsible seat.
          return taskAtWork(meta) || awaitsReview(meta);
        })
          .map(item => item.id);
        if (working.length) throw new Problem(PROBLEM_CODE.conflict, `Tasks below ${task.id} are still at work (${working.join(', ')})`, { tasks: working },
          { reason: { kind: 'tasks_below_still_at_work', task: String(task.id), working: String(working.join(', ')) } });
        const runs = tx.runs.unfinishedIn(below.map(item => item.id));
        if (runs.length) throw new Problem(PROBLEM_CODE.conflict, 'Task has unfinished runs', { runs }, { reason: { kind: 'task_has_unfinished_runs' } });
      } else {
        assertActive(task);
        if (new TaskTree(snapshot.tasks).children(task.id).some(child => child.meta.lifecycle !== 'deleted'))
          throw new Problem(PROBLEM_CODE.conflict, 'Task has active children', undefined, { reason: { kind: 'task_has_active_children' } });
        const runs = tx.runs.unfinishedIn([task.id]);
        if (runs.length) throw new Problem(PROBLEM_CODE.conflict, 'Task has unfinished runs', { runs }, { reason: { kind: 'task_has_unfinished_runs' } });
      }
      this.transition.appendRecord(tx, task.id, this.record(record), undefined, { lifecycle });
      if (input.action === 'restore')
        assertCovered(tx, task.meta.parentId === null ? [task.id] : [task.id, task.meta.parentId]);
    });
  }
  /**
   * Changes a Task's title or values (only the fields the write names, checked against the fields of its own values: a
   * project's policy, or the schema a task uses), a project's color, or the mark of the user's request, one record each
   * in one Task save; one body_updated record keeps who changed the values. A mark set false while the Task awaits the user's review is refused (the review is confirmed or sent back
   * first); a mark change keeps the state and the askedTo of open questions, and one that changes nothing writes
   * nothing. An update that changes none of these (a project's code location alone, kept outside the database) writes
   * nothing.
   */
  update(input: { id: string; title?: string; values?: unknown; color?: string; userRequested?: boolean;
    expectedTaskHash: string }) {
    return this.change(input.id, (_, tx, snapshot) => {
      const task = find(snapshot, input.id, input.expectedTaskHash); assertActive(task);
      if (input.color !== undefined) validateTaskSettings(task.meta.kind, { ...task.settings, color: input.color });
      if (input.userRequested !== undefined && task.meta.kind === 'project')
        throw new Problem(PROBLEM_CODE.invalidInput, `${task.id} is a project; only a task is the user's request`, undefined,
          { reason: { kind: 'project_only_task_user_s_request', task: String(task.id) } });
      const mark = input.userRequested === task.meta.userRequested ? undefined : input.userRequested;
      if (input.userRequested === true) markFits(find(snapshot, task.meta.parentId!).meta.kind, true);
      if (mark === false) mayRemoveMark(task);
      const { title } = input;
      const tree = new TaskTree(snapshot.tasks);
      const values = input.values === undefined ? undefined
        : patchedValues(task.id, task.values, input.values, schemaFor(tree, snapshot.fields.schemas, task.id), snapshot.fields.catalog);
      const settings = input.color === undefined ? undefined : { ...task.settings!, color: input.color };
      const records: TaskLog[] = [];
      if (title !== undefined) records.push(this.record('retitled'));
      if (values !== undefined || settings !== undefined) records.push({ ...this.record('body_updated'),
        changedFields: [...(values === undefined ? [] : ['values' as const]),
          ...(settings === undefined ? [] : ['color' as const])] });
      if (mark !== undefined) records.push(this.record('user_request_changed', { userRequested: mark }));
      if (records.length) this.transition.appendRecords(tx, task.id, records, undefined, { title, values, settings });
    });
  }
  /**
   * Replaces a project's own schema (task-values-store writeProjectSchema), or with null makes it inherit, and records
   * it as a change of the project's settings (body_updated, changed field `schema`), so launches carry the new order.
   * The project's own values stay available in project settings regardless of the fields its Tasks use.
   */
  setSchema(input: { task: string; fields: readonly string[] | null; expectedTaskHash: string }) {
    return this.change(input.task, (_, tx, snapshot) => {
      const task = find(snapshot, input.task, input.expectedTaskHash); assertActive(task);
      writeProjectSchema(tx.store.connection, task.id, input.fields);
      this.transition.appendRecord(tx, task.id, { ...this.record('body_updated'), changedFields: ['schema'] });
    });
  }
  /** Execution-order rules and storage belong to dependencies; the structure command records their History. */
  dependencies(input: { task: string; after: readonly string[]; expectedTaskHash: string }) {
    return this.write((writer, tx) => {
      const change = replaceDependencies(tx.store.connection, input);
      if (change.changed) this.transition.appendRecord(tx, input.task, {
        ...this.record('dependencies_changed'), dependencies: { after: [...input.after], previous: change.previous },
      });
      return { task: controlTaskHead(writer.get(input.task)), dependencies: dependencyStatus(tx.store.connection, input.task) };
    });
  }
  /** Records on Task `id` the Runs a run stop stopped, after the Run store took the stop. */
  recordRunStop(input: { id: string; runIds: string[] }) {
    return this.write((writer, tx) => {
      this.transition.appendRecord(tx, input.id, this.record('run_stop_requested', { runIds: input.runIds }));
      return { task: controlTaskHead(writer.get(input.id)) };
    });
  }
}
