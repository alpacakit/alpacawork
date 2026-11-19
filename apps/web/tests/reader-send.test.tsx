import { setConversationState } from './conversation-fixture';
import { answerTask } from './fixtures';
import { useConversation } from '../src/features/coordinator/coordinator';
import { labelled } from './fixtures';
import {readerTurn} from '../src/features/reader/submission';
import {freeze,holdsReaderTurn,reconcileOutbox} from '../src/features/coordinator/editor/outbox';
import {useDraftStore} from '../src/features/forms/draft-store';
import * as departureMotion from '../src/features/reader/departure';
import { PROBLEM_RULE } from '@alpacawork/core/codes';
import { ApiError } from '../src/data/client';
import { decideOf } from '../src/domain/questions';
import { answeredQuestions, serialize, choiceAnswer, toggleAnswer } from '../src/features/coordinator/editor/document';
import { beforeAll, beforeEach, expect, expectTypeOf, onTestFinished, test, vi } from 'vitest';
import { notify, useToasts } from '../src/lib/notify';
import { i18n, startI18n } from '@alpacawork/i18n';
import type { CoordinatorResult, CoordinatorTurn } from '@alpacawork/contract/coordinator';
import { acknowledgeReaderSend, captureReaderSubmission, readerSendReadiness, failReaderSend, intentAbout, reconcileReaderSends as reconcileSends, retryReaderIntent, sendIntent,
  closeReaderConversation, observeReaderConversation, useReaderSend, type SentIntent } from '../src/features/coordinator/reader-send';
import { captureReaderIntent, captureReaderSend as captureSend } from './reader-send-fixture';
import { emptyDocument, markReaderOperation, textDocument } from '../src/features/coordinator/editor/document';
import { moveOn, submittedAnswers, takeCompletionAnimation, useSitting, type ReaderAdmission, type ReaderCard } from '../src/features/reader/next-question';
import { useViewStore } from '../src/state/view-store';
import { releaseSpeed } from '../src/features/reader/swipe-answer';
import { at, decideItem, dto, logEntry, questionFixture, run, screenData, taskFixture, tree, userBall } from './fixtures';
const scope = { root: '/fixture', conversationId: 'c' };
const captureReaderSend = (doc: Parameters<typeof captureSend>[0], tasks: Parameters<typeof captureSend>[1], id: string) => captureSend(doc, tasks, id, scope);
const reconcileReaderSends = (conversation: Parameters<typeof reconcileSends>[0]) => reconcileSends(conversation, scope.root);
/** The user's turn on a question T3 asked (`id`, its asking record). */
const asking = (id: string) => userBall('question', id, at, { questionId: id });
/** Two questions as the server fixed them when Q1 was asked. */
const twoAsked = [decideItem('Storage location', [['Option1 Local', 'text']]), decideItem('Color', [['Option1 Blue', 'text']])];
/** T3's responsible, whose version an intent carries. */
const responsible = { id: 'P1', taskId: 'T3', agentId: 'A1', profileKey: 'codex', responsible: true, active: true, revision: 3,
  startedAt: at, endedAt: null, headRunId: 'R1', runtime: { displayState: 'idle' as const, reason: null, sourceRunIds: [],
    runningCount: 0, queuedCount: 0, since: null, lastOutputAt: null, activityKind: null, toolName: null } };
/** T3 asks the user Q1, as the server sends it: its ball, what its question asks, its responsible. */
const value = tree({ tasks: [taskFixture({ id: 'T3', state: 'doing', ball: asking('Q1'), log: [logEntry({ id: 'Q1', kind: 'asked', askedTo: null,
  title: 'Storage location and color', description: 'Choose one', actor: { kind: 'placement', placementId: 'P1' } })] })],
  questions: [questionFixture({ id: 'Q1', taskId: 'T3', title: 'Storage location and color', decide: twoAsked })],
  placements: [responsible], runs: [run('R1', { taskId: 'T3', placementId: 'P1' })] });
const { tasks, people } = screenData(value);
const task = tasks[0]!;
/** T3 waiting on the user's review of R1. */
const reviewing = { ...task, state: 'waiting' as const, ball: userBall('review', 'L2', at, { aboutRunId: 'R1' }) };
const plainDoc = labelled(emptyDocument(), task);
const first = decideOf(twoAsked)[0]!;
const doc = toggleAnswer(plainDoc, task, choiceAnswer(answerTask(task, responsible.revision), 'Q1', first, first.choices[0]!));
/** The server's result for a message: what its writes recorded, and what it refused. */
const result = (writes: CoordinatorResult['writes'] = [], refused: CoordinatorResult['refused'] = []): CoordinatorResult => ({ writes, refused });
type Write = CoordinatorResult['writes'][number];
/** A record the message's writes left on `task` (T3): its kind, the state it led to (none when unsaid) and what it names. */
const wrote = (kind: Write['kind'], more: Partial<Write> = {}): Write => ({ task: 'T3', record: 'L9', kind, toState: null, ...more });
/** The answer that closed `question` on T3. */
const answered = (question: string) => result([wrote('answered', { question })]);
const conversation = (id: string, status: CoordinatorTurn['status'] = 'running', outcome: CoordinatorResult | null = null) =>
  ({ id: 'c', agent: null, warm: 'none' as const, busy: false, cancelled: [], turns: [{ id, at: '', ask: '', attachments: [], status, waiting: status === "queued" || status === "sending", answer: null, seen: false, answeredAt: null, error: null, result: outcome }] });
const receiptOf = (id: string) => [...useReaderSend.getState().receipts.values()].find(receipt=>receipt.root===scope.root&&receipt.conversationId===scope.conversationId&&receipt.id===id);
/** The Run that answers the message ended, and the server says it wrote the answer that closed Q1. */
const confirm = (id: string) => reconcileReaderSends(conversation(id, 'succeeded', answered('Q1')));
const choose = (question: string, n: number, asked = twoAsked) => {
  const one = decideOf(asked)[n - 1]!;
  return toggleAnswer(plainDoc, task, choiceAnswer(answerTask(task, responsible.revision), question, one, one.choices[0]!));
};
const confirmedAnswers = () => Object.entries(useSitting.getState().departures).filter(([, each]) => each.status() === "confirmed").map(([id]) => id);

beforeAll(() => startI18n());
beforeEach(() => {
  useViewStore.getState().openTask(task.id, { reader: true });
  useSitting.setState({ card: { taskId: task.id }, departures: {}, sent: null, emptied: null });
  useReaderSend.setState({ receipts: new Map() });
});
for (const outcome of ['empty result', 'written answer', 'actual refusal'] as const)
test(`free-text submission: ${outcome} separates admission from expected writes`, () => {
  const words = labelled(textDocument('青で進めてください'), task);
  expect(readerSendReadiness(words, tasks, decideOf(twoAsked)).ready).toBe(true);
  expect(captureReaderSend(words, tasks, 'free')()).toBe(true);
  moveOn([]);
  expect(submittedAnswers()).toHaveLength(1);
  acknowledgeReaderSend('free', scope);
  expect(submittedAnswers()?.map(each => each.answer)).toEqual(['send']);
  expect(takeCompletionAnimation(task.id)).toBe(true);
  const errors = vi.spyOn(notify, 'error');
  reconcileReaderSends(conversation('free', 'succeeded', outcome === 'actual refusal'
    ? result([], [{ task: task.id, code: 'conflict', message: 'Task changed', retry: 'reread' }]) : outcome === 'written answer' ? answered('Q1') : result()));
  expect(submittedAnswers()).toHaveLength(1);
  expect(errors).not.toHaveBeenCalled();
  expect(takeCompletionAnimation(task.id)).toBe(false);
});

