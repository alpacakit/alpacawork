import { acceptDeliveryNotice, deliveryNotice, endDeliveryNotice } from './delivery-notice';
import { useConversation } from './coordinator';
import { i18n } from "@alpacawork/i18n";
import { userTurn } from "@alpacawork/contract";
import { ApiError } from "@/data/client";
import { acknowledgeRecovery, clearRecovery, dismissRecovery, ownRecovery, readerFailure, readerSubmissionEnded, type RecoveryAnswer } from "@/features/reader/recovery";
import { create } from 'zustand';
import { useDraftStore } from '@/features/forms/draft-store';
import type { CoordinatorIntent } from '@alpacawork/contract/coordinator';
import type { Task } from '@/data/types';
import type { CoordinatorConversation } from '@/data/coordinator';
import { crewOf, type PeopleIndex } from '@/domain/people';
import { acceptedInReader, projectDepartures, onScreen, useSitting, useReaderTurnHeld, type Answer, type ReaderCard, type ReaderAdmission, type Departure } from '@/features/reader/next-question';
import { filterDocument, answeredQuestions, taskReferencesIn, answersIn, givenIn, saysFor, wordsAfter, type Document } from './editor/document';
import { readerOutcome, readerResult, readerSubmissionKey, readerTurn, type ReaderSubmission } from '@/features/reader/submission';
import { outgoing, restoreReaderDraft, returnReaderSubmission, useOutbox, type Fixed } from './editor/outbox';
import { departurePreviewed, readerActionsHeld } from '@/features/reader/departure';
import { useViewStore } from '@/state/view-store';
import { isOtherAnswer, type Question } from '@/domain/questions';

/**
 * What a press on the screen means for a Task, sent to the coordinator (sendIntent): Continue or Retry, with the versions the screen showed. Send back and a question's choices are the person's own words,
 * sent from the input's draft.
 */
export type SentIntent = CoordinatorIntent & { expectedTaskHash: string };
/**
 * The input's shared sender: `sendDraft` sends from its folded line; `action` sends its draft for the reader's gesture
 * while the draft answers the card.
 * `post` sends an intent beside the draft (null while the input cannot send). When the draft names the card but says
 * nothing yet, `missing` is what is left (readerSendReadiness), for the gesture to say so. Revision wakes the one reader
 * when delivery facts change.
 */
export const useReaderSend = create<{ sendDraft: (() => ReaderAdmission) | null; action: { tasks: readonly string[]; run: () => ReaderAdmission } | null;
  missing: MissingAnswer | null;
  post: ((intent: SentIntent, card: ReaderCard | null, text: string) => ReaderAdmission) | null; revision: number; receipts: Map<string, Receipt> }>(
  () => ({ sendDraft: null, action: null, missing: null, post: null, revision: 0, receipts: new Map() }));
/** Whether a press can send its intent now. */
export const useIntentReady = (task: Task) => {
  const available = useReaderSend(state => state.post !== null);
  const submitted = useReaderTurnHeld(task);
  return available && !submitted;
};

export type SendScope = { root: string; conversationId: string };
type Status = "pending" | "confirmed" | "unconfirmed" | "refused" | "cancelled" | "closed";
/**
 * One target in a fixed message, independent of which card is visible. A message can answer several Task turns.
 * The outbox owns the frozen submissions; these receipts project delivery/results and notices. `expectedWrites` is null
 * for words and answer references, or the explicit operation's expected record. `admitted` records serve holding the submission.
 */
type Receipt = SendScope & {
  readonly previewed: boolean; id: string; card: ReaderCard | null; task: Pick<Task, 'id' | 'title'>; binding: ReaderSubmission; status: Status; admitted: boolean; retry?: () => void;
  departure?: Departure; resultKnown?: boolean };
