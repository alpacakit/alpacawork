/**
 * Records for the screen projection's rules, made from Task bundles: every reverse index is found by scanning the
 * bundles, the plain reading of the dependency ledger, so a test does not depend on how the real records index them.
 */
import { createHash } from 'node:crypto';
import type { ControlTask, TaskLog } from '@alpacawork/raw';
import type { RunRecord } from '@alpacawork/contract/run';
import { hasRequesterSeat, isSeatContinuation } from '@alpacawork/contract';
import type { StoredPlacement, StoredRequest, StoredReturn } from '@alpacawork/runs';
import type { ProjectionVersion } from '@alpacawork/contract/control';
import type { RecordsReader, TaskBundle } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
import { record } from '../runs-fixtures.ts';

export const time = (minute: number) => `2026-10-19T09:${String(minute).padStart(2, '0')}:00.000Z`;
export const entry = (id: string, minute: number, fields: Partial<TaskLog> = {}): TaskLog => ({ id, kind: 'linked', at: time(minute),
  title: null, description: null, actor: { kind: 'placement', placementId: 'PL-x' }, fromState: null, toState: null, ...fields });
export function task(id: string, fields: Partial<ControlTask['meta']> = {}): ControlTask {
  const state = fields.state ?? 'doing';
  return { id, path: `tasks/${id}`, values: {}, settings: null, hash: createHash('sha256').update(id).digest('hex'),
    meta: { format: 3n, id, kind: 'task', parentId: 'P1', lifecycle: 'active', title: id, version: 1n,
      baseState: fields.baseState ?? (state === 'held' ? 'doing' : state), hold: fields.hold ?? state === 'held', state,
      userRequested: false, log: [], ...fields } };
}
export const project = (id = 'P1') => task(id, { kind: 'project', parentId: null, state: 'todo' });
export const placement = (id: string, taskId: string, fields: Partial<StoredPlacement> = {}): StoredPlacement =>
  ({ id, taskId, agentId: `A-${id}`, profileKey: 'fake', responsible: true, active: true, revision: 1, startedAt: time(0), endedAt: null, ...fields });
export const run = (id: string, taskId: string, placementId: string, fields: Partial<RunRecord> = {}): RunRecord =>
  record(id, { task: taskId, placementId, requestId: `Q-${id}`, ...fields });
export const request = (id: string, taskId: string, placementId: string, fields: Partial<StoredRequest> = {}): StoredRequest =>
  ({ id, taskId, placementId, placementRevision: 1, taskHash: 'h', waitCycleId: null, headRunId: null, aboutRunId: null, mode: 'continue',
    body: id, purpose: 'instruction', author: { kind: 'human' }, submittedAt: time(1), deliveryState: 'queued', runId: null, ...fields });
export const returned = (id: string, toTaskId: string, fields: Partial<StoredReturn> = {}): StoredReturn =>
  ({ id, requestId: null, outcome: 'question', toTaskId, boundaryRunId: null, causeLogId: null, holdReason: null, holdProblemReason: null,
    createdAt: time(2), deliveries: [], resolution: null, ...fields });

export function bundle(of: ControlTask, parts: Partial<Omit<TaskBundle, 'task'>> = {}): TaskBundle {
  return { task: of, placements: [], runs: [], resultStates: new Map(), headRunIds: new Map(), requests: [], returns: [],
    waitCycles: [], inputs: { uncertain: new Map(), closed: new Set() }, after: [], dialogues: [], answerTexts: {},
    requestedByUser: null, files: [], ...parts };
}

/** What the bundles alone do not say: the coordinator's links, the History references and the schema users. */
export type Extras = { dialogueTasks?: Record<string, string[]>; joinedMessages?: Record<string, string[]>;
  messageTasks?: Record<string, string[]>; historyReferrers?: Record<string, string[]>; schemaUsers?: Record<string, string[]>;
  fieldUsers?: Record<string, string[]> };