test('a submitted swipe keeps its preview fact after live geometry is released', () => {
  const card = document.createElement('aside'); card.dataset.readerMode = 'sheet'; card.dataset.carried = '';
  document.body.append(card);
  onTestFinished(() => { window.dispatchEvent(new Event('pagehide')); card.remove(); });
  vi.spyOn(Element.prototype, 'animate').mockImplementation(() => ({ startTime: null,
    finished: new Promise(() => {}), cancel() {} }) as unknown as Animation);
  const accept = captureReaderSend(choose('Q1', 1), tasks, 'preview');
  card.removeAttribute('data-carried'); // The pointer ended before async preflight/receipt retired its card.
  const children = document.body.children.length;
  expect(accept()).toBe(true);
  expect(document.querySelector('[data-flying-card]')).toBeTruthy();
  // The preview was already read with the finger: no held copy's input shield may block the next answer.
  expect(document.body.children).toHaveLength(children + 1);
});

test('the last fixed draft completes before admission and owns only one animation', () => {
  captureReaderSend(choose('Q1', 1), tasks, 'last')();
  moveOn([]);
  expect(submittedAnswers()).toHaveLength(1);
  expect(takeCompletionAnimation(task.id)).toBe(true);
  acknowledgeReaderSend('last', scope);
  expect(receiptOf('last')?.status).toBe('pending');
  expect(submittedAnswers()?.map(each => each.answer)).toEqual(['send']);
  expect(takeCompletionAnimation(task.id)).toBe(false);
  confirm('last');
  expect(takeCompletionAnimation(task.id)).toBe(false);
});
test('a queued second draft on the empty bundle cannot retire or copy the same turn again', () => {
  expect(captureReaderSend(choose('Q1', 1), tasks, 'first')()).toBe(true);
  moveOn([]); acknowledgeReaderSend('first', scope);
  const departure = useSitting.getState().departures[task.id];
  expect(takeCompletionAnimation(task.id)).toBe(true);
  expect(captureReaderSend(choose('Q1', 1), tasks, 'second')()).toBe(false);
  expect(useSitting.getState().departures[task.id]).toBe(departure);
  expect(useSitting.getState().sent).toBeNull();
  expect(takeCompletionAnimation(task.id)).toBe(false);
});
test('changing the project filter starts a fresh bundle and a late old result cannot complete it', () => {
  captureReaderSend(choose('Q1', 1), tasks, 'last')();
  moveOn([]); acknowledgeReaderSend('last', scope);
  expect(submittedAnswers()).toHaveLength(1);
  const project = useViewStore.getState().project;
  try {
    useViewStore.getState().setProject('another-project');
    expect(useSitting.getState().departures).toEqual({});
    expect(useSitting.getState().emptied).toBeNull();
    confirm('last');
    expect(submittedAnswers()).toBeNull();
    expect(takeCompletionAnimation(task.id)).toBe(false);
  } finally { useViewStore.getState().setProject(project); }
});
for (const failure of ['rejected', 'refused', 'cancelled'] as const) test(`last draft completion is cancelled by ${failure} and a later snapshot cannot celebrate it`, () => {
  captureReaderSend(choose('Q1', 1), tasks, 'last')();
  moveOn([]);
  if (failure === 'cancelled') acknowledgeReaderSend('last', scope);
  if (failure === 'refused') failReaderSend('last', scope, new ApiError('Rejected before admission', 'conflict', 'fix'));
  else if (failure === 'cancelled') reconcileReaderSends({ ...conversation('last'), cancelled: ['last'] });
  else failReaderSend('last', scope, new ApiError('Rejected', 'conflict', 'fix'));
  expect(useSitting.getState().emptied).toBeNull();
  expect(submittedAnswers()).toBeNull();
  confirm('last');
  expect(takeCompletionAnimation(task.id)).toBe(false);
});
test('a matching task is taken once per acceptance and per request, including multiple named tasks', () => {
  const accept = captureReaderSend(labelled(emptyDocument(), { id: 'T4', title: 'Other' }), tasks, 'r1');
  // The first context without an answer was removed, so it no longer names the open task.
  accept(); expect(useSitting.getState().sent).toBeNull();
  const several = { ...doc, content: [...doc.content, ...labelled(emptyDocument(), { id: 'T4', title: '' }).content] };
  const take = captureReaderSend(several, tasks, 'r2'); take(); confirm('r2');
  const sent = useSitting.getState().sent;
  expect(sent?.answer).toBe('send'); expect(useSitting.getState().departures[task.id]?.id).toBe('r2');
  take(); expect(useSitting.getState().sent).toBe(sent);
  useSitting.setState({ sent: null }); captureReaderSend(doc, tasks, 'r2')(); expect(useSitting.getState().sent).toBeNull();
});
for (const [name, row] of [['held', { ...task, state: 'held' as const }], ['no turn of yours', { ...task, ball: null }]] as const)
  test(`${name} does not move`, () => {
    captureReaderSend(doc, [row], 'r1')(); expect(useSitting.getState().sent).toBeNull();
  });
test('another task and text without a task label do not move', () => {
  captureReaderSend(labelled(emptyDocument(), { ...task, id: 'T13' }), tasks, 'r1')();
  captureReaderSend(emptyDocument(), tasks, 'r2')(); expect(useSitting.getState().sent).toBeNull();
});
for (const move of ['close', 'reopen', 'other', 'other-and-back'] as const) test(`late acceptance after ${move} does not move`, () => {
  const accept = captureReaderSend(doc, tasks, 'r1');
  if (move === 'close' || move === 'reopen') useViewStore.getState().closeReader();
  else useViewStore.getState().openTask('T4', { reader: true });
  if (move === 'reopen' || move === 'other-and-back') useViewStore.getState().openTask(task.id, { reader: true });
  accept(); expect(useSitting.getState().sent).toBeNull();
});
test('cancellation releases only its pending receipt and cannot be rewound by a later queued snapshot', () => {
  captureReaderSend(doc, tasks, 'r1')();
  reconcileReaderSends({ id: 'c', agent: null, warm: 'none' as const, busy: false, cancelled: ['old'], turns: [] });
  expect(useSitting.getState().departures[task.id]).toBeDefined();
  reconcileReaderSends({ id: 'c', agent: null, warm: 'none' as const, busy: false, cancelled: ['r1'], turns: [] });
  reconcileReaderSends(conversation('r1', 'queued'));
  expect(useSitting.getState().departures[task.id]?.status()).toBe('refused');
  expect(confirmedAnswers()).toEqual([]); expect(useSitting.getState().sent).toBeNull();
});
test('a finger paused before release has no speed; an outward release does', () => {
  expect(releaseSpeed([{ x: 0, t: 0 }, { x: 80, t: 40 }], 45)).toBe(2);
  expect(releaseSpeed([{ x: 0, t: 0 }, { x: 80, t: 40 }], 300)).toBe(0);
});

// Delivery moves the card and its stamp only: no stage of it, the coordinator taking it in included, is an answer.
for (const status of ['queued', 'sending', 'joined', 'running', 'succeeded', 'failed'] as const) test(`a ${status} turn with no result yet is not an answer`, () => {
  expect(captureReaderSend(doc, tasks, 'pending')()).toBe(true);
  reconcileReaderSends(conversation('pending', status));
  expect(receiptOf('pending')?.status).toBe('pending');
  expect(confirmedAnswers()).toEqual([]); expect(keptDepartures()).toEqual([task.id]);
  expect(useSitting.getState().sent?.answer).toBe('send');
});
test('the card leaves as its draft goes, and counts as answered once the result says the answer closed its question', () => {
  captureReaderSend(doc, tasks, 'pending')();
  expect(useSitting.getState().sent?.answer).toBe('send');
  reconcileReaderSends(conversation('pending', 'queued'));
  useSitting.setState({ sent: null });
  confirm('pending'); expect(useSitting.getState().sent).toBeNull();
  expect(receiptOf('pending')?.status).toBe('confirmed');
  expect(confirmedAnswers()).toEqual([task.id]);
});
// A failed Run may have written the answer before it failed: what it wrote decides, not how it ended.
test('a failed turn whose result holds the answer answered it', () => {
  captureReaderSend(doc, tasks, 'failed')();
  reconcileReaderSends(conversation('failed', 'failed', answered('Q1')));
  expect(confirmedAnswers()).toEqual([task.id]);
});