const allReceipts = () => useReaderSend.getState().receipts;
const receiptKey = (id: string, scope: SendScope & { task?: Pick<Task, 'id'>; binding?: ReaderSubmission }) => JSON.stringify([scope.root, scope.conversationId, id, scope.task?.id, scope.binding?.turn]);
const keyOf = (receipt: Receipt) => receiptKey(receipt.id, receipt);
const forMessage = (id: string, scope: SendScope) => [...allReceipts().values()].filter(receipt => receipt.id === id && receipt.root === scope.root && receipt.conversationId === scope.conversationId);
const inConversation = (scope: SendScope) => [...allReceipts().values()].filter(receipt => receipt.root === scope.root && receipt.conversationId === scope.conversationId);
/** A receipt changed: the departures read it again, and the one reader wakes (`revision`). */
function publish() {
  projectDepartures();
  useReaderSend.setState(state => ({ revision: state.revision + 1 }));
}
/** The turn a draft answers on the card: a review waiting on the user, or a question asked of them (not one held). */
export const answeringTurn = (task: Task) => {
  const turn = userTurn(task.ball);
  return task.state !== 'held' && (turn?.reason === 'review' || turn?.reason === 'question') ? turn : null;
};
/** How a departure reads what became of its message: a withdrawn or closed one was not carried out. */
const statusOf = (receipt: Receipt) => receipt.status === 'cancelled' || receipt.status === 'closed' ? 'refused' : receipt.status;
const recoveryOf = ({ binding }: Receipt): RecoveryAnswer => binding.kind === 'intent' ? binding.answer ?? 'restore' : 'send';
/**
 * A message's outcome, said once it is known: confirmed takes back its notice, refused says so (Open). A known write
 * fault is checked on the Task, never by proving HTTP delivery again.
 */
function tell(receipt: Receipt, outcome: ReturnType<typeof readerResult>) {
  const { id, task } = receipt, latest = useSitting.getState().departures[task.id];
  if (receipt.binding.kind === 'answer' && latest && latest.id !== id) return;
  if (outcome.status === 'confirmed') clearRecovery(task.id, keyOf(receipt));
  else {
    if (readerOutcome(outcome.status) === 'returned') returnReaderSubmission(receipt.root, id, '', receipt.binding);
    readerFailure(task, recoveryOf(receipt), outcome.error, () => useViewStore.getState().openTask(task.id, { reader: true }), keyOf(receipt), reopen(receipt));
  }
}
/** Recovery is requested by the notice, rather than inferred from what the panel happens to show. */
const reopen = (receipt: Receipt) => () => {
  const current = useConversation.getState();
  // The source submission may belong to a closed conversation; recovery enters the input shown now.
  return current.root === receipt.root && !!current.conversation &&
    restoreReaderDraft(receipt.root, current.conversation.id, receipt.task.id) !== 'blocked';
};
/** The outbox accepted this submission; only this opening's animation event is recorded here. */
function retire(receipt: Receipt, answer: Answer, ball: Task['ball']) {
  const turn = userTurn(ball);
  if (!turn) return false;
  const departure: Departure = { answer, id: receipt.id, previewed: receipt.previewed, turn: turn.key, admitted: () => receipt.admitted, status: () => statusOf(receipt) };
  const accepted = acceptedInReader(receipt.card, receipt.task.id, ball, departure);
  if (useSitting.getState().departures[receipt.task.id] === departure) receipt.departure = departure;
  return accepted;
}

/**
 * The card a draft is about, used to offer its sending gesture. Context does not promise to settle the turn.
 */
function readerTarget(doc: Document, tasks: readonly Task[]) {
  const card = useSitting.getState().card;
  const task = tasks.find(task => task.id === card?.taskId);
  const turn = task ? answeringTurn(task) : null;
  if (!task || !card || !turn || !taskReferencesIn(doc, tasks).has(task.id) || !onScreen(card, task.id)) return null;
  return { card, task, turn };
}
/**
 * One classification of the draft offered as this opening's reply. Both readiness and submission use it: words for
 * the current Task participate just as choices do. Only explicit answer data adds a write expectation.
 */
function readerDraft(doc: Document, tasks: readonly Task[], asked: readonly Question[] | null) {
  const target = readerTarget(doc, tasks);
  if (!target) return { submission: null, missing: null };
  const { card, task, turn } = target, question = turn.questionId;
  const answers = answersIn(doc, task.id), put = answers.filter(answer => answer.question === question);
  const silent = put.find(answer => isOtherAnswer(answer) && !wordsAfter(doc, answer));
  const binding = submissionFacts(answeredQuestions(doc), doc, tasks)
    .find(each => each.binding.taskId === task.id && each.binding.turn === turn.key);
  if (!binding) {
    const n = silent?.n ?? asked?.find(each => !put.some(answer => answer.n === each.n))?.n ?? asked?.[0]?.n;
    return { submission: null, missing: !question || n === undefined ? null : { task: task.id, question, n, words: !!silent } };
  }
  return { submission: { card, task }, missing: null };
}

