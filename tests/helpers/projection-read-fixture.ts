/** In-memory records for read-boundary tests; no store, filesystem, agents or live workspace. */
import { DEFAULT_FIELDS, DEFAULT_SCHEMA, fieldCatalog } from '@alpacawork/contract';
import { initialControlDocument, type ControlTask, type TaskLog } from '@alpacawork/raw';
import { taskRowFields, taskViewRowSchema, type ProjectionVersion } from '@alpacawork/contract/control';
import { ProjectShelf } from '@alpacawork/backend/test-dist/control/project-shelf.js';
import { controlTaskView } from '@alpacawork/backend/test-dist/control/task-dto.js';
import type { RecordsReader, TaskBundle, PublishedFrame, ScreenAggregate, TaskDerived } from '../../apps/backend/src/receiver/projection-contract.js';

export const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString();
export const pv = (value: number) => value as ProjectionVersion;
export const entry = (id: string, n: number, fields: Partial<TaskLog> = {}): TaskLog => ({ id, at: at(n), kind: 'reported',
  actor: { kind: 'human' }, fromState: null, toState: null, title: id, description: null, ...fields });
export function bundle(id: string, parent = 'P1', log: TaskLog[] = [], fields: Partial<ControlTask['meta']> = {}): TaskBundle {
  const kind = id.startsWith('P') ? 'project' : 'task';
  const task: ControlTask = { id, path: `tasks/${id}`, meta: initialControlDocument(id, id === 'P1' ? null : parent, `Title ${id}`,
    { kind, userRequested: kind === 'task', actor: { kind: 'human' } }), values: {}, hash: '1'.repeat(64),
    settings: kind === 'project' ? { color: '#39659b' } : null };
  Object.assign(task.meta, { log }, fields);
  return { task, placements: [], runs: [], requests: [], returns: [], headRunIds: new Map(), resultStates: new Map(),
    waitCycles: [], inputs: { uncertain: new Map(), closed: new Set() }, after: [], dialogues: [], answerTexts: {},
    requestedByUser: null, files: [] };
}

const environment = { root: '/synthetic-projection-read', profiles: [], attachmentBytes: 1024, errors: [], writable: true };

export class FakeRecords implements RecordsReader {
  readonly bundles: Map<string, TaskBundle>;
  readonly catalogValue = fieldCatalog(DEFAULT_FIELDS);
  readonly schema = { fields: [...DEFAULT_SCHEMA], from: null };
  readonly environmentValue = environment;
  readonly shelfValue: ProjectShelf;
  readonly pv: ProjectionVersion;
  constructor(items: TaskBundle[], version: ProjectionVersion = pv(1)) {
    this.pv = version;
    this.bundles = new Map(items.map(item => [item.task.id, item]));
    this.shelfValue = new ProjectShelf(items.filter(item => item.task.meta.kind === 'project').map(item => item.task));
  }
  taskIds() { return this.bundles.keys(); }
  bundle(id: string) { return this.bundles.get(id); }
  run(id: string) { return [...this.bundles.values()].flatMap(bundle => bundle.runs).find(run => run.id === id); }
  parent(id: string) { return this.bundle(id)?.task.meta.parentId ?? null; }
  children(id: string) { return [...this.bundles.values()].filter(bundle => bundle.task.meta.parentId === id).map(bundle => bundle.task.id); }
  ancestors(id: string) { const ids: string[] = []; let parent = this.parent(id); while (parent) { ids.push(parent); parent = this.parent(parent); } return ids; }
  *subtree(id: string): Iterable<string> { yield id; for (const child of this.children(id)) yield* this.subtree(child); }
  projectOf(id: string): string {
    if (this.bundle(id)?.task.meta.kind === 'project') return id;
    return this.ancestors(id).find(key => this.bundle(key)?.task.meta.kind === 'project')!;
  }
  scopes(id: string) { return ['root', ...[id, ...this.ancestors(id)].reverse().filter(key => this.bundle(key)?.task.meta.kind === 'project')]; }
  logOwner(id: string) { return [...this.bundles.values()].find(bundle => bundle.task.meta.log.some(log => log.id === id))?.task.id; }
  runOwner(id: string) { return this.run(id)?.task ?? null; }
  requestOwner(id: string) { return [...this.bundles.values()].find(bundle => bundle.requests.some(request => request.id === id))?.task.id ?? null; }
  placementOwner(id: string) { return [...this.bundles.values()].find(bundle => bundle.placements.some(placement => placement.id === id))?.task.id; }
  returnOwner(id: string) { return [...this.bundles.values()].find(bundle => bundle.returns.some(row => row.id === id))?.task.id; }
  dependents() { return []; }
  runByRequest(id: string) { return [...this.bundles.values()].flatMap(bundle => bundle.runs).find(run => run.requestId === id)?.id; }
  runReferrers() { return []; }
  sendersTo() { return []; }
  targetsFromAll() { return []; }
  sentRequests() { return []; }
  closedRequest() { return false; }
  returnsByCauseTask(id: string) {
    return [...this.bundles.values()].filter(bundle => bundle.returns.some(row => row.causeLogId && this.logOwner(row.causeLogId) === id)).map(bundle => bundle.task.id);
  }
  deliveriesByWakeRequest() { return []; }
  questionsByDestination() { return []; }
  dialogueTasks() { return []; }
  joinedMessages() { return []; }
  messageTasks() { return []; }
  placementWritesTo() { return []; }
  historyReferrers() { return []; }
  schemaUsers() { return []; }
  fieldUsers() { return []; }
  coordinatorRun() { return undefined; }
  catalog() { return this.catalogValue; }
  schemaOf() { return this.schema; }
  seatSettings(): ReturnType<RecordsReader['seatSettings']> { throw new Error('A read does not evaluate seat settings'); }
  shelf() { return this.shelfValue; }
  environment() { return this.environmentValue; }
}

export const emptyAggregate: ScreenAggregate = {
  children: () => undefined, movedAt: () => 0, usageBelow: () => null, runsBelow: () => [], runningRuns: () => 0,
  workingBelow: () => 0, live: () => true, home: () => undefined, homeAfter: () => undefined, page: () => [],
  counts: () => ({ closed: {}, home: {}, tasks: {}, all: { turn: 0, running: 0 } }),
};

export function frame(records: FakeRecords, options: Partial<PublishedFrame> = {}): PublishedFrame {
  const derived = new Map<string, TaskDerived>();
  for (const [id, bundle] of records.bundles) {
    const base = taskRowFields({ ...controlTaskView(bundle.task), files: [] });
    const { usageBelow: _usageBelow, runsBelow: _runsBelow, ...own } = base;
    derived.set(id, { id, row: taskViewRowSchema.parse({ ...own, projectId: records.projectOf(id), ball: null,
      startOrder: null, question: '', notice: { ...base.notice, turnKey: null } }), ball: null,
      placements: [], runs: [], live: { placements: new Set(), runs: new Set() }, pushKeys: [],
      contribution: { id, parentId: bundle.task.meta.parentId, projectId: records.projectOf(id), kind: bundle.task.meta.kind,
        lifecycle: bundle.task.meta.lifecycle, state: bundle.task.meta.state, baseState: bundle.task.meta.baseState,
        hold: bundle.task.meta.hold, ball: null, running: false, working: false, homeWorking: false, usage: null, openRuns: [], movedAt: 0 } });
  }
  return { generation: 'g', pv: records.pv, applied: 0 as PublishedFrame['applied'], records, derived: id => derived.get(id),
    aggregate: emptyAggregate, requiredPv: { view: {}, history: {}, page: {}, search: {}, timeline: {} }, patch: null, ...options };
}