test('a question beside answer labels is delivered even when the coordinator only explains', () => {
  const error = vi.spyOn(notify, 'error');
  onTestFinished(() => error.mockRestore());
  const named = { ...task, title: 'T424（請求書の照合）が適切かを点検する' };
  const draft = toggleAnswer(labelled(emptyDocument(), named), named,
    choiceAnswer(answerTask(named), 'Q1', first, first.choices[0]!));
  draft.content[0]!.content!.push({ type: 'text', text: ' そもそも何をしているの？タスクに振らずにあなたが答えて。' });
  captureReaderSend(draft, [named], 'explain')();
  reconcileReaderSends(conversation('explain', 'succeeded', result()));
  expect(receiptOf('explain')?.status).toBe('confirmed');
  expect(error).not.toHaveBeenCalled();
});

const refusals: [string, CoordinatorResult][] = [
  ['nothing written', result()],
  ['the answer refused', result([], [{ task: 'T3', code: 'conflict', message: 'Task changed', retry: 'reread' }])],
  ['an answer on another Task', result([wrote('answered', { task: 'T4', question: 'Q1' })])],
];
for (const [name, outcome] of refusals) test(`an accepted answer reference leaves internal Task writes with the coordinator (${name})`, () => {
  const error = vi.spyOn(notify, 'error');
  onTestFinished(() => error.mockRestore());
  captureReaderSend(choose('Q1', 1), tasks, 'words')();
  expect(useSitting.getState().sent?.answer).toBe('send');
  reconcileReaderSends(conversation('words', 'succeeded', outcome));
  expect(receiptOf('words')?.status).toBe('confirmed');
  expect(useSitting.getState().departures[task.id]?.status()).toBe('confirmed');
  expect(confirmedAnswers()).toEqual([task.id]); expect(keptDepartures()).toEqual([task.id]);
  expect(error).not.toHaveBeenCalled();
});
test('an answer refused once and then written again was made', () => {
  captureReaderSend(choose('Q1', 2), tasks, 'again')();
  reconcileReaderSends(conversation('again', 'succeeded', result(answered('Q1').writes, [{ task: 'T3', code: 'conflict', message: 'Task changed', retry: 'reread' }])));
  expect(confirmedAnswers()).toEqual([task.id]);
});
test('ordinary words about a review do not promise to settle it', () => {
  const error = vi.spyOn(notify, 'error');
  captureReaderSend(plainDoc, [reviewing], 'review-question')();
  reconcileReaderSends(conversation('review-question', 'succeeded', result()));
  expect(receiptOf('review-question')).toBeUndefined();
  expect(useSitting.getState().sent).toBeNull();
  expect(error).not.toHaveBeenCalled();
});
test('a draft choosing the question\'s Stop is carried out by the report to stopped, not by an answer', () => {
  const stopping = { question: 'Q1', task: task.id, n: '1', name: 'Stop', answer: '1-stop' };
  for (const [id, outcome, status] of [['stopped', result([wrote('reported', { toState: 'stopped' })]), 'confirmed'],
    ['held-instead', result([wrote('reported', { toState: 'held' })]), 'confirmed'], ['answered-instead', answered('Q1'), 'confirmed']] as const) {
    captureReaderSend(toggleAnswer(doc, task, stopping), tasks, id)();
    reconcileReaderSends(conversation(id, 'succeeded', outcome));
    expect(receiptOf(id)?.status, id).toBe(status);
  }
});

