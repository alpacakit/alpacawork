import { controlTaskHead } from './task-dto.js';
/**
 * task request: an instruction to one Task or an answer to its question. The actor is authorize's, which alone says who may request; this routes the input and checks the
 * Task's facts only.
 */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { RequestReceipt, taskRequestResultSchema } from '@alpacawork/contract/control';
import type { taskRequestInput } from '@alpacawork/contract/inputs';
import { questionsOf, type TaskActor } from '@alpacawork/raw';
import { questionSnapshot, replyQuestion, assertQuestionReplyApplicable } from './question-rules.js';
import type { z } from 'zod';
import type { Caller } from './authorize.js';
import { RequestService } from './requests.js';
import { answer } from './task-questions.js';
import { ControlTaskStore, TaskRepository } from './task-store.js';
import { withControlWrite } from './task-transition.js';

/** A request as its entry parsed it (the contract's taskRequestInput). */
type TaskRequestInput = z.output<typeof taskRequestInput>;
/** The committed Task with the Request's receipt or the answer (the contract's taskRequestResultSchema). */
type TaskRequestResult = z.output<typeof taskRequestResultSchema>;

/** Name the existing version requirements for the services. */
function shown<Value>(value: Value | undefined, path: string, flag: string): Value {
  if (value !== undefined) return value;
  throw new Problem(PROBLEM_CODE.invalidInput, `${flag} is required`, undefined,
    { reason: { kind: 'required', flag: String(flag) }, issues: [{ path, code: 'required', message: `${flag} is required` }] });
}

export class TaskRequestService {
  constructor(readonly root: string) {}
  /**
   * --answers preserves an answer through task-questions.answer. Every instruction, including work after a review,
   * goes through RequestService and TaskTransition.appendRequestReference in its transaction. `caller` names a
   * requesting Run, which the Request's Run keeps as its caller.
   */
  async request(input: TaskRequestInput, actor: TaskActor, caller: Caller): Promise<TaskRequestResult> {
    if (input.answers !== undefined) {
      const questionId = input.answers;
      return withControlWrite(this.root, (tx, db) => {
        const { runs } = tx, tasks = new TaskRepository(this.root, db), task = tasks.get(input.task);
        const question = replyQuestion(task.id, task.meta.log, questionId);
        // The same answer replay stays an answer, even though its first commit closed the question.
        if (question.closing === null || question.closing.id === input.opId && question.closing.kind === 'answered') {
          answer(tx, { actor, taskId: input.task, questionId, body: input.body, opId: input.opId });
          return { task: controlTaskHead(tasks.get(input.task)), outcome: { kind: 'answered' as const, opId: input.opId } };
        }
        assertQuestionReplyApplicable(task.id, question, questionSnapshot(tasks.related(task.id).tasks));
        const previous = runs.getRequest(input.opId), placement = runs.responsiblePlacement(task.id);
        if (!placement) throw new Problem(PROBLEM_CODE.responsibleMissing, 'Task needs a responsible placement',
          { task: task.id, questions: questionsOf(task.meta.log).filter(q => q.closing === null).map(q => q.asked.id) },
          { reason: { kind: 'task_needs_responsible_placement' } });
        let request: RequestReceipt;
        try { request = new RequestService(this.root).requestIn({ taskId: input.task, body: input.body, requestId: input.opId,
          expectedTaskHash: previous?.taskHash ?? task.hash,
          expectedPlacementRevision: previous?.placementRevision ?? placement.revision },
        { purpose: 'instruction', actor, actorRunId: caller.kind === 'run' ? caller.runId : undefined,
          answersQuestion: { id: questionId, title: question.asked.title!,
            state: question.closing.kind === 'answered' ? 'answered' : 'withdrawn' } }, db);
        } catch (error) {
          if (!(error instanceof Problem)) throw error;
          throw new Problem(error.code, error.message, {
            ...(typeof error.detail === 'object' && error.detail !== null ? error.detail : {}),
            task: task.id, questions: questionsOf(task.meta.log).filter(q => q.closing === null).map(q => q.asked.id) },
          { cause: error, reason: error.reason, issues: error.issues });
        }
        return { task: controlTaskHead(tasks.get(input.task)),
          outcome: { kind: 'request_accepted' as const, opId: input.opId, request, answers: questionId } };
      });
    }
    const expectedTaskHash = shown(input.expectedTaskHash, 'expectedTaskHash', '--expected-task-hash');
    const expectedPlacementRevision = shown(input.expectedPlacementRevision ?? undefined, 'expectedPlacementRevision',
      '--expected-placement-revision');
    const request = await new RequestService(this.root).request({ taskId: input.task, body: input.body, requestId: input.opId,
      expectedTaskHash, expectedPlacementRevision, expectedHeadRunId: input.expectedHeadRun,
      targetPlacementId: input.agent, mode: input.newConversation ? 'new' : undefined,
      selected: input.selected, cwd: input.cwd },
    { purpose: 'instruction', actor, actorRunId: caller.kind === 'run' ? caller.runId : undefined });
    return { task: controlTaskHead(await new ControlTaskStore(this.root).get(input.task)),
      outcome: { kind: 'request_accepted', opId: input.opId, request } };
  }
}
