/** Seeds a Task's values straight into a synthetic workspace's control database, as a write of values stores them. */
import { ControlStore } from '@alpacawork/db';
import type { TaskValues } from '@alpacawork/contract';
import { readTaskValues, writeTaskValues } from '@alpacawork/backend/test-dist/control/task-values-store.js';

/** A decide value of one question per entry: its text, and its choices as `[name, detail]`. */
export const decideValues = (...questions: (string | [string, ...[string, string][]])[]): TaskValues => ({
  decide: questions.map(question => typeof question === 'string' ? { decide_kind: 'choose', decide_question: question } : {
    decide_kind: 'choose', decide_question: question[0],
    ...(question.length > 1 ? { decide_choices: question.slice(1).map(choice => {
      const [name, detail] = choice as [string, string];
      return { decide_choice: name, ...(detail ? { decide_choice_detail: detail } : {}) };
    }) } : {}),
  }),
});

/** Replaces the values of `taskId` whole. */
export function writeValues(root: string, taskId: string, values: TaskValues): void {
  const store = new ControlStore(root);
  try { store.write(db => writeTaskValues(db, taskId, values)); } finally { store.close(); }
}
/** Replaces the values of `taskId` with `values` merged over what it has. */
export function seedValues(root: string, taskId: string, values: TaskValues): void {
  const store = new ControlStore(root);
  try {
    store.write(db => writeTaskValues(db, taskId, { ...readTaskValues(db, [taskId]).get(taskId), ...values }));
  } finally { store.close(); }
}
