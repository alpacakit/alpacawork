/**
 * Browser-safe: the web reads these through @alpacawork/contract, so it must not import node modules.
 * The only definition of each task value set; RAW validation and the wire schema both derive from it.
 */
/** Whether a Task is in the tree, shelved or gone. */
export const TASK_LIFECYCLES = ['active', 'archived', 'deleted'] as const;
export type TaskLifecycle = (typeof TASK_LIFECYCLES)[number];
/** A project is a task that holds settings and the tasks under it; only a task has a working state. */
export const TASK_KIND = { task: 'task', project: 'project' } as const;
export type TaskKind = (typeof TASK_KIND)[keyof typeof TASK_KIND];
export const TASK_STATE = {
  todo: 'todo',
  doing: 'doing',
  error: 'error',
  waiting: 'waiting',
  held: 'held',
  done: 'done',
  stopped: 'stopped',
} as const;
export type TaskState = (typeof TASK_STATE)[keyof typeof TASK_STATE];
/** Current work stage. A hold is a separate user decision; historical states still include held. */
export const TASK_BASE_STATES = ['todo', 'doing', 'error', 'waiting', 'done', 'stopped'] as const;
export type TaskBaseState = (typeof TASK_BASE_STATES)[number];
export type TaskStage = { baseState: TaskBaseState; hold: boolean };
/** Representation of the current stage for existing status words and immutable history. Never stored separately. */
export const effectiveTaskState = (task: TaskStage): TaskState => task.hold ? 'held' : task.baseState;
/** What a task log entry records. */
export const LOG_KIND = { created: 'created', reported: 'reported', retitled: 'retitled' } as const;
export type LogKind = (typeof LOG_KIND)[keyof typeof LOG_KIND];
