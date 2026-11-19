import { commandFetch as fetch } from '../tests/helpers/command-fetch.ts';
import type { TaskValues } from '@alpacawork/contract';
import { decideValues } from '../tests/helpers/task-values.ts';
import { taskValues, patchTask, seedQuestion } from './fixture/task-state.ts';
import { configureCoordinator } from './coordinator-fixture.ts';
import type { Runtime } from './server.ts';

/** T112's two questions, as its decide value holds them. */
export const T112_QUESTIONS = decideValues(
  ['How to open suggestions', ['Option1 Complete from a number', 'Insert the selected task in the text'], ['Option2 Choose from a symbol', 'Open the list']],
  ['Label length', ['Option1 Include the title', 'Make it easy to understand'], ['Option2 Show title on press', 'Make it shorter']]);
/**
 * T112's responsible, at work, asks the person the questions of its decide value; returns the question's ID. The
 * question's text is that value as the server fixes it.
 */
export async function prepareQuestion(runtime: Runtime, question?: { values: TaskValues; report: string }) {
  configureCoordinator(runtime.root);
  patchTask(runtime.root, 'T112', { values: question?.values ?? T112_QUESTIONS });
  return seedQuestion(runtime.root, 'T112', { to: 'user', title: 'Please choose', at: '2026-09-25T14:18:00+09:00',
    description: question?.report ?? Array.from({ length: 14 }, (_, i) => `Result of review ${i + 1}. Please choose an option for the question.`).join('\n\n') });
}
/**
 * T112's responsible withdraws `question` and asks again with its values changed by `change`: the question the person
 * sees is another one. Returns the new question's ID.
 */
export async function askAgain(runtime: Runtime, question: string, change: (values: TaskValues) => TaskValues) {
  const index = await (await fetch(runtime.origin + '/api/workspace/live')).json();
  const placement = index.placements.find((p: any) => p.taskId === 'T112' && p.responsible);
  patchTask(runtime.root, 'T112', { values: change(taskValues(runtime.root, 'T112')), logs: [{ id: crypto.randomUUID(), kind: 'question_withdrawn',
    at: new Date().toISOString(), title: null, description: null, actor: { kind: 'placement', placementId: placement.id },
    fromState: null, toState: null, questionId: question }] });
  return seedQuestion(runtime.root, 'T112', { to: 'user', title: 'Please choose again' });
}
