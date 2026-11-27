import { taskOrigin } from '@alpacawork/raw/task-log-schema';
import type { ControlTaskDTO, ControlTaskHeadDTO } from '@alpacawork/contract/control';
/** Wire structure is assembled here; policy owns the action candidates. */
import type { ControlTask, TaskValues } from '@alpacawork/raw';
import { hasOpenUserQuestion } from '@alpacawork/raw/questions';
import { TASK_POLICY, taskActionsOf } from '@alpacawork/contract/task-policy';

type Head<Values> = Omit<ControlTaskHeadDTO, 'values'> & { values: Values };
/** A Task as a write answers with it: no History, which only the Task's reads carry (and an operation keeps no copy of). */
export function controlTaskHead<Values extends TaskValues | undefined>(task: Omit<ControlTask, 'values'> & { values: Values }): Head<Values> {
  return { ...(task.meta.kind === 'project' ? { settings: task.settings! } : {}), id: task.id, kind: task.meta.kind, parentId: task.meta.parentId, path: task.path, lifecycle: task.meta.lifecycle,
    title: task.meta.title, ...(task.meta.analysisSubject ? { analysisSubject: task.meta.analysisSubject } : {}), baseState: task.meta.baseState, hold: task.meta.hold,
    allowedActions: taskActionsOf({ ...task.meta, openUserQuestion: hasOpenUserQuestion(task.meta.log) }),
    policyVersion: TASK_POLICY.version, state: task.meta.state, userRequested: task.meta.userRequested,
    version: Number(task.meta.version), hash: task.hash, values: task.values };
}
/** A read Task: its head and its History. */
export function controlTaskView<Values extends TaskValues | undefined>(task: Omit<ControlTask, 'values'> & { values: Values }): Omit<ControlTaskDTO, 'values'> & { values: Values } {
  const origin = taskOrigin(task.meta.log);
  return { ...controlTaskHead(task), log: task.meta.log, ...(origin ? { origin } : {}) };
}
