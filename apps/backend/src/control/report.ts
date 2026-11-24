import { controlTaskHead } from './task-dto.js';
import { reportIntent } from '@alpacawork/contract/command-access';
import { reportCallerRules } from '@alpacawork/contract/access-boundaries';
/**
 * task report: a state report, a question, its withdrawal, or the user's confirmation of a review. The actor
 * is authorize's, which alone says who may report; this routes the report by the Task's facts and writes it in one
 * transaction.
 */
import { Problem, PROBLEM_CODE, type ProblemReason } from '@alpacawork/core';
import { hasOpenUserQuestion } from '@alpacawork/raw/questions';
import type { taskReportResultSchema } from '@alpacawork/contract/control';
import type { RunId } from '@alpacawork/contract/fields';
import type { taskReportInput } from '@alpacawork/contract/inputs';
import { type ControlTask, type TaskActor } from '@alpacawork/raw';
import type { z } from 'zod';
import type { Caller } from './authorize.js';
import { ReviewService } from './review.js';
import { ask, withdraw } from './task-questions.js';
import { reportState } from './task-reports.js';
import { TaskRepository } from './task-store.js';
import { checkpointForReport } from './conversation-context.js';
import { assertRequiredValues, writtenValues } from './task-values-store.js';
import { withControlWrite, type ControlTx } from './task-transition.js';

type ReportInput = z.output<typeof taskReportInput> & { opId: string };
type ReportResult = z.output<typeof taskReportResultSchema>;

function invalid(path: string, message: string, reason: ProblemReason): never {
  throw new Problem(PROBLEM_CODE.invalidInput, message, undefined, { reason: reason, issues: [{ path, code: 'invalid_combination', message }] });
}

/** The Task a report is about: --task, or a Run's own Task. The write entry authorizes the report on the same Task. */
export function reportedTask(input: Pick<ReportInput, 'task'>, caller: Caller): string {
  if (input.task !== undefined) return input.task;
  if (caller.kind === 'run') return caller.taskId;
  return invalid('task', '--task is required; only a Run defaults to its own Task', { kind: 'task_required_only_run_defaults_own_task' });
}

/** The Run that asks or withdraws: authorize lets only the Task's responsible Run, so this only names it. */
function reportingRun(caller: Caller): RunId {
  if (caller.kind !== 'run')
    throw new Problem(PROBLEM_CODE.forbidden, "Only the Task's responsible Run asks or withdraws a question", undefined,
      { reason: { kind: 'only_task_s_responsible_run_asks_or_withdraws_question' } });
  return caller.runId;
}

export class TaskReportService {
  constructor(readonly root: string) {}

  async report(input: ReportInput, actor: TaskActor, caller: Caller): Promise<ReportResult> {
    const taskId = reportedTask(input, caller);
    return withControlWrite(this.root, (tx, db) => {
      const tasks = new TaskRepository(this.root, db);
      const confirmed = this.record(tx, tasks.get(taskId), input, actor, caller);
      return { task: controlTaskHead(tasks.get(taskId)), outcome: confirmed
        ? { kind: 'accepted' as const, opId: input.opId } : { kind: 'recorded' as const, opId: input.opId } };
    });
  }

  /**
   * Writes the report by the Task's facts: a done on a Task awaiting the user's review, held or not, confirms it; a
   * held Task returns to the state it was held from; any other waiting is a question, held or not; the
   * rest is a state report. True when it confirmed a review.
   */
  private record(tx: ControlTx, task: ControlTask, input: ReportInput, actor: TaskActor, caller: Caller): boolean {
    if (!reportCallerRules.checkpoint.allows(input, caller))
      return invalid('values', 'Only an owner report saves values with a handoff', { kind: 'checkpoint_requires_owner_report' });
    // A retried report (its operation already logged) writes nothing anew; its receipt is the first one's.
    const replayed = task.meta.log.some(each => each.id === input.opId);
    const path = new TaskRepository(this.root, tx.store.connection).ancestry(task.id);
    const written = input.values !== undefined && !replayed ? writtenValues(tx.store.connection, path, task, input.values) : undefined;
    const checkpoint = written !== undefined
      ? checkpointForReport(tx, task, reportingRun(caller), written, input.nextConversation, input.compactFocus) : undefined;
    if (!reportCallerRules.askTo.allows(input, caller))
      invalid('askTo', 'Only a Run asking a question chooses --ask-to', { kind: 'only_question_run_chooses_ask_to' });
    const report = { actor, taskId: task.id, opId: input.opId, expectedTaskHash: input.expectedTaskHash };
    if (input.withdraw !== undefined) {
      withdraw(tx, { ...report, runId: reportingRun(caller), questionId: input.withdraw });
      return false;
    }
    const state = input.state;
    if (state === undefined) return invalid('state', 'Supply --state or --withdraw', { kind: 'supply_state_or_withdraw' });
    const intent = reportIntent({ ...task.meta, openUserQuestion: hasOpenUserQuestion(task.meta.log) }, state, caller, input.aboutRun !== undefined);
    const unholds = intent.code === 'unhold';
    if (!unholds && state === 'waiting' && caller.kind !== 'run' && input.estimateMinutes !== undefined)
      return invalid('estimateMinutes', 'A review submission carries no --estimate-minutes', { kind: 'review_submission_carries_no_estimate' });
    if (intent.code === 'confirm') {
      if (input.urgent !== undefined) return invalid('urgent', 'A confirmation is not urgent: --urgent is for a done report', { kind: 'confirmation_not_urgent_urgent_for_done_report' });
      new ReviewService(this.root).approve(tx, { taskId: task.id, operationId: input.opId,
        expectedTaskHash: input.expectedTaskHash, expectedPlacementRevision: input.expectedPlacementRevision,
        aboutRunId: input.aboutRun, title: input.title, description: input.description }, actor);
      return true;
    }
    // Reports delivered for a decision need their own readable summary, independently of Task values.
    if (intent.code === 'ask' || intent.code === 'report_done') {
      if (!input.title?.trim() || !input.description?.trim())
        return invalid(!input.title?.trim() ? 'title' : 'description', 'A question or completion report needs --title and ' +
          '--description-file with nonblank text', { kind: 'report_needs_title_and_description' });
    }
    // Only a Run reporting on its own Task asks; management waiting may restore a held review.
    if (intent.code === 'ask') {
      if (input.estimateMinutes !== undefined) return invalid('estimateMinutes', 'A question carries no --estimate-minutes', { kind: 'question_carries_no_estimate' });
      if (input.askTo === undefined)
        invalid('askTo', 'A question requires --ask-to <ancestor Task ID>|user', { kind: 'question_requires_ask_to' });
      ask(tx, { ...report, askTo: input.askTo, runId: reportingRun(caller), title: input.title!, description: input.description!,
        values: input.values, written, nextConversation: input.nextConversation, checkpoint });
      return false;
    }
    // Finishing needs every required field: checked on the values the report itself leaves, never on a partial write.
    if (intent.code === 'report_done' && !replayed) assertRequiredValues(tx.store.connection, path, task.id, written ?? task.values);
    reportState(tx, { ...report, runId: caller.kind === 'run' ? caller.runId : null, state, intent: intent.code,
      title: input.title, description: input.description, estimateMinutes: input.estimateMinutes,
      urgentReason: input.urgent, values: input.values, written, nextConversation: input.nextConversation, checkpoint });
    return false;
  }
}