/** The fixed payload owns every submission target. The screen only chooses which one flies. */
function submissionFacts(fixed: Pick<Fixed, 'intent' | 'answers'>, doc: Document, tasks: readonly Task[]) {
  const bindings: { task: Task; binding: ReaderSubmission }[] = [];
  const intent = fixed.intent, intentTask = intent && tasks.find(task => task.id === intent.task);
  if (intent && intentTask) bindings.push({
    task: intentTask, binding: {
      ...readerTurn(intentTask), ...(intent.question ? { turn: intent.question } : {}), kind: 'intent', title: intentTask.title,
      // What carries the press out: a request; for a failure's Continue (same or another AI) also a new responsible, whose handover restarts the work.
      // (A release followed by a separate placement records the same kind without a handover; the coordinator's reply,
      // which holds any words written with the press, is where that shows.)
      answer: 'send', expectedWrites: intent.action === 'retry' || intent.action === 'switch' ? [{ kind: 'request_accepted' }, { kind: 'responsible_changed' }] : [{ kind: 'request_accepted' }],
    }
  });
  for (const answer of fixed.answers ?? []) {
    const task = tasks.find(task => task.id === answer.task);
    if (!task || intent?.task === task.id && (intent.question ?? readerTurn(task).turn) === answer.question) continue;
    const choices = answersIn(doc, task.id).filter(each => each.question === answer.question);
    if (!givenIn(doc, task.id).some(each => each.question === answer.question) || choices.some(each => isOtherAnswer(each) && !wordsAfter(doc, each))) continue;
    bindings.push({
      task, binding: {
        ...readerTurn(task), turn: answer.question, kind: 'answer', title: task.title, answer: 'send',
        expectedWrites: null,
      }
    });
  }
  // A restored operation's marked words belong only to its intent Task, never to another automatic context badge.
  const words = intent ? filterDocument(doc, node => node.type !== 'text' || !node.marks?.some(mark => mark.type === 'readerOperation')) : doc;
  for (const id of taskReferencesIn(words, tasks)) {
    if (bindings.some(each => each.task.id === id) || fixed.answers?.some(answer => answer.task === id)) continue;
    const task = tasks.find(task => task.id === id);
    if (!task || !answeringTurn(task) || !saysFor(words, id)) continue;
    bindings.push({ task, binding: { ...readerTurn(task), kind: 'answer', title: task.title, answer: 'send', expectedWrites: null } });
  }
  return [...new Map(bindings.map(each => [readerSubmissionKey(each.binding), each])).values()];
}
export function captureReaderSubmission(fixed: Pick<Fixed, 'intent' | 'answers'>, doc: Document, tasks: readonly Task[], requestId: string,
  scope: SendScope, retry?: () => void, card: ReaderCard | null = useSitting.getState().card) {
  const snapshots = submissionFacts(fixed, doc, tasks).map(({ task, binding }) => {
    const visual = userTurn(task.ball)?.key === binding.turn && (binding.kind === 'intent' || !!answeringTurn(task));
    const shown = visual && onScreen(card, task.id);
    return { task, binding, visual, card: shown ? card : null, previewed: shown && departurePreviewed() };
  });
  const accept = () => {
    let retired = false;
    for (const old of forMessage(requestId, scope)) if (old.status === 'refused') allReceipts().delete(keyOf(old));
    for (const snapshot of snapshots) {
      const { task, binding } = snapshot, key = receiptKey(requestId, { ...scope, task, binding }), previous = allReceipts().get(key);
      if (previous && previous.status !== 'refused') { if (previous.status === 'unconfirmed') previous.status = 'pending'; continue; }
      const { visual: _visual, ...submitted } = snapshot;
      const receipt: Receipt = { ...scope, id: requestId, ...submitted, status: 'pending', admitted: false, retry };
      allReceipts().set(key, receipt); ownRecovery(task.id, key);
      if (snapshot.visual && binding.answer) retired = retire(receipt, binding.answer, task.ball) || retired;
    }
    projectDepartures(); return retired;
  };
  return Object.assign(accept, { reader: snapshots.map(snapshot => snapshot.binding) });
}

/** One question a draft leaves unanswered on the card: its task, its asking and number; `words`, its Other waits for what to say. */
export type MissingAnswer = { task: string; question: string; n: string; words: boolean };
/**
 * Whether sending the draft now answers the card on screen (a swipe sends it), as its admission would read it
 * (`ready`), and when it names the card but says nothing, what is left (`missing`): an Other put in with nothing
 * written after it, else the first of `asked`'s questions (the card's open question as read) with no choice. A choice
 * answers, and so do words of the person's own written for the card's task; Other with nothing after it says nothing.
 */
export function readerSendReadiness(doc: Document, tasks: readonly Task[], asked: readonly Question[] | null): { ready: boolean; missing: MissingAnswer | null } {
  const { submission, missing } = readerDraft(doc, tasks, asked);
  return { ready: submission !== null, missing };
}

