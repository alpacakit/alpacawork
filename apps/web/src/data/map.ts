import type { ProjectedIndexDTO, TaskRowDTO } from "@alpacawork/contract/control";
import type { FirstSeen } from "./notice-model";
import { taskEvents, readTaskIds, type NoticeCheckpoint, type NoticeEvent, type TaskBaseline } from "./notice-model";
import type { ChangeDetail, Task, TaskChange } from "./types";

export type ReadBaselines = {
  checkpoint: NoticeCheckpoint;
  reads: Record<string, TaskBaseline>;
  firstSeen: ReadonlyMap<string, FirstSeen>;
};
const priority = { created: 0, turn: 1, state: 2, reported: 3, body: 4 };
// Index deltas retain untouched rows. Keep their screen projection until either
// the row or the reader's baseline-derived change actually differs.
const projected = new WeakMap<TaskRowDTO, { changeKey: string; task: Task }>();
function changeDetail(event: NoticeEvent): ChangeDetail {
  switch (event.kind) {
    case "created": return { type: "created" };
    case "turn": return { type: "note", text: "" };
    case "state": return { type: "state", from: event.from, to: event.to };
    case "reported": return { type: "note", text: event.line };
    case "body": return { type: "body" };
  }
}

/**
 * The sole index-to-screen projection. Reads never change checkpoint differences.
 * The tree shows active tasks; archived and deleted ones are listed apart
 * (`shelved`), keeping their place in the logical tree.
 */
export function mapWorkspace(index: ProjectedIndexDTO, baselines: ReadBaselines, server: ProjectedIndexDTO | undefined = index, held?: { events: NoticeEvent[]; readIds: Set<string> }) {
  const { checkpoint, reads, firstSeen } = baselines;
  const stale = new Set(index.staleIds);
  const current = (server?.tasks ?? []).filter((task) => !stale.has(task.id));
  const events = server ? taskEvents(current, checkpoint.tasks) : held?.events ?? [];
  const byTask = new Map<string, NoticeEvent>();
  for (const event of events) {
    const previous = byTask.get(event.task.id);
    // Equal priority: the later report (events keep log order) is the current one.
    if (!previous || priority[event.kind] <= priority[previous.kind]) byTask.set(event.task.id, event);
  }
  const toTask = (task: TaskRowDTO): Task => {
    const event = byTask.get(task.id);
    const change: TaskChange | null = event ? {
      kind: event.kind === "created" ? "new" : event.kind === "turn" ? "turn" : event.kind === "state" ? "state" : "content",
      detail: changeDetail(event),
      at: event.at ?? new Date(firstSeen.get(event.id)?.at ?? Date.parse(checkpoint.at)).toISOString(),
    } : null;
    const changeKey = JSON.stringify(change);
    const previous = projected.get(task);
    if (previous?.changeKey === changeKey) return previous.task;
    const mapped = rowTask(task, change);
    projected.set(task, { changeKey, task: mapped });
    return mapped;
  };
  const tasks: Task[] = [];
  const shelved: { task: Task; lifecycle: Exclude<TaskRowDTO["lifecycle"], "active"> }[] = [];
  for (const task of index.tasks) {
    if (task.lifecycle === "active") tasks.push(toTask(task));
    else shelved.push({ task: toTask(task), lifecycle: task.lifecycle });
  }
  return { tasks, shelved, events,
    readIds: server ? new Set([...readTaskIds(current, checkpoint, reads), ...index.staleIds]) : held?.readIds ?? new Set<string>() };
}

/**
 * One row as the screen draws it. The workspace projection maps its current rows so; a list kept as of an earlier time
 * (TimeTree's dated Done rows) maps its own Query's rows so too, without joining the workspace's.
 */
export function rowTask(task: TaskRowDTO, change: TaskChange | null = null): Task {
  return {
    // The list's tree has no project rows: a task right below its project is at the top (null).
    id: task.id, parent: task.kind === "task" && task.parentId === task.projectId ? null : task.parentId, kind: task.kind, projectId: task.projectId, title: task.title, state: task.state,
    baseState: task.baseState, hold: task.hold, allowedActions: task.allowedActions, policyVersion: task.policyVersion,
    ball: task.ball, rowFacts: task.rowFacts, startOrder: task.startOrder ?? null, hash: task.hash, version: task.version, path: task.path, stateLog: task.stateLog, usage: task.usage, usageBelow: task.usageBelow, runsBelow: task.runsBelow, updatedAt: task.updatedAt ?? "", createdAt: task.createdAt,
    movedAt: task.movedAt,
    change, question: task.question,
  };
}
