import type { Ball } from "@alpacawork/contract";
import type { Task, TaskState } from "@/data/types";
import type { TaskIndex } from "@/domain/tasks";

/**
 * A task's start order as the screen says it. The server owns which tasks a task starts after and whether it still
 * waits (dependencies.ts, on the row's `startOrder`); this file only orders what the person reads first: what waits on
 * them, then what has stopped and will not finish by itself, then what is still at work.
 */
type LinkedTask = { id: string; title: string; state: TaskState; ball: Ball | null };
/** A prerequisite has the server's same-read completion verdict; a follower only supplies display facts. */
export type WaiterItem = LinkedTask & { kind: "waiter" };
export type OrderItem = LinkedTask & { kind: "prerequisite"; finished: boolean;
  /** turn: it waits on the reader; stuck: it will not finish by itself (failed or held); moving: it is on its way. */
  urge: "turn" | "stuck" | "moving" | null };

const URGE_RANK = { turn: 0, stuck: 1, moving: 2 } as const;
/** Reading order for every prerequisite list, including those already finished. */
export const byOrderAttention = (a: OrderItem, b: OrderItem) =>
  (a.finished ? 3 : URGE_RANK[a.urge ?? "moving"]) - (b.finished ? 3 : URGE_RANK[b.urge ?? "moving"]);

function item(id: string, read: { title: string; state: string; finished: boolean }, index: TaskIndex): OrderItem {
  // The state and whether it has finished are the server's, from the same read as the row that names them; the live row
  // of the same index gives only whose move it is, and only while it says the same state.
  const live = index.byId.get(id);
  const state = read.state as TaskState, ball = live?.state === state ? live.ball : null;
  const finished = read.finished;
  // A failed or held task waits on the reader too, but it says first that it will not finish by itself. Only the
  // server's ball says the reader's move: a task waiting for an answer from an agent above it is on its way.
  const urge = finished ? null : state === "error" || state === "held" ? "stuck"
    : ball?.holder === "user" ? "turn" : "moving";
  return { kind: "prerequisite", id, title: live?.title ?? read.title, state, ball, finished, urge };
}

export type StartOrder = {
  /** Every task it starts after, in ID order. */
  after: OrderItem[];
  /** Those it still waits for, the one to look at first. Empty once it has started. */
  waitingFor: OrderItem[];
  started: boolean;
};

export function startOrderOf(task: Pick<Task, "id" | "startOrder">, index: TaskIndex): StartOrder | null {
  // The index's row, not an opened task's: the reader keeps a task as of its own version, which a change of the tasks
  // it waits for does not move.
  const order = index.byId.has(task.id) ? index.byId.get(task.id)!.startOrder : task.startOrder;
  if (!order || !order.after.length) return null;
  const after = order.after.map(each => item(each.task, each, index));
  const waitingFor = order.waiting ? after.filter(each => !each.finished)
    .sort(byOrderAttention) : [];
  return { after, waitingFor, started: order.started };
}

/** The tasks that still wait for `id` to finish before they start: the other side of the same edges. */
export function waitersOf(id: string, index: TaskIndex): Task[] {
  return index.waitersByTask.get(id) ?? [];
}