export function records(bundles: readonly TaskBundle[], extras: Extras = {}): RecordsReader {
  const byId = new Map(bundles.map(item => [item.task.id, item]));
  const all = () => [...byId.values()];
  const runs = () => all().flatMap(item => item.runs);
  const requests = () => all().flatMap(item => item.requests);
  const returns = () => all().flatMap(item => item.returns);
  const parent = (id: string) => byId.get(id)?.task.meta.parentId ?? null;
  const ancestors = (id: string) => { const up: string[] = []; for (let at = parent(id); at !== null; at = parent(at)) up.push(at); return up; };
  const children = (id: string) => all().filter(item => item.task.meta.parentId === id).map(item => item.task.id);
  const subtree = (id: string): string[] => [id, ...children(id).flatMap(subtree)];
  const kind = (id: string) => byId.get(id)?.task.meta.kind;
  const runOwner = (id: string) => runs().find(item => item.id === id)?.task ?? null;
  const callerTask = (item: StoredRequest) => {
    const caller = runs().find(each => each.requestId === item.id)?.caller?.run;
    return caller === undefined ? null : runOwner(caller);
  };
  const closed = (id: string) => returns().some(row => row.requestId === id);
  const logOwner = (id: string) => all().find(item => item.task.meta.log.some(log => log.id === id))?.task.id;
  const list = (map: Record<string, string[]> | undefined, key: string) => map?.[key] ?? [];
  const unique = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((id): id is string => !!id))];
  return {
    pv: 0 as ProjectionVersion,
    taskIds: () => byId.keys(),
    bundle: id => byId.get(id),
    run: id => runs().find(item => item.id === id),
    parent, children, ancestors, subtree,
    projectOf: id => [id, ...ancestors(id)].find(each => kind(each) === 'project') ?? id,
    scopes: id => ['root', ...[id, ...ancestors(id)].filter(each => kind(each) === 'project').reverse()],
    logOwner, runOwner,
    requestOwner: id => requests().find(item => item.id === id)?.taskId ?? null,
    placementOwner: id => all().find(item => item.placements.some(each => each.id === id))?.task.id,
    returnOwner: id => returns().find(row => row.id === id)?.toTaskId,
    dependents: id => all().filter(item => item.after.includes(id)).map(item => item.task.id),
    runByRequest: id => runs().find(item => item.requestId === id)?.id,
    runReferrers: id => runs().filter(item => item.caller?.run === id || item.resumes === id || item.into === id).map(item => item.id),
    sendersTo: id => unique(requests().filter(item => item.taskId === id && item.purpose !== 'return_continuation' && !closed(item.id)).map(callerTask)),
    targetsFromAll: id => unique(requests().filter(item => callerTask(item) === id).map(item => item.taskId)),
    sentRequests: id => requests().filter(item => !isSeatContinuation(item.purpose) && hasRequesterSeat(item) && callerTask(item) === id),
    closedRequest: closed,
    returnsByCauseTask: id => unique(returns().filter(row => row.causeLogId !== null && logOwner(row.causeLogId) === id).map(row => row.toTaskId)),
    deliveriesByWakeRequest: id => returns().filter(row => row.deliveries.some(each => each.wakeRequestId === id)).map(row => row.id),
    questionsByDestination: id => all().filter(item => item.task.meta.log.some(log => log.kind === 'asked' && log.askedTo === id)).map(item => item.task.id),
    dialogueTasks: id => list(extras.dialogueTasks, id),
    joinedMessages: id => list(extras.joinedMessages, id),
    messageTasks: id => list(extras.messageTasks, id),
    placementWritesTo: id => unique(all().filter(item => item.task.meta.log.some(log => log.actor.kind === 'placement' && log.actor.placementId === id)
      && !item.placements.some(each => each.id === id)).map(item => item.task.id)),
    historyReferrers: id => list(extras.historyReferrers, id),
    schemaUsers: id => list(extras.schemaUsers, id),
    fieldUsers: id => list(extras.fieldUsers, id),
    coordinatorRun: () => undefined,
    catalog: () => new Map(),
    schemaOf: () => ({ fields: [], from: null }),
    seatSettings: () => ({ profiles: new Set(['fake']), automaticLimit: 20 }),
    shelf: () => { throw new Error('No shelf in these records'); },
    environment: () => ({ root: '/workspace', profiles: [], attachmentBytes: 0, errors: [], writable: true }),
  };
}

/** The same bundles with some replaced: the others keep their objects, as records that kept their rows do. */
export function replace(bundles: readonly TaskBundle[], ...next: TaskBundle[]): TaskBundle[] {
  const changed = new Map(next.map(item => [item.task.id, item]));
  return [...bundles.map(item => changed.get(item.task.id) ?? item), ...next.filter(item => !bundles.some(each => each.task.id === item.task.id))];
}