test('a choice of another question than the one the ball asks does not answer the card', () => {
  const choice = (question: string) => toggleAnswer(plainDoc, task, choiceAnswer(answerTask(task, responsible.revision), question, decideOf(twoAsked)[0]!, decideOf(twoAsked)[0]!.choices[0]!));
  expect(readerSendReadiness(choice('Q9'), tasks, null).ready).toBe(false);
  expect(captureReaderSend(choice('Q9'), tasks, 'other-question')()).toBe(false);
  expect(useSitting.getState().sent).toBeNull();
  expect(readerSendReadiness(choice('Q1'), tasks, null).ready).toBe(true);
  expect(captureReaderSend(choice('Q1'), tasks, 'own-question')()).toBe(true);
  expect(useSitting.getState().sent?.card.taskId).toBe(task.id);
});
// A swipe that would send nothing says what is left: the first question with no choice, or Other with no words.
test('a draft that names the card but says nothing yet is not ready, and names what is left', () => {
  const asked = decideOf(twoAsked);
  expect(readerSendReadiness(plainDoc, tasks, asked)).toEqual({ ready: false, missing: { task: task.id, question: 'Q1', n: '1', words: false } });
  // The first question chosen: the card answers (a part of the asking may go; the coordinator reads it).
  expect(readerSendReadiness(choose('Q1', 1), tasks, asked)).toEqual({ ready: true, missing: null });
  // Only question 2 chosen: still ready; nothing chosen for 1 is the coordinator's to read.
  expect(readerSendReadiness(choose('Q1', 2), tasks, asked).ready).toBe(true);
  const other = toggleAnswer(plainDoc, task, { question: 'Q1', task: task.id, n: '2', name: 'Other', answer: '2-other' });
  expect(readerSendReadiness(other, tasks, asked)).toEqual({ ready: false, missing: { task: task.id, question: 'Q1', n: '2', words: true } });
  const said = { ...other, content: [...other.content, { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Gray' }] }] };
  expect(readerSendReadiness(said, tasks, asked)).toEqual({ ready: true, missing: null });
  // Words of the person's own answer too.
  const words = { ...plainDoc, content: [...plainDoc.content, { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Local, blue' }] }] };
  expect(readerSendReadiness(words, tasks, asked).ready).toBe(true);
  // Words written for another task, after its label, say nothing for this card.
  const elsewhere = { ...plainDoc, content: [...plainDoc.content, { type: 'paragraph' as const, content: [
    { type: 'taskLabel' as const, attrs: { id: 'T4', title: 'Other', auto: false } }, { type: 'text' as const, text: ' Do this there' }] }] };
  expect(readerSendReadiness(elsewhere, tasks, asked)).toEqual({ ready: false, missing: { task: task.id, question: 'Q1', n: '1', words: false } });
  // Nor after another task's answer, its label taken away: an answer names its task as a label does.
  const after = { ...plainDoc, content: [...plainDoc.content, { type: 'paragraph' as const, content: [
    { type: 'answerLabel' as const, attrs: { question: 'Q7', task: 'T4', n: '1', name: 'Option1', answer: '1-Option1' } }, { type: 'text' as const, text: ' as said there' }] }] };
  expect(readerSendReadiness(after, tasks, asked).ready).toBe(false);
});
test('a delivered receipt after leaving and reopening the same task does not move', () => {
  captureReaderSend(doc, tasks, 'late')();
  reconcileReaderSends(conversation('late', 'queued'));
  useSitting.setState({ sent: null });
  useViewStore.getState().closeReader(); useViewStore.getState().openTask(task.id, { reader: true });
  useSitting.setState({ card: { taskId: task.id } }); confirm('late');
  expect(useSitting.getState().sent).toBeNull();
});

for (const action of ['continue', 'retry'] as const) test(`a later draft does not take the place of an explicit ${action}`, () => {
  captureReaderIntent(intentAbout(task, action, people), useSitting.getState().card, tasks, 'explicit', scope, () => {})();
  // Its command left its record: the review's OK for ✔, a report of the state for Stop and Hold.
  reconcileReaderSends(conversation('explicit', 'succeeded', result([wrote('request_accepted')])));
  const saved = useSitting.getState().departures[task.id];
  expect(saved?.id).toBe('explicit');
  expect(useSitting.getState().sent?.answer).toBe('send');
  captureReaderSend(doc, tasks, 'late-send')();
  expect(useSitting.getState().departures[task.id]).toBe(saved);
});

for (const status of ['queued', 'running'] as const) test(`admission registers pending before a ${status} delivery is reconciled`, () => {
  const accept = captureReaderSend(doc, tasks, 'already-known');
  expectTypeOf(accept).parameters.toEqualTypeOf<[]>();
  expect(accept()).toBe(true);
  expect(receiptOf('already-known')?.status).toBe('pending');
  expect(confirmedAnswers()).toEqual([]);
  const departed = useSitting.getState().sent;
  useSitting.setState({ sent: null });
  reconcileReaderSends(conversation('already-known', status));
  expect(receiptOf('already-known')?.status).toBe('pending');
  expect(useSitting.getState().sent).toBeNull();
  expect(accept()).toBe(false);
  expect(departed?.answer).toBe('send');
});

for (const proof of ['HTTP response', 'queued snapshot', 'sending snapshot'] as const)
test(`a lost draft's Check confirms delivery from ${proof} before the AI result`, () => {
  const error = vi.spyOn(notify, 'error'), success = vi.spyOn(notify, 'success'), retry = vi.fn();
  onTestFinished(() => { error.mockRestore(); success.mockRestore(); });
  captureSend(doc, tasks, 'lost', scope, retry)();
  failReaderSend('lost', scope, new ApiError('no answer'));
  const notice = error.mock.calls.at(-1)![1]!, action = notice.action;
  action!.run(); expect(retry).toHaveBeenCalledOnce();
  if (proof === 'HTTP response') acknowledgeReaderSend('lost', scope);
  else reconcileReaderSends(conversation('lost', proof === 'queued snapshot' ? 'queued' : 'sending'));
  expect(receiptOf('lost')).toMatchObject({ status: 'pending', admitted: true });
  expect(useToasts.getState().toasts.find(toast => toast.id === notice.id)?.kind).toBe('success');
  expect(success).toHaveBeenCalledOnce();
  expect(confirmedAnswers()).toEqual([]);
  expect(useSitting.getState().departures[task.id]?.status()).toBe('pending');
  reconcileReaderSends(conversation('lost', 'queued'));
  expect(success).toHaveBeenCalledOnce();
});
test('a rejected request ID with a new payload cannot confirm the old answer', () => {
  captureReaderSend(choose('Q1', 1), tasks, 'reused')();
  failReaderSend('reused', scope, new ApiError('refused', 'conflict', 'reread'));
  useSitting.setState({ sent: null });
  expect(captureReaderSend(emptyDocument(), tasks, 'reused')()).toBe(false);
  confirm('reused');
  expect(confirmedAnswers()).toEqual([]);
  expect(useSitting.getState().departures[task.id]?.status()).toBe('refused');
  expect(receiptOf('reused')).toBeUndefined();
});

test('an intent carries what the screen showed: the Run its review is about or the question it asks, and the versions of the Task and its responsible', () => {
  expect(intentAbout(reviewing, 'continue', people)).toEqual({ task: 'T3', action: 'continue', aboutRun: 'R1',
    expectedTaskHash: task.hash, expectedPlacementRevision: 3 });
  expect(intentAbout(task, 'retry', people)).toEqual({ task: 'T3', action: 'retry', question: 'Q1',
    expectedTaskHash: task.hash, expectedPlacementRevision: 3 });
  // With no responsible, there is no placement's version to carry.
  expect(intentAbout({ ...task, ball: null }, 'retry', screenData(tree({ tasks: [dto({ id: 'T3' })] })).people))
    .toEqual({ task: 'T3', action: 'retry', expectedTaskHash: task.hash });
});

test('a press says its one line in the screen\'s words, with what the person wrote under it; nothing goes while the input cannot send', async () => {
  await i18n.changeLanguage('en');
  const post = vi.fn((_intent: SentIntent, _card: ReaderCard | null, _text: string): ReaderAdmission => 'retained');
  useReaderSend.setState({ post });
  const intent = intentAbout(reviewing, 'continue', people);
  const card = useSitting.getState().card;
  expect(await sendIntent(intent, card, '  Reviewed  ')).toBe('retained');
  expect(post).toHaveBeenLastCalledWith(intent, card, 'Continue T3\n\nReviewed');
  for (const [action, line] of [['continue', 'Continue T3'], ['retry', 'Retry T3']] as const) {
    await sendIntent({ ...intent, action }, card);
    expect(post).toHaveBeenLastCalledWith({ ...intent, action }, card, line);
  }
  useReaderSend.setState({ post: null });
  expect(await sendIntent(intent, card)).toBe('rejected');
});

test('an intent\'s fixed card leaves before its receipt; Restore leaves none', () => {
  const accept = captureReaderIntent(intentAbout(reviewing, 'continue', people), useSitting.getState().card, [reviewing], 'continue', scope, () => {});
  expect(accept()).toBe(true);
  expect(useSitting.getState().sent?.answer).toBe('send');
  expect(receiptOf('continue')).toMatchObject({ binding: { kind: 'intent' }, status: 'pending' });
  reconcileReaderSends(conversation('continue', 'queued'));
  expect(useSitting.getState().sent?.answer).toBe('send');
  expect(useSitting.getState().departures[task.id]?.status()).toBe('pending');
  // Admitted again (sent again as it was), it takes nothing more.
  expect(accept()).toBe(false);

});

test('an intent is carried out when the result of its message wrote the record its command leaves on its Task', () => {
  captureReaderIntent(intentAbout(reviewing, 'continue', people), useSitting.getState().card, [reviewing], 'carried', scope, () => {})();
  reconcileReaderSends(conversation('carried', 'running'));
  expect(receiptOf('carried')?.status).toBe('pending');
  // Refused once (an old version), then written again: carried out.
  reconcileReaderSends(conversation('carried', 'succeeded', result([wrote('request_accepted')], [{ task: 'T3', code: 'conflict', message: 'Task changed', retry: 'reread' }])));
  expect(confirmedAnswers()).toEqual([task.id]);
  expect(useSitting.getState().departures[task.id]).toMatchObject({ answer: 'send', id: 'carried' });
});
// The Task moving on by another hand (another screen held it) says nothing of this press: only its own result does.
// Nor does another write of the same message on its Task: ✔ refused for an old version while the user's request
// mark asked in the same words was written, or a state reported where the review's OK was asked for.
for (const [name, outcome] of [['refused for an old version', result([], [{ task: 'T3', code: 'conflict', message: 'Task changed', retry: 'reread' }])],
  ['nothing written', result()], ['written on another Task only', result([wrote('review_approved', { task: 'T4', toState: 'done', runId: 'R1' })])],
  ['refused, with another record on its Task', result([wrote('user_request_changed')], [{ task: 'T3', code: 'conflict', message: 'Task changed', retry: 'reread' }])]] as const)
  test(`an intent whose result shows not its record on its Task (${name}) was not carried out: its card comes back`, () => {
    const error = vi.spyOn(notify, 'error');
    onTestFinished(() => error.mockRestore());
    captureReaderIntent(intentAbout(reviewing, 'continue', people), useSitting.getState().card, [reviewing], 'stale', scope, () => {})();
    reconcileReaderSends(conversation('stale', 'queued'));
    expect(useSitting.getState().sent?.answer).toBe('send');
    reconcileReaderSends(conversation('stale', 'succeeded', outcome));
    expect(useSitting.getState().departures[task.id]?.status()).toBe('refused');
    expect(confirmedAnswers()).toEqual([]);
    expect(keptDepartures()).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    // A later snapshot of the same result says nothing more.
    reconcileReaderSends(conversation('stale', 'succeeded', outcome));
    expect(error).toHaveBeenCalledOnce();
  });

// A press is carried out by its record and the state it leads to: Hold to held, Stop to stopped, Restore to the state
// the hold was taken from; ✔ by the OK of the Run it was about.
test('each press is carried out by the record its command leaves, leading where it leads, and by no other', () => {
  // Held from waiting (the review): Restore goes back there.
  const held = screenData(tree({ tasks: [taskFixture({ id: 'T3', state: 'held', ball: userBall('review', 'L2', at, { aboutRunId: 'R1' }),
    log: [logEntry({ id: 'L5', kind: 'reported', fromState: 'waiting', toState: 'held', actor: { kind: 'human' } })] })],
    placements: [responsible], runs: [run('R1', { taskId: 'T3', placementId: 'P1' })] })).tasks[0]!;
  const writes = { okOfR1: wrote('review_approved', { toState: 'done', runId: 'R1' }), okOfR2: wrote('review_approved', { toState: 'done', runId: 'R2' }),
    toHeld: wrote('reported', { toState: 'held' }), toStopped: wrote('reported', { toState: 'stopped' }),
    toWaiting: wrote('reported', { toState: 'waiting' }), toDoing: wrote('reported', { toState: 'doing' }),
    accepted: wrote('request_accepted'), answer: wrote('answered', { question: 'Q1' }) };
  const carries: Record<SentIntent['action'], keyof typeof writes> = { sendback: 'accepted', continue: 'accepted', retry: 'accepted' };
  for (const [action, carried] of Object.entries(carries) as [SentIntent['action'], keyof typeof writes][])
    for (const [name, write] of Object.entries(writes)) {
      const id = `${action}-${name}`, shown = reviewing;
      useSitting.setState({ card: { taskId: task.id }, departures: {}, sent: null });
      captureReaderIntent(intentAbout(shown, action, people), useSitting.getState().card, [shown], id, scope, () => {})();
      reconcileReaderSends(conversation(id, 'succeeded', result([write])));
      expect(receiptOf(id)?.status, id).toBe('confirmed');
    }
});

test("an intent's Check confirms delivery once serve answers, as an answer's does", () => {
  const error = vi.spyOn(notify, 'error'), success = vi.spyOn(notify, 'success'), retry = vi.fn();
  onTestFinished(() => { error.mockRestore(); success.mockRestore(); });
  const accept = captureReaderIntent(intentAbout(reviewing, 'retry', people), useSitting.getState().card, [reviewing], 'checked', scope, retry);
  accept();
  failReaderSend('checked', scope, new ApiError('no answer'));
  const action = error.mock.calls.at(-1)![1]?.action as NonNullable<Parameters<typeof notify.error>[1]>["action"];
  expect(action!.label).toBe(i18n.t('reader:recovery.check'));
  action!.run();
  expect(retry).toHaveBeenCalledOnce();
  // Check confirms delivery in the same slot. Only the AI's later result can confirm the expected Task writes.
  accept();
  reconcileReaderSends(conversation('checked', 'queued'));
  expect(useSitting.getState().sent?.answer).toBe('send');
  acknowledgeReaderSend('checked', scope);
  expect(useToasts.getState().toasts.find(toast => toast.id === error.mock.calls.at(-1)![1]?.id)?.kind).toBe('success');
  expect(success).toHaveBeenCalledOnce();
});

test('an intent whose answer was lost is known at its receipt, and its card leaves then; a refused one keeps its card', () => {
  captureReaderIntent(intentAbout(reviewing, 'retry', people), useSitting.getState().card, [reviewing], 'lost', scope, () => {})();
  expect(failReaderSend('lost', scope, new ApiError('no answer'))).toBe(true);
  expect(receiptOf('lost')?.status).toBe('unconfirmed');
  expect(useSitting.getState().sent?.answer).toBe('send');
  reconcileReaderSends(conversation('lost', 'queued'));
  expect(receiptOf('lost')?.status).toBe('pending');
  expect(useSitting.getState().sent?.answer).toBe('send');
  useSitting.setState({ card: { taskId: task.id }, departures: {}, sent: null });
  captureReaderIntent(intentAbout(reviewing, 'retry', people), useSitting.getState().card, [reviewing], 'refused', scope, () => {})();
  failReaderSend('refused', scope, new ApiError('refused', 'conflict', 'reread'));
  reconcileReaderSends(conversation('refused', 'queued'));
  expect(receiptOf('refused')?.status).toBe('refused');
  expect(useSitting.getState().sent).toBeNull();
});

// A question about the rules is conversation, including context/raw ID and a natural stop command.
for (const [name, draft, outcome] of [
  ['open detail', labelled(textDocument('今回の本番/追跡ファイル変更禁止はどこに記載のルールですか？内部プロンプト？'), task), result()],
  ['raw task ID', textDocument('T3 このルールはどこに記載されていますか？'), result()],
  ['natural stop', labelled(textDocument('中止にして'), task), result([wrote('reported', { toState: 'stopped' })])],
] as const) test(`${name}: normal completion cannot manufacture a refusal`, () => {
  const errors = vi.spyOn(notify, 'error');
  // A named waiting task is captured without a visible card; ordinary words still promise no write or visual event.
  useViewStore.getState().closeReader();
  expect(captureReaderSend(draft, tasks, 'preview')()).toBe(false);
  expect(captureReaderSend(draft, tasks, 'conversation')()).toBe(false);
  acknowledgeReaderSend('conversation', scope);
  reconcileReaderSends(conversation('conversation', 'queued'));
  moveOn([]);
  expect(submittedAnswers()).toBeNull();
  expect(takeCompletionAnimation(task.id)).toBe(false);
  reconcileReaderSends(conversation('conversation', 'succeeded', outcome));
  expect(submittedAnswers()).toBeNull();
  expect(takeCompletionAnimation(task.id)).toBe(false);
  expect(receiptOf('conversation')?.binding.expectedWrites??null).toBeNull();
  expect(useSitting.getState().sent).toBeNull();
  expect(keptDepartures()).toEqual([]);
  expect(errors).not.toHaveBeenCalled();
});

test('admission ends a hidden delivery notice; a later Task refusal owns its own notice', () => {
  useToasts.setState({ toasts: [], hidden: new Set() });
  const id = 'hidden-until-outcome', key = `reader-operation:${JSON.stringify([scope.root, scope.conversationId, id,task.id,reviewing.ball!.holder==='user'?reviewing.ball!.key:null])}`;
  captureReaderIntent(intentAbout(reviewing, 'retry', people), useSitting.getState().card, [reviewing], id, scope, () => {})();
  failReaderSend(id, scope, new ApiError('lost response'));
  const delivery = useToasts.getState().toasts[0]!.id;
  notify.hide(delivery);
  expect(useToasts.getState().hidden.has(delivery)).toBe(true);
  reconcileReaderSends(conversation(id, 'queued'));
  acknowledgeReaderSend(id, scope);
  expect(useToasts.getState().hidden.has(delivery)).toBe(false);
  expect(useToasts.getState().toasts.find(t => t.id === delivery)).toBeUndefined();
  reconcileReaderSends(conversation(id, 'succeeded', result()));
  expect(receiptOf(id)?.status).toBe('refused');
  expect(useToasts.getState().toasts.find(t => t.id === key)).toBeTruthy();
  expect(useToasts.getState().hidden.has(key)).toBe(false);
});

test('a definite refusal ends its event, so closing its Open across 1000 tasks retains no hidden marks', () => {
  useToasts.setState({ hidden: new Set() });
  for (let n = 0; n < 1000; n++) {
    const row = { ...reviewing, id: `refused-task-${n}` }, id = `refused-${n}`;
    const key = `reader-operation:${JSON.stringify([scope.root, scope.conversationId, id,row.id,row.ball!.holder==='user'?row.ball!.key:null])}`;
    captureReaderIntent(intentAbout(row, 'retry', people), null, [row], id, scope, () => {})();
    failReaderSend(id, scope, new ApiError('refused', 'conflict', 'reread'));
    notify.hide(key);
    closeReaderConversation(scope);
  }
  expect(useToasts.getState().hidden.size).toBe(0);
});


// Internal command refusals never turn ordinary conversation into a failed screen operation.
for (const [name, draft, shownTasks, outcome] of [
  ['detail context', labelled(textDocument('このルールの出典は？'), task), tasks, result([], [{ task: task.id, code: 'conflict', message: 'Task changed', retry: 'reread' }])],
  ['raw ID', textDocument('T3 中止にして'), tasks, result([], [{ task: task.id, code: 'conflict', message: 'Task changed', retry: 'reread' }])],
  ['no task reference', textDocument('中止にして'), tasks, result([], [{ task: task.id, code: 'conflict', message: 'Task changed', retry: 'reread' }])],
  ['unknown Task', textDocument('新しいタスクを作って'), [], result([], [{ task: 'T999', code: 'conflict', message: 'Task changed', retry: 'reread' }])],
] as const) test(`ordinary conversation: ${name} leaves actual server refusals with the agent`, () => {
  const error = vi.spyOn(notify, 'error');
  useViewStore.getState().closeReader();
  expect(captureReaderSend(draft, shownTasks, 'actual-refusal')()).toBe(false);
  expect([...useReaderSend.getState().receipts.values()].every(receipt=>receipt.binding.expectedWrites===null)).toBe(true);
  reconcileReaderSends(conversation('actual-refusal', 'succeeded', outcome));
  reconcileReaderSends(conversation('actual-refusal', 'succeeded', outcome));
  expect(error).not.toHaveBeenCalled();
  expect(useSitting.getState().sent).toBeNull();
  expect(keptDepartures()).toEqual([]);
});
test('ordinary refusal observation is isolated by workspace, conversation, cancellation and closure', () => {
  const error = vi.spyOn(notify, 'error'), refused = result([], [{ task: task.id, code: 'conflict', message: 'Task changed', retry: 'reread' }]);
  captureReaderSend(plainDoc, tasks, 'scoped')();
  const response = conversation('scoped', 'succeeded', refused);
  reconcileSends(response, '/other-root');
  reconcileSends({ ...response, id: 'other-conversation' }, scope.root);
  expect(error).not.toHaveBeenCalled();
  reconcileReaderSends({ ...response, cancelled: ['scoped'] });
  reconcileReaderSends(response);
  expect(error).not.toHaveBeenCalled();
  captureReaderSend(plainDoc, tasks, 'closed')();
  closeReaderConversation(scope);
  reconcileReaderSends(conversation('closed', 'succeeded', refused));
  expect(error).not.toHaveBeenCalled();
});
test('a newer explicit operation keeps its verdict when an older ordinary refusal arrives late', () => {
  const error = vi.spyOn(notify, 'error');
  captureReaderSend(plainDoc, tasks, 'old-conversation')();
  captureReaderIntent(intentAbout(reviewing, 'continue', people), null, [reviewing], 'new-operation', scope, () => {})();
  reconcileReaderSends(conversation('new-operation', 'succeeded', result([wrote('request_accepted')])));
  reconcileReaderSends(conversation('old-conversation', 'succeeded', result([], [{ task: task.id, code: 'conflict', message: 'Task changed', retry: 'reread' }])));
  expect(error).not.toHaveBeenCalled();
});


for (const code of ['conflict', 'forbidden', 'handoff_pending'] as const) test(`an approval preserves actual ${code} guidance after navigation`, async () => {
  await i18n.changeLanguage('en');
  const error = vi.spyOn(notify, 'error');
  captureReaderIntent(intentAbout(reviewing, 'continue', people), useSitting.getState().card,
    [reviewing], 'stale-approval', scope, () => {})();
  useViewStore.getState().openTask('T4', { reader: true });
  reconcileReaderSends(conversation('stale-approval', 'succeeded', result([], [{ task: task.id, code, message: code, retry: PROBLEM_RULE[code].retry }])));
  expect(receiptOf('stale-approval')?.status).toBe('refused');
  // The notice's own button opens the latest state, so a reread refusal's reason stands alone.
  const retry = PROBLEM_RULE[code].retry, reason = new ApiError('', code, retry).displayMessage;
  expect(error.mock.calls.at(-1)?.[1]?.detail).toBe(retry === 'reread' ? reason : `${reason} ${i18n.t(`problem.retry.${retry}`)}`);
  error.mock.calls.at(-1)?.[1]?.action?.run();
  expect(useViewStore.getState().selected).toBe(task.id);
});

 test('unknown storage keeps the fixed last card complete and same-ID checking cannot replay it', () => {
 captureReaderSend(doc, tasks, 'unknown')(); moveOn([]);
 expect(takeCompletionAnimation(task.id)).toBe(true);
 failReaderSend('unknown', scope, new ApiError('Unknown'));
 expect(submittedAnswers()).toHaveLength(1);
 expect(keptDepartures()).toEqual([task.id]);
 expect(takeCompletionAnimation(task.id)).toBe(false);
 confirm('unknown');
 expect(takeCompletionAnimation(task.id)).toBe(false);
 });

test('a new retry refreshes only version guards, retaining the original review and question identity', () => {
 const original={...intentAbout(reviewing,'continue',people),question:'original-question',aboutRun:'original-run'};
 const current={...reviewing,hash:'new-reviewed-hash',ball:userBall('review','new-turn',at,{aboutRunId:'different-run'})};
 const retried=retryReaderIntent(original,current,people);
 expect(retried).toEqual({...original,expectedTaskHash:'new-reviewed-hash'});
 expect(original.expectedTaskHash).not.toBe(retried.expectedTaskHash);
});

// A Done button can stay at the input's foot while local submission already opens the next card.
test('a held stamp shields the next reader intent; a carried flight and an outside action remain available', () => {
  const held = vi.spyOn(departureMotion, 'readerActionsHeld').mockReturnValue(true);
  onTestFinished(() => held.mockRestore());
  const post = vi.fn(() => 'retired' as const); useReaderSend.setState({ post });
  const intent = intentAbout(task, 'retry', people), card = useSitting.getState().card;
  expect(sendIntent(intent, card)).toBe('rejected'); expect(post).not.toHaveBeenCalled();
  expect(sendIntent(intent, null)).toBe('retired');
  held.mockReturnValue(false); expect(sendIntent(intent, card)).toBe('retired');
  expect(post).toHaveBeenCalledTimes(2);
});

for (const lang of ['en', 'ja']) for (const ordinary of [false, true]) test(`${lang} stopped-Run refusal is routed by ${ordinary ? 'ordinary words' : 'approval'}`, async () => {
  await i18n.changeLanguage(lang);
  const error = vi.spyOn(notify, 'error');
  if (ordinary) captureReaderSend(plainDoc, tasks, 'real-reason')();
  else captureReaderIntent(intentAbout(reviewing, 'continue', people), null, [reviewing], 'real-reason', scope, () => {})();
  const reason = { kind: 'coordinator_run_not_running' } as const;
  reconcileReaderSends(conversation('real-reason', 'succeeded', result([], [{ task: task.id, code: 'forbidden', message: 'Coordinator Run is no longer running', retry: 'fix', reason }])));
  if (ordinary) { expect(error).not.toHaveBeenCalled(); return; }
  const detail = error.mock.calls.at(-1)?.[1]?.detail;
  expect(detail).toContain(i18n.t(`problem.reason.${reason.kind}`));
  expect(detail).toContain(i18n.t('problem.retry.fix'));
  expect(detail).not.toContain(i18n.t('problem.code.conflict'));
});

test('a Retry carried out by a new responsible is settled, even when a request on the way was refused', () => {
  const error = vi.spyOn(notify, 'error');
  const failed = { ...task, state: 'error' as const, ball: userBall('failed', 'L5', at) };
  captureReaderIntent(intentAbout(failed, 'retry', people), null, [failed], 'retried', scope, () => {})();
  // The coordinator replaced the agent (its handover restarts the work); its own request was then refused.
  reconcileReaderSends(conversation('retried', 'succeeded', result([wrote('responsible_changed')], [{ task: task.id, code: 'conflict', message: 'Task changed', retry: 'reread' }])));
  expect(receiptOf('retried')?.status).toBe('confirmed');
  expect(error).not.toHaveBeenCalled();
});

test('an ended result without a write or refusal says so without inventing conflict', async () => {
  await i18n.changeLanguage('en');
  const error = vi.spyOn(notify, 'error');
  captureReaderIntent(intentAbout(reviewing, 'continue', people), null, [reviewing], 'empty-result', scope, () => {})();
  reconcileReaderSends(conversation('empty-result', 'succeeded', result()));
  expect(error.mock.calls.at(-1)?.[1]?.detail).toContain(i18n.t('reader:recovery.notCarriedOut'));
  expect(error.mock.calls.at(-1)?.[1]?.detail).not.toContain('conflict');
});

test('a recorded unknown write remains unknown after receipt and repeated reconciliation', async () => {
  await i18n.changeLanguage('en');
  const error = vi.spyOn(notify, 'error');
  const retry = vi.fn(() => acknowledgeReaderSend('unknown-result', scope));
  const success = vi.spyOn(notify, 'success');
  captureReaderIntent(intentAbout(reviewing, 'continue', people), null, [reviewing], 'unknown-result', scope, retry)();
  const outcome = conversation('unknown-result', 'succeeded', result([], [{ task: task.id, code: 'save_unconfirmed', message: 'Unknown save', retry: 'check' }]));
  reconcileReaderSends(outcome);
  expect(receiptOf('unknown-result')?.status).toBe('unconfirmed');
  expect(error.mock.calls.at(-1)?.[1]?.ongoing).toBe(true);
  expect(error.mock.calls.at(-1)?.[1]?.detail).not.toContain('conflict');
  useViewStore.getState().openTask('T4', { reader: true });
  error.mock.calls.at(-1)?.[1]?.action?.run();
  expect(retry).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  expect(useViewStore.getState().selected).toBe(task.id);
  reconcileReaderSends(structuredClone(outcome));
  expect(error).toHaveBeenCalledOnce();
});

const keptDepartures = () => Object.entries(useSitting.getState().departures).filter(([, each]) => ['pending','confirmed','unconfirmed'].includes(each.status())).map(([id])=>id);

for (const end of ['cancelled', 'closed', 'closed elsewhere', 'refused'] as const) test(`a reloaded submission recovers its ${end} result without an ephemeral receipt`, () => {
  useDraftStore.setState({entries:{},unavailable:false});
  onTestFinished(()=>useDraftStore.setState({entries:{},unavailable:false}));
  const intent = intentAbout(reviewing, 'continue', people);
  const binding = end === 'refused'
    ? captureReaderIntent(intent, null, [reviewing], 'reloaded', scope, () => {}).reader!
    : captureReaderSend(doc,tasks,'reloaded').reader!;
  expect(freeze(scope.root,{conversationId:scope.conversationId,text:'',selected:{},attachments:[],...(end === 'refused' ? { intent } : {})},{requestId:'reloaded',doc:JSON.stringify(doc)},undefined,binding)).toBe('reloaded');
  const error=vi.spyOn(notify,'error');
  const snapshot=conversation('reloaded','succeeded',end==='refused'?result([],[{task:task.id,code:'conflict',message:'Task changed',retry:'reread'}]):null);
  if(end==='closed elsewhere') observeReaderConversation({...scope,conversationId:'new-conversation'});
  else if(end==='closed') closeReaderConversation(scope);
  else reconcileReaderSends({...snapshot,cancelled:end==='cancelled'?['reloaded']:[]});
  expect(holdsReaderTurn(useDraftStore.getState().entries,scope.root,binding[0]!)).toBe(false);
  expect(error).toHaveBeenCalledOnce();
});

test('a restored answer reference never promises a Task write, even if its saved binding names one', () => {
  const error = vi.spyOn(notify, 'error');
  onTestFinished(() => error.mockRestore());
  const binding = captureReaderSend(doc, tasks, 'restored-answer').reader!.map(reader => ({ ...reader,
    expectedWrites: [{ kind: 'answered' as const, question: 'Q1' }] }));
  freeze(scope.root, { conversationId: scope.conversationId, text: '', selected: {}, attachments: [] },
    { requestId: 'restored-answer', doc: JSON.stringify(doc) }, undefined, binding);
  useReaderSend.setState({ receipts: new Map() });
  reconcileReaderSends(conversation('restored-answer', 'succeeded', result()));
  reconcileOutbox(conversation('restored-answer', 'succeeded', result()), scope.root, null);
  expect(receiptOf('restored-answer')?.status).toBe('confirmed');
  expect(holdsReaderTurn(useDraftStore.getState().entries, scope.root, readerTurn(task))).toBe(false);
  const follow = captureReaderSend(doc, tasks, 'follow-up');
  expect(freeze(scope.root, { conversationId: scope.conversationId, text: serialize(doc, 'codex'), selected: {}, attachments: [] },
    { requestId: 'follow-up', doc: JSON.stringify(doc) }, undefined, follow.reader)).toBe('follow-up');
  expect(error).not.toHaveBeenCalled();
});

for (const action of ['continue','retry'] as const) test(`a free-text retry after refused ${action} participates in the same locally accepted submission`, () => {
  useDraftStore.setState({entries:{},unavailable:false});
  onTestFinished(()=>useDraftStore.setState({entries:{},unavailable:false}));
  const intent=intentAbout(reviewing,action,people),first=captureReaderIntent(intent,useSitting.getState().card,[reviewing],'earlier',scope,()=>{});
  expect(freeze(scope.root,{conversationId:scope.conversationId,text:'earlier',selected:{},attachments:[],intent},{requestId:'earlier',doc:JSON.stringify(textDocument('earlier'))},undefined,first.reader)).toBe('earlier');
  expect(first()).toBe(true);failReaderSend('earlier',scope,new ApiError('refused','conflict','reread'));
  const words=labelled(textDocument('この内容で進めてください'),reviewing),next=captureReaderSend(words,[reviewing],'later');
  expect(readerSendReadiness(words,[reviewing],null).ready).toBe(true);
  expect(freeze(scope.root,{conversationId:scope.conversationId,text:'words',selected:{},attachments:[]},{requestId:'later',doc:JSON.stringify(words)},undefined,next.reader)).toBe('later');
  expect(next()).toBe(true);moveOn([]);expect(submittedAnswers()?.map(each=>each.answer)).toEqual(['send']);
});


test('fixed answer payload records every named task even when another card is shown', () => {
  const other={...task,id:'T4',title:'Second question'};
  const doc=toggleAnswer(choose('Q1',1),other,choiceAnswer(answerTask(other),'Q1',decideOf(twoAsked)[0]!,decideOf(twoAsked)[0]!.choices[0]!));
  const accept=captureReaderSend(doc,[task,other],'multiple');
  freeze(scope.root,{conversationId:scope.conversationId,text:serialize(doc,'codex'),selected:{},attachments:[],...answeredQuestions(doc)},{requestId:'multiple',doc:JSON.stringify(doc)},undefined,accept.reader);
  accept();
  expect(holdsReaderTurn(useDraftStore.getState().entries,scope.root,readerTurn(task))).toBe(true);
  expect(holdsReaderTurn(useDraftStore.getState().entries,scope.root,readerTurn(other))).toBe(true);
  expect([...useReaderSend.getState().receipts.values()].map(receipt=>receipt.task.id).sort()).toEqual(['T3','T4']);
});
test('an offscreen intent still has its fixed task submission identity', () => {
  const intent={task:task.id,action:'continue' as const,expectedTaskHash:task.hash};
  const accept=captureReaderIntent(intent,null,[task],'offscreen',scope,()=>{});
  freeze(scope.root,{conversationId:scope.conversationId,text:'continue',selected:{},attachments:[],intent},{requestId:'offscreen',doc:JSON.stringify(textDocument('continue'))},undefined,accept.reader);
  expect(holdsReaderTurn(useDraftStore.getState().entries,scope.root,readerTurn(task))).toBe(true);
});

test('a hidden intent mark cannot submit the other task whose automatic context badge precedes it',()=>{
 const other={...task,id:'T4'},intent={task:task.id,action:'continue' as const,expectedTaskHash:task.hash};
 const doc=labelled(markReaderOperation(textDocument('T3 Approve')),other);
 const capture=captureReaderSubmission({intent},doc,[task,other],'marked',scope);
 expect(capture.reader.map(each=>each.taskId)).toEqual([task.id]);
 const mixed=toggleAnswer(doc,other,choiceAnswer(answerTask(other),'Q1',first,first.choices[0]!));
 const combined=captureReaderSubmission({intent,...answeredQuestions(mixed)},mixed,[task,other],'mixed',scope);
 expect(combined.reader.map(each=>each.taskId).sort()).toEqual([task.id,other.id].sort());
});

test('an empty Other after earlier prose cannot change into a free-text submission',()=>{
 const doc={...plainDoc,content:[...plainDoc.content,{type:'paragraph' as const,content:[{type:'text' as const,text:'Earlier explanation'}]},
  {type:'paragraph' as const,content:[{type:'answerLabel' as const,attrs:{task:task.id,question:'Q1',n:'1',name:'Other',answer:'1-other'}}]}]};
 expect(readerSendReadiness(doc,tasks,decideOf(twoAsked)).ready).toBe(false);
 expect(captureReaderSend(doc,tasks,'empty-other').reader).toEqual([]);
});


test('Open after closing a conversation restores into the current input, rather than an invisible old one', () => {
  const id = crypto.randomUUID(), next = 'after-clear', key = JSON.stringify([scope.root, 'coordinator', next]);
  const intent = intentAbout(reviewing, 'continue', people), doc = textDocument('original review words');
  const binding = { ...readerTurn(reviewing), title: reviewing.title, kind: 'intent' as const, answer: 'done' as const,
    expectedWrites: [{ kind: 'review_approved' as const, runId: 'R1' }] };
  freeze(scope.root, { conversationId: scope.conversationId, text: 'original review words', selected: {}, attachments: [], intent },
    { doc: JSON.stringify(doc), requestId: id }, undefined, [binding]);
  captureReaderIntent(intent, null, [reviewing], id, scope, () => {})();
  closeReaderConversation(scope);
  useDraftStore.setState(state => ({ entries: { ...state.entries, [key]: { status: 'editing', values: {
    doc: JSON.stringify(emptyDocument()), phase: 'prepared', requestId: crypto.randomUUID()
  } } } }));
  const before = useConversation.getState();
  setConversationState({ root: scope.root, conversation: { ...conversation('none', 'succeeded'), id: next, turns: [] } });
  try {
    const toast = useToasts.getState().toasts.at(-1)!;
    expect(toast.action).toBeDefined(); toast.action!.run();
    expect(useDraftStore.getState().entries[key]!.values.doc).toContain('original review words');
    expect(useDraftStore.getState().entries[key]!.values.readerDraftTask).toBe(reviewing.id);
    expect(useDraftStore.getState().entries[JSON.stringify([scope.root, 'coordinator', scope.conversationId])]).toBeUndefined();
  } finally { setConversationState(before); }
});

for (const code of ['question_closed', 'question_expired'] as const) test(`reader question refusal ${code} preserves the adopted reason and HTTP recovery policy`, async () => {
  await i18n.changeLanguage('en');
  const id = `reason-${code}`;
  captureReaderSend(doc, tasks, id)();
  const notices = vi.spyOn(notify, 'error');
  const error = new ApiError('The question is already closed', code, 'reread');
  const reason = i18n.t('ui:input.questionsChanged');
  expect(failReaderSend(id, scope, error, reason)).toBe(true);
  expect(notices).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    detail: expect.stringContaining(reason), action: expect.objectContaining({ label: 'Open' }), ongoing: false,
  }));
  expect(receiptOf(id)?.status).toBe('refused');
  expect(error.code).toBe(code); expect(error.retry).toBe('reread');
});

test('a review or completed-work send-back confirms its ordinary instruction', () => {
  for (const source of [reviewing, { ...reviewing, state: 'done' as const, ball: null }]) {
    useSitting.setState({ card: { taskId: 'T1' }, departures: {}, sent: null });
    const id = `send-back-${source.state}`;
    captureReaderIntent(intentAbout(source, 'sendback', people), { taskId: 'T1' }, [source], id, scope, () => {})();
    reconcileReaderSends(conversation(id, 'succeeded', result([wrote('request_accepted')])));
    expect(receiptOf(id)?.status).toBe('confirmed');
  }
});


test('delivery uncertainty has one slot per request even when it names several reader targets', () => {
  useToasts.setState({ toasts: [], hidden: new Set() });
  const other = { ...task, id: 'T4', title: 'Other question' };
  const several = { ...doc, content: [...doc.content, ...labelled(textDocument('Words for the other question'), other).content] };
  captureSend(several, [task, other], 'several', scope, () => {})();
  expect([...useReaderSend.getState().receipts.values()].filter(receipt => receipt.id === 'several')).toHaveLength(2);
  failReaderSend('several', scope, new ApiError('reply lost'));
  expect(useToasts.getState().toasts).toHaveLength(1);
  const first = useToasts.getState().toasts[0]!.id;
  captureSend(doc, tasks, 'another-request', scope, () => {})();
  failReaderSend('another-request', scope, new ApiError('another reply lost'));
  expect(useToasts.getState().toasts).toHaveLength(2);
  acknowledgeReaderSend('several', scope);
  expect(useToasts.getState().toasts).toHaveLength(1);
  expect(useToasts.getState().toasts[0]!.id).not.toBe(first);
});


test('closing a reader conversation ends its delivery notice and keeps other requests', () => {
  useToasts.setState({ toasts: [], hidden: new Set() });
  captureSend(doc, tasks, 'closed-delivery', scope, () => {})();
  failReaderSend('closed-delivery', scope, new ApiError('reply lost'));
  const slot = useToasts.getState().toasts[0]!.id;
  notify.error('other request remains', { id: 'other-request' });
  closeReaderConversation(scope);
  expect(useToasts.getState().toasts.some(toast => toast.id === slot)).toBe(false);
  expect(useToasts.getState().toasts.some(toast => toast.id === 'other-request')).toBe(true);
  expect(receiptOf('closed-delivery')?.status).toBe('closed');
});
for (const language of ['ja', 'en']) for (const proof of ['HTTP', 'queued', 'sending'] as const)
test(`reader delivery names its Task and confirms the explicit check in the same slot; ${language}/${proof}`, async () => {
  await i18n.changeLanguage(language); useToasts.setState({ toasts: [], hidden: new Set() });
  const retry = vi.fn(), id = 'named-reader-delivery', accept = captureSend(doc, tasks, id, scope, retry);
  freeze(scope.root, { conversationId: scope.conversationId, text: '', selected: {}, attachments: [] },
    { requestId: id, doc: JSON.stringify(doc) }, undefined, accept.reader); accept();
  failReaderSend(id, scope, new ApiError('reply lost'));
  const notice = useToasts.getState().toasts[0]!;
  expect(notice.text).toEqual(expect.stringContaining(`${task.id} ${task.title}`));
  expect(notice.text).toEqual(expect.stringContaining(language === 'ja' ? '確かめ' : 'Please check'));
  expect(notice.action!.label).toBe(i18n.t('reader:recovery.check'));
  notice.action!.run(); expect(retry).toHaveBeenCalledOnce();
  if (proof === 'HTTP') acknowledgeReaderSend(id, scope); else reconcileReaderSends(conversation(id, proof));
  const confirmed = useToasts.getState().toasts.find(toast => toast.id === notice.id)!;
  expect(confirmed?.kind).toBe('success');
  expect(confirmed.text).toEqual(expect.stringContaining(`${task.id} ${task.title}`));
  expect(confirmed.text).toEqual(expect.stringContaining(language === 'ja' ? 'に送りました' : 'Sent'));
  expect(confirmed.action).toBeUndefined();
  reconcileReaderSends(conversation(id, 'queued'));
  reconcileOutbox(conversation(id, 'queued'), scope.root, null);
  expect(useToasts.getState().toasts.find(toast => toast.id === notice.id)).toBe(confirmed);
});
