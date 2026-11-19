import { i18n } from '@alpacawork/i18n';
import type { TelemetryOp } from '@alpacawork/contract/telemetry';
import { REPORT_STATE } from '@/domain/tasks';
export type OperationFacts = { key: string; subject: { action: string; taskId?: string | null; label: string }; payload?: unknown };
const words = {
  message: { text: (task: string) => i18n.t('ui:undo.offer.message', { task }), undone: () => i18n.t('ui:undo.offer.messageUndone') },
  approve: { text: (task: string) => i18n.t('ui:undo.offer.approve', { task }), undone: () => i18n.t('ui:undo.offer.approveUndone') },
  hold: { text: (task: string) => i18n.t('ui:undo.offer.hold', { task }), undone: () => i18n.t('ui:undo.offer.holdUndone') },
  unhold: { text: (task: string) => i18n.t('ui:undo.offer.unhold', { task }), undone: () => i18n.t('ui:undo.offer.unholdUndone') },
  projectCreate: { text: (task: string) => i18n.t('ui:undo.offer.projectCreate', { task }), undone: () => i18n.t('ui:undo.offer.projectCreateUndone') },
  move: { text: (task: string) => i18n.t('ui:undo.offer.move', { task }), undone: () => i18n.t('ui:undo.offer.moveUndone') },
  responsible: { text: (task: string) => i18n.t('ui:undo.offer.responsible', { task }), undone: () => i18n.t('ui:undo.offer.responsibleUndone') },
  archive: { text: (task: string) => i18n.t('ui:undo.offer.archive', { task }), undone: () => i18n.t('ui:undo.offer.archiveUndone') },
  delete: { text: (task: string) => i18n.t('ui:undo.offer.delete', { task }), undone: () => i18n.t('ui:undo.offer.deleteUndone') },
  restore: { text: (task: string) => i18n.t('ui:undo.offer.restore', { task }), undone: () => i18n.t('ui:undo.offer.restoreUndone') },
};
type Operation = { grace: 'deferred' | 'immediate'; restore: 'input' | 'card' | 'form' | 'none'; copy?: keyof typeof words; mark: 'success' | 'info' };
const immediate: Operation = { grace: 'immediate', restore: 'none', mark: 'info' };
const operation = (copy: keyof typeof words, restore: Operation['restore'] = 'form', mark: Operation['mark'] = 'success'): Operation => ({ grace: 'deferred', restore, copy, mark });
const message = operation('message', 'input', 'info');
const actions: Record<string, Operation> = { message, sendback: message, continue: message, retry: message,
  'report:approve': operation('approve','card'), 'report:hold': operation('hold','card'), 'report:unhold': operation('unhold','card') };
const operations: Record<string, Operation> = {
  move: operation('move'), responsible: operation('responsible'),
  'project/new': operation('projectCreate'), 'coordinator/messages': message,
  'task/move': operation('move'), 'agent/assign': operation('responsible'), 'agent/handover': operation('responsible'),
  'task/archive': operation('archive','none'), 'task/delete': operation('delete','none'), 'task/restore': operation('restore','none'),
};
const operationName = (facts: OperationFacts) => facts.subject.action === 'write' ? (JSON.parse(facts.key) as [string,string])[1] : facts.subject.action;
/** The operation declares policy; neither sender nor toast infers it from HTTP paths. */
export const writeOperation = (facts: OperationFacts): Operation =>
  (facts.subject.action === 'write' ? operations : actions)[operationName(facts)] ?? immediate;
/** What a write counts as in usage data: the operation's name, the same at every place the screen admits it. */
const uses: Record<string, TelemetryOp> = { message: 'w.message', sendback: 'w.sendback', continue: 'w.continue', retry: 'w.retry',
  'report:approve': 'w.approve', 'report:hold': 'w.hold', 'report:unhold': 'w.unhold', 'task/move': 'w.move',
  move: 'w.move', responsible: 'w.responsible', 'agent/assign': 'w.responsible', 'agent/handover': 'w.responsible',
  'project/new': 'w.project', 'task/archive': 'w.archive', 'task/delete': 'w.delete', 'task/restore': 'w.restore', 'report:stop': 'w.stop', 'run/stop': 'w.runStop' };
export const operationUse = (facts: OperationFacts): TelemetryOp | undefined => uses[operationName(facts)];
export function undoOfferCopy(facts: OperationFacts) {
  // One line: the press itself. What was just typed or pressed on (the words, the task's title) is not said back.
  const rule = writeOperation(facts);
  return { text: rule.copy ? words[rule.copy].text(facts.subject.taskId ?? '') : '', mark: rule.mark,
    undone: rule.copy ? words[rule.copy].undone() : i18n.t('ui:undo.offer.cancelled') };
}
export function directOperation(key: string, payload: unknown, label = ''): OperationFacts {
  const [,name,task] = JSON.parse(key) as [string,string,string|null];
  const body = (payload && typeof payload === 'object' ? payload : {}) as { choice?: string; state?: string };
  const choice = body.choice ?? Object.entries(REPORT_STATE).find(([, state]) => state === body.state)?.[0] ?? 'unhold';
  return { key, payload, subject: { taskId: task, label, action: name === 'task/report' ? `report:${choice}` : 'write' } };
}