/** The one line a press says in the conversation, made here: serve makes no words of an intent. */
function intentLine(action: SentIntent['action'], id: string) {
  switch (action) {
    case 'sendback': return i18n.t('reader:intent.sendback', { id });
    case 'continue': return i18n.t('reader:intent.continue', { id });
    case 'retry': return i18n.t('reader:intent.retry', { id });
    case 'switch': return i18n.t('reader:intent.switch');
  }
}
/**
 * An intent on `task` as the screen shows it now: the Run its review is about or the question it asks (its ball), and
 * the versions it shows (the Task's and its responsible's), which the coordinator passes on as they are.
 */
export function intentAbout(task: Task, action: SentIntent['action'], people: PeopleIndex): SentIntent {
  const turn = userTurn(task.ball), revision = crewOf(task.id, people).responsible?.revision;
  return { task: task.id, action, ...(turn?.aboutRunId ? { aboutRun: turn.aboutRunId } : {}),
    ...(turn?.questionId ? { question: turn.questionId } : {}), expectedTaskHash: task.hash,
    ...(revision === undefined ? {} : { expectedPlacementRevision: revision }) };
}
/** A new user retry keeps its target and words, but quotes the version the user has now reviewed. */
export function retryReaderIntent(intent: SentIntent, task: Task, people: PeopleIndex): SentIntent {
  const current = intentAbout(task, intent.action, people);
  const { expectedPlacementRevision: _old, ...sameTarget } = intent;
  return { ...sameTarget, expectedTaskHash: current.expectedTaskHash,
    ...(current.expectedPlacementRevision === undefined ? {} : { expectedPlacementRevision: current.expectedPlacementRevision }) };
}
/**
 * The press of Continue or Retry: the intent goes to the coordinator as a message of its own
 * beside the input's draft (its words the one line made here, then what the person wrote with it, `words`), through the
 * input's one way of sending. Its receipt, card and notices are kept here. `card` is the reader's card where the press
 * started (useReaderCard; null outside the reader, or for an input opened outside it): only that card can leave.
 */
export function sendIntent(intent: SentIntent, card: ReaderCard | null, words = ''): ReaderAdmission {
  // A resting stamp shields the next card's actions wherever their controls are drawn. A carried swipe has no hold.
  if (card && onScreen(card, intent.task) && readerActionsHeld()) return 'rejected';
  const post = useReaderSend.getState().post;
  if (!post) return 'rejected';
  return post(intent, card, [intentLine(intent.action, intent.task), words.trim()].filter(Boolean).join('\n\n'));
}
/** Local cancellation is silent; the undo frame says what happened. */
export function cancelLocalReaderSend(requestId: string, scope: SendScope) {
  for (const receipt of forMessage(requestId, scope)) {
    receipt.status = 'cancelled';
    dismissRecovery(receipt.task.id, keyOf(receipt));
    restoreReaderDraft(scope.root, scope.conversationId, receipt.task.id);
  }
  publish();
}

export function failReaderSend(requestId: string, scope: SendScope, error: unknown, reason?: string) {
  const items = forMessage(requestId, scope);
  for (const receipt of items) {
    if (receipt.admitted || receipt.status === 'cancelled' || receipt.status === 'closed' || receipt.status === 'confirmed') continue;
    const failure = error instanceof ApiError ? error : Object.assign(new ApiError('Cannot confirm coordinator response'), { cause: error });
    receipt.status = failure.retry === 'check' ? 'unconfirmed' : 'refused';
    if (readerOutcome(receipt.status) === 'returned') returnReaderSubmission(receipt.root, requestId, reason ?? failure.displayMessage, receipt.binding);
    if (receipt.status !== 'unconfirmed') readerFailure(receipt.task, recoveryOf(receipt), failure, receipt.retry ?? (() => { }), keyOf(receipt), reopen(receipt), reason);
  }
  const unknown = items.find(receipt => receipt.status === 'unconfirmed' && !receipt.admitted);
  if (unknown) {
    const names = [...new Map(items.map(receipt => [receipt.task.id, `${receipt.task.id} ${receipt.task.title}`])).values()].join(i18n.t('ui:coordinatorCard.readerTargetSeparator'));
    deliveryNotice(scope.root, requestId, i18n.t('ui:coordinatorCard.readerUnconfirmed', { tasks: names }),
      { kind: 'delivery', action: { label: i18n.t('reader:recovery.check'), run: unknown.retry ?? (() => {}) }, confirmation: i18n.t('ui:coordinatorCard.readerConfirmed', { tasks: names }) });
  }
  publish();
  return items.length > 0;
}

