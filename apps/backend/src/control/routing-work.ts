import { liveEndpoints, liveRequestIds } from './live-endpoints.js';
/** Routing owns only the selected seats. Their request endpoints, notice origins and ancestors are read context. */
import type { DatabaseSync } from 'node:sqlite';
import type { RunTransaction, StoredRequest } from '@alpacawork/runs';
import type { RoutingWorkSet } from '../receiver/projection-contract.js';
import { readRoutingTaskSteps } from './task-store.js';
import type { RoutingTask } from './routing-facts.js';
import { finishRoutingRead, type RoutingReadContext, type RoutingReadSteps } from './routing-read-work.js';

export type RoutingTasks = Pick<RoutingWorkSet, 'tasks'>;

/** The project entry points still in use during integration expand once, outside the scoped routing path. */
export function routingTasks(db: DatabaseSync, work: RoutingTasks | string): RoutingTasks {
  if (typeof work !== 'string') return work;
  return { tasks: new Set(db.prepare(`SELECT external_id FROM tasks WHERE project_task_id=
    (SELECT id FROM tasks WHERE external_id=?) ORDER BY number`).all(work).map(row => String(row.external_id))) };
}

/** No descendants: an unchanged child is context only when a selected seat sent it a Request. */
export function routingContext(root: string, db: DatabaseSync, work: RoutingTasks, context?: RoutingReadContext): RoutingTask[] {
  return finishRoutingRead(routingContextSteps(root, db, work, context));
}
export function* routingContextSteps(root: string, db: DatabaseSync, work: RoutingTasks, context?: RoutingReadContext): RoutingReadSteps<RoutingTask[]> {
  if (!work.tasks.size) return [];
  const selected = JSON.stringify([...work.tasks].sort());
  const loadEndpoints = () => liveEndpoints(db, root, [...work.tasks], false);
  const ids = context ? context.get(`routing_endpoints:${selected}`, loadEndpoints) : loadEndpoints();
  yield;
  return yield* readRoutingTaskSteps(db, ids, [...work.tasks], root, context);
}

/** Incoming Requests and those sent by these seats, plus their ancestors' user resets for the automatic limit. */
export function routingRequests(db: DatabaseSync, tx: Pick<RunTransaction, 'getRequests'>, work: RoutingTasks,
  root = ''): StoredRequest[] {
  const ids = liveRequestIds(db, root, [...work.tasks]);
  const requests = tx.getRequests(ids);
  return ids.map(id => requests.get(id)!);
}