/** Proven HTTP admission, from its response or a matching snapshot, is independent of the AI's result. */
function admit(receipt: Receipt) {
  // Reader admission proves the original ask; the outbox alone settles a later withdrawal.
  const item = outgoing(useDraftStore.getState().entries, receipt.root, receipt.conversationId).find(item => item.requestId === receipt.id);
  if (item?.last !== 'withdraw') acceptDeliveryNotice(receipt.root, receipt.id);
  receipt.admitted = true;
  if (receipt.resultKnown) return;
  if (receipt.status === 'unconfirmed') receipt.status = 'pending';
  if (readerOutcome(receipt.status) === 'kept') acknowledgeRecovery(receipt.task.id, keyOf(receipt));
}
/** Serve holds this immutable submission; settle its Check without claiming its expected write happened. */
export function acknowledgeReaderSend(requestId: string, scope: SendScope) {
  const items = forMessage(requestId, scope);
  for (const receipt of items) admit(receipt);
  publish();
  return items.some(receipt => receipt.departure !== undefined);
}

/** Withdrawn, or its conversation closed, before its outcome was known: a known outcome stays as it is. */
function terminate(receipt: Receipt, status: 'cancelled' | 'closed') {
  if (receipt.status !== 'pending' && receipt.status !== 'unconfirmed') return;
  receipt.status = status;
  endDeliveryNotice(receipt.root, receipt.id);
  returnReaderSubmission(receipt.root, receipt.id, '', receipt.binding);
  readerSubmissionEnded(receipt.task, recoveryOf(receipt), status, keyOf(receipt), reopen(receipt));
  projectDepartures();
}
/** Rebuild only the result projection after reload; the outbox owns the submitted turn and original input.
 * No departure/card/completion event is reconstructed. */
function restoreReaderReceipts(scope: SendScope) {
  for (const item of outgoing(useDraftStore.getState().entries, scope.root, scope.conversationId)) {
    if (!item.reader || item.stage === 'refused') continue;
    for (const binding of item.reader) {
      if (item.returned.includes(readerSubmissionKey(binding))) continue;
      const task = { id: binding.taskId, title: binding.title }, key = receiptKey(item.requestId, { ...scope, task, binding });
      if (allReceipts().has(key)) continue;
      const retry = () => { void useOutbox.getState().resend?.(item.requestId); };
      allReceipts().set(key, { ...scope, id: item.requestId, task, binding, card: null, previewed: false,
        status: 'pending', admitted: item.stage === 'accepted', retry });
      ownRecovery(task.id, key);
    }
  }
}
export function closeReaderConversation(scope: SendScope) {
  restoreReaderReceipts(scope);
  for (const receipt of inConversation(scope)) terminate(receipt, 'closed');
  publish();
}
/** A drawn current conversation also resolves persisted submissions whose conversation ended while this page was away. */
export function observeReaderConversation(scope: SendScope) {
  const previous = new Set(outgoing(useDraftStore.getState().entries,scope.root).filter(item=>item.reader && item.stage!=='refused').map(item=>item.fixed.conversationId));
  for (const conversationId of previous) if (conversationId!==scope.conversationId) closeReaderConversation({...scope,conversationId});
}
/** Receipt/result facts update a submitted card; they never start its departure or replay its completion. */
export function reconcileReaderSends(conversation: CoordinatorConversation, root: string) {
  restoreReaderReceipts({root,conversationId:conversation.id});
  for (const receipt of inConversation({ root, conversationId: conversation.id })) {
    if (conversation.cancelled.includes(receipt.id)) terminate(receipt, 'cancelled');
    const turn = conversation.turns.find(each => each.id === receipt.id);
    if (!turn || receipt.resultKnown || receipt.status !== 'pending' && receipt.status !== 'unconfirmed') continue;
    admit(receipt);
    if (!turn.result) continue;
    const outcome = readerResult(receipt.binding, turn.result);
    receipt.resultKnown = true;
    receipt.status = outcome.status;
    tell(receipt, outcome);
  }
  publish();
}

/** Once original input is editable again, its reader recovery entrance has been consumed. Remaining targets keep theirs. */
export function dismissRecoveredReaderSends(requestId: string, scope: SendScope) {
  const remaining = outgoing(useDraftStore.getState().entries, scope.root, scope.conversationId).find(item => item.requestId === requestId)?.reader ?? [];
  const keys = new Set(remaining.map(readerSubmissionKey));
  for (const receipt of forMessage(requestId, scope))
    if (!keys.has(readerSubmissionKey(receipt.binding))) dismissRecovery(receipt.task.id, keyOf(receipt));
}
/** Whether the reader's notices say what became of this send (coordinator.ts then says nothing of its delivery). */
export const ownsReaderSend = (id: string, scope: SendScope) => {
  return forMessage(id, scope).length > 0;
};
