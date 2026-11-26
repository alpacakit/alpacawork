import { snapshotJson, messageJson, serving, served, SERVED } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { answerTask } from './fixtures';
import { labelled } from './fixtures';
import * as attachmentAPI from '../src/data/attachments';
import {useAttachments} from '../src/features/reader/Attachments';
import {attachmentsOf} from '../src/domain/attachments';
import { readerTurn } from '../src/features/reader/submission';
import { submittedReaderTurn } from '../src/features/reader/submitted-turns';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { mutateInput } from '../src/features/coordinator/editor/draft';
import { observed } from '../src/features/coordinator/editor/lifecycle';
import { availableInput, inputDraftFiles, canTakeBack, begin, cancelUnsent, freeze, holds, outgoingDisplay, holdsReaderTurn, awaitsReaderResult, observeReaderTurns, nextDelivery, outgoing, outgoingKey, reconcileOutbox, refuse, restoreReaderDraft, parkedReaderDraft, returnReaderSubmission, takeBack, useOutbox } from "../src/features/coordinator/editor/outbox";
import { draftKey, readDrafts, updateDraft, useDraftStore } from "../src/features/forms/draft-store";
import { choiceAnswer, emptyDocument, markReaderOperation, textDocument, toggleAnswer } from "../src/features/coordinator/editor/document";
import { decideOf } from "../src/domain/questions";
import { api } from "../src/data/resources";
import { useConversation } from "../src/features/coordinator/coordinator";
import { ShownConversationProvider, useShownConversation } from "../src/features/coordinator/shown";
import { CoordinatorInput } from "../src/features/coordinator/CoordinatorInput";
import { notify } from "../src/lib/notify";
import { useReaderSend } from "../src/features/coordinator/reader-send";
import { setAutoSwipe, useSitting } from "../src/features/reader/next-question";
import { useViewStore } from "../src/state/view-store";
import { at, logEntry, decideItem, questionFixture, screenData, taskFixture, TestWorkspace, tree, userBall, viewsOf } from "./fixtures";
import { WaitingReportActions } from "../src/features/reader/WaitingReportActions";

// The outbox and its projection keep a request in the conversation it
// was sent to, take a turn for it only as it was sent, and settle it only where a drawn snapshot holds it.
const root = "/fixture", cid = "old-conversation", key = draftKey(root, "coordinator", cid);
const conv = (id = cid, turns: any[] = []) => served({ id, nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns });
const values = (text = "", id: string = crypto.randomUUID()) => ({ body: "", doc: JSON.stringify(textDocument(text)), requestId: id });
const fixed = (text = "sent") => ({ conversationId: cid, text, attachments: [] });
const sentTurn = (id: string, ask = "sent", status = "running") => ({ id, at: new Date().toISOString(), ask, attachments: [], status, waiting: status === "queued" || status === "sending", answer: null, seen: false, answeredAt: null, error: null, result: null });
const reply = (body: unknown, status = 200) => new Response(snapshotJson(body), { status });
let shown: ReturnType<typeof useShownConversation>;
function Probe() { shown = useShownConversation(); return createElement("output", { "data-testid": "rows" }, JSON.stringify(shown.local)); }
function setup(text = "sent") {
  const id = crypto.randomUUID();
  setConversationState({ root, conversation: conv(), open: true, expanded: true, engaged: false, read: true, error: null });
  useDraftStore.setState({ entries: { [key]: { status: "editing", values: values(text, id) } }, unavailable: false });
  return id;
}
/** T1 waiting on the user's review of R1, as the server sends it: the answer in the input is about that review. */
const waitingReview = () => screenData(tree({ tasks: [taskFixture({ id: "T1", state: "waiting",
  log: [logEntry({ id: "L1", kind: "reported", toState: "waiting" })], ball: userBall("review", "L1", at, { aboutRunId: "R1" }) })] }));
beforeAll(async () => { await startI18n(); await i18n.changeLanguage("en"); });
beforeEach(() => {
  // Its sends from the input are read leaving their cards: auto-swipe on.
  setAutoSwipe(true);
  useReaderSend.setState({ receipts: new Map() }); useOutbox.setState({ live: new Set(), resend: null }); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useOutbox.setState({ live: new Set(), resend: null }); });

test("a turn under the same ID with other words is not taken for this request: it is kept apart, not settled, and stays drawn, refused, beside that turn", () => {
  const id = setup(); freeze(root, fixed("original request"), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  const attempt = begin(root, id)!; attempt.check(); attempt.finish();
  const next = conv(cid, [sentTurn(id, "different request")]);
  reconcileOutbox(next, root, null, true, "conflict"); setConversationState({ conversation: next });
  const kept = useDraftStore.getState().entries[outgoingKey(root, id)]!;
  expect(JSON.parse(kept.values.submitted!).text).toBe("original request");
  expect(kept.values.stage).toBe("refused"); expect(kept.values.conflict).toBe("1");
  expect(holds(useDraftStore.getState().entries, root, cid)).toBe(false);
  render(createElement(ShownConversationProvider, null, createElement(Probe)));
  expect(JSON.parse(screen.getByTestId("rows").textContent!)).toMatchObject([{ id, ask: "original request", stage: "refused" }]);
});

test("an ID conflict from serve still refuses ordinary text in the outbox and the conversation", async () => {
  const id = setup();
  const errors = vi.spyOn(notify, "error");
  const data = waitingReview();
  const task = data.tasks[0]!;
  useViewStore.getState().openTask(task.id, { reader: true });
  useSitting.setState({ card: { taskId: task.id }, departures: {}, sent: null, emptied: null } as never);
  useDraftStore.setState({ entries: { [key]: { status: "editing", values: { ...values("", id), doc: JSON.stringify(labelled(textDocument("answer"), task)) } } } });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => url === "/api/coordinator/messages"
    ? reply({ error: { code: "idempotency_conflict", message: "ID belongs to different input", retry: "reread" } }, 409)
    : reply({ status: "unavailable", profile: "claude", skills: [] })));
  render(<TestWorkspace data={data}><CoordinatorInput launch={{ next: { agent: 'claude', values: {} }, ready: false }} /></TestWorkspace>);
  fireEvent.click(document.querySelector("[data-ask-send]")!);
  await waitFor(() => expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.stage).toBe("refused"));
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]!.values.conflict).toBe("1");
  expect([...useReaderSend.getState().receipts.values()].map(receipt => ({ admitted: receipt.admitted, status: receipt.status })))
    .toEqual([{ admitted: false, status: 'refused' }]);
  expect(holds(useDraftStore.getState().entries, root, cid)).toBe(false);
  expect(errors).toHaveBeenCalledOnce();
});

test("a request drawn while it is sent stays in its own conversation when the conversation changes", async () => {
  const id = setup(); freeze(root, fixed(), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  const attempt = begin(root, id)!; attempt.check();
  let resolve!: () => void; const pending = new Promise<void>(done => { resolve = done; });
  render(createElement(ShownConversationProvider, null, createElement(Probe)));
  let result!: Promise<unknown>;
  act(() => { result = shown.send({ id, ask: "sent", attachments: [], at: new Date().toISOString(), root, conversationId: cid, stage: "sending", refusal: null }, () => pending.finally(attempt.finish)); });
  expect(screen.getByTestId("rows").textContent).toContain(id);
  act(() => setConversationState({ conversation: conv("new-conversation") }));
  const after = screen.getByTestId("rows").textContent;
  await act(async () => { resolve(); await result; });
  expect(after).not.toContain(id);
});

test("a card mounted again while a request is sent still draws it, from the outbox", async () => {
  const id = setup(); freeze(root, fixed(), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  const attempt = begin(root, id)!; attempt.check();
  let resolve!: () => void; const pending = new Promise<void>(done => { resolve = done; });
  const view = render(createElement(ShownConversationProvider, null, createElement(Probe)));
  let result!: Promise<unknown>;
  act(() => { result = shown.send({ id, ask: "sent", attachments: [], at: new Date().toISOString(), root, conversationId: cid, stage: "sending", refusal: null }, () => pending.finally(attempt.finish)); });
  view.unmount();
  render(createElement(ShownConversationProvider, null, createElement(Probe)));
  expect(JSON.parse(screen.getByTestId("rows").textContent!)).toMatchObject([{ id, stage: "sending" }]);
  await act(async () => { resolve(); await result; });
});

test("a send whose answer was lost and whose turn left the recent ones is settled by its own status", async () => {
  const id = setup(); freeze(root, fixed(), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  const attempt = begin(root, id)!; attempt.check(); attempt.finish();
  // Twenty newer exchanges since: the read holds none of it; its status says serve took this very input and answered.
  const taken = conv(cid, [{ ...sentTurn(id, "sent", "succeeded"), answer: "done", answeredAt: new Date().toISOString() }]);
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url === "/api/coordinator"
    ? Promise.resolve(new Response(snapshotJson(conv(cid, [])))) : serving(taken)(url, init)));
  setConversationState({ conversation: conv(cid, []) });
  await useConversation.getState().refresh();
  await waitFor(() => expect(useDraftStore.getState().entries[outgoingKey(root, id)]).toBeUndefined());
});

test("an accepted answer that loses the race to be drawn keeps the request drawn and asks for a newer read", async () => {
  const id = setup(); freeze(root, fixed(), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  const attempt = begin(root, id)!; attempt.check(); attempt.finish();
  let resolve!: (response: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
  const queued = conv(cid, [sentTurn(id, "sent", "queued")]);
  const fetcher = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(reply(conv())).mockImplementation(serving(queued));
  vi.stubGlobal("fetch", fetcher);
  const post = useConversation.getState().ask({ ...fixed(), id });
  await useConversation.getState().refresh();
  resolve(new Response(messageJson(queued, id)));
  await post;
  // Not drawn yet: kept to draw (accepted, not holding the next send), and a newer read is asked for.
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.stage).toBe("accepted");
  expect(holds(useDraftStore.getState().entries, root, cid)).toBe(false);
  await waitFor(() => expect(useConversation.getState().conversation!.turns.some(turn => turn.id === id)).toBe(true));
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.stage).toBe('accepted');
});

test("a read giving the request's ID to other words does not confirm the answers it carried, before or after the conflict", async () => {
  const id = setup();
  const data = waitingReview();
  const task = data.tasks[0]!;
  useViewStore.getState().openTask(task.id, { reader: true });
  useSitting.setState({ card: { taskId: task.id }, departures: {}, sent: null, emptied: null } as never);
  useDraftStore.setState({ entries: { [key]: { status: "editing", values: { ...values("", id), doc: JSON.stringify(labelled(textDocument("answer"), task)) } } } });
  let resolve!: (response: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
  const fetcher = vi.fn().mockImplementation(async (url: string) => url === "/api/coordinator/messages" ? pending
    : url === "/api/coordinator" ? reply(conv(cid, [sentTurn(id, "different answer")])) : reply({ status: "unavailable", profile: "claude", skills: [] }));
  vi.stubGlobal("fetch", fetcher);
  render(<TestWorkspace data={data}><CoordinatorInput launch={{ next: { agent: 'claude', values: {} }, ready: false }} /></TestWorkspace>);
  fireEvent.click(document.querySelector("[data-ask-send]")!);
  await waitFor(() => expect(fetcher.mock.calls.some(call => call[0] === "/api/coordinator/messages")).toBe(true));
  await act(() => useConversation.getState().refresh());
  expect([...useReaderSend.getState().receipts.values()][0]?.status).not.toBe("confirmed");
  await act(async () => { resolve(reply({ error: { code: "idempotency_conflict", message: "different input", retry: "reread" } }, 409)); await pending; });
  await waitFor(() => expect(useOutbox.getState().live.size).toBe(0));
  expect([...useReaderSend.getState().receipts.values()].map(receipt => ({ admitted: receipt.admitted, status: receipt.status })))
    .toEqual([{ admitted: false, status: 'refused' }]);
  // Taken back into the input (under the input's own ID), the old ID stays apart: a later read confirms nothing.
  // This isolated input has no reader footer; taking it back preserves the old ID's isolation.
  expect(takeBack(root, id)).toBe(true);
  expect(useDraftStore.getState().entries[key]!.values.requestId).not.toBe(id);
  await act(() => useConversation.getState().refresh());
  expect([...useReaderSend.getState().receipts.values()][0]?.status).not.toBe("confirmed");
});

// Q1's and Q2's first choice read the same in the words; the message says which questions the draft answers.
for (const questions of [["Q1"], ["Q2"], ["Q1", "Q2"]]) test(`a draft choosing ${questions.join(" and ")}'s choice goes with ${questions.join(" and ")}, for the coordinator to answer those`, async () => {
  const id = setup();
  const decide = [decideItem("Which one?", [["OptionA", "Proceed"], ["OptionB", "Restore"]])];
  const served = tree({ tasks: [taskFixture({ id: "T1", state: "doing", ball: userBall("question", "Q2", at, { questionId: "Q2" }) })],
    questions: [questionFixture({ id: "Q1", decide }), questionFixture({ id: "Q2", decide })] });
  const data = screenData(served), task = data.tasks[0]!, asked = decideOf(decide)[0]!;
  const doc = questions.reduce((doc, question) => toggleAnswer(doc, task, choiceAnswer(answerTask(task), question, asked, asked.choices[0]!)),
    labelled(textDocument(""), task));
  useDraftStore.setState({ entries: { [key]: { status: "editing", values: { ...values("", id), doc: JSON.stringify(doc) } } } });
  const view = vi.spyOn(api, "request").mockResolvedValue(viewsOf(served)[0]!);
  const posted: { text: string; tasks?: string[]; context?: unknown; intent?: unknown; answers?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/coordinator/messages") { posted.push(JSON.parse(String(init!.body))); return reply(conv(cid, [sentTurn(id, posted[0]!.text, "queued")])); }
    return reply({ status: "unavailable", profile: "claude", skills: [] });
  }));
  try {
    render(<TestWorkspace data={data}><CoordinatorInput launch={{ next: { agent: 'claude', values: {} }, ready: false }} /></TestWorkspace>);
    fireEvent.click(document.querySelector("[data-ask-send]")!);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ text: `${task.id}（${task.title}） ${questions.map(() => "1-OptionA").join(" ")}`, tasks: [task.id],
      answers: questions.map(question => ({ task: task.id, question })) });
    expect(posted[0]!.intent).toBeUndefined();
    expect(posted[0]).not.toHaveProperty("context");
  } finally { view.mockRestore(); }
});

test("typing stays outside the shown conversation, while outgoing stages and another conversation still follow their sources", () => {
  const id = setup();
  const rendered = vi.fn();
  function ConversationProbe() {
    const view = useShownConversation();
    rendered();
    return createElement("output", { "data-testid": "projection" }, JSON.stringify(view.local));
  }
  render(createElement(ShownConversationProvider, null, createElement(ConversationProbe)));
  rendered.mockClear();
  act(() => useDraftStore.setState(state => ({ entries: { ...state.entries,
    [key]: { status: "editing", values: values("still writing", id) } } })));
  expect(rendered).not.toHaveBeenCalled();
  act(() => { freeze(root, fixed("sent words"), useDraftStore.getState().entries[key]!.values, { from: key }); });
  expect(JSON.parse(screen.getByTestId("projection").textContent!)).toMatchObject([{ id, ask: "sent words", stage: "queued" }]);
  let attempt: ReturnType<typeof begin>;
  act(() => { attempt = begin(root, id); });
  expect(JSON.parse(screen.getByTestId("projection").textContent!)).toMatchObject([{ id, stage: "sending" }]);
  act(() => { attempt!.check(); attempt!.finish(); });
  expect(JSON.parse(screen.getByTestId("projection").textContent!)).toMatchObject([{ id, stage: "unknown" }]);
  act(() => setConversationState({ conversation: conv("another-conversation") }));
  expect(JSON.parse(screen.getByTestId("projection").textContent!)).toEqual([]);
});

// Real input -> fixed request -> conversation result -> reader/recovery.
for (const about of ['context', 'raw ID', 'no ID'] as const)
for (const state of ['review', 'question'] as const)
test(`ordinary text (${about}, ${state}) has no expected write or failure toast`, async () => {
  const id = setup();
  const data = screenData(tree({ tasks: [taskFixture({ id: 'T1', state: 'doing',
    ball: userBall(state, 'Q1', at, state === 'question' ? { questionId: 'Q1' } : { aboutRunId: 'R1' }) })] }));
  const task = data.tasks[0]!;
  useViewStore.getState().openTask(task.id, { reader: true });
  useSitting.setState({ card: { taskId: task.id }, departures: {}, sent: null, emptied: null });
  const words = textDocument(about === 'raw ID' ? 'T1 このルールの出典を説明して' : 'このルールの出典を説明して');
  const doc = about === 'context' ? labelled(words, task) : words;
  useDraftStore.setState({ entries: { [key]: { status: 'editing', values: { ...values('', id), doc: JSON.stringify(doc) } } } });
  const errors = vi.spyOn(notify, 'error');
  let posted: any;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/coordinator/messages') {
      posted = JSON.parse(String(init!.body));
      return new Response(messageJson(conv(cid, [{ ...sentTurn(id, posted.text, 'succeeded'), result: { writes: [], refused: [] } }]), id));
    }
    return reply({ status: 'unavailable', profile: 'claude', skills: [] });
  }));
  render(<TestWorkspace data={data}><CoordinatorInput launch={{ next: { agent: 'claude', values: {} }, ready: false }} /></TestWorkspace>);
  fireEvent.click(document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(useConversation.getState().conversation?.turns[0]?.status).toBe('succeeded'));
  expect(posted.intent).toBeUndefined(); expect(posted.answers).toBeUndefined();
  const submissions = [...useReaderSend.getState().receipts.values()];
  expect(submissions.every(receipt => receipt.binding.expectedWrites === null)).toBe(true);
  expect(submissions).toHaveLength(about === 'context' ? 1 : 0);
  if (about === 'context') {
    expect(useSitting.getState().departures[task.id]?.answer).toBe('send');
    await waitFor(() => expect(submissions[0]?.admitted).toBe(true));
    expect(useSitting.getState().departures[task.id]?.status()).not.toBe('refused');
  } else {
    expect(useSitting.getState().sent).toBeNull(); expect(useSitting.getState().departures).toEqual({});
  }
  expect(errors).not.toHaveBeenCalled();
});

const binding = { taskId: 'T1', title: 'Question', turn: 'Q1', kind: 'answer' as const, phase: 'doing', answer: 'send' as const, expectedWrites: [{kind:'answered' as const,question:'Q1'}] };
test('locally fixed submissions queue in order and only acceptance releases the next delivery', () => {
 const first = setup(), second = crypto.randomUUID();
 freeze(root,fixed('first'),values('first',first),{from:key},[binding]);
 freeze(root,fixed('second'),values('second',second),undefined,[{...binding,taskId:'T2'}]);
 expect(outgoing(useDraftStore.getState().entries,root,cid).map(each=>each.requestId)).toEqual([first,second]);
 expect(begin(root,second)).toBeNull();
 const attempt=begin(root,first)!;expect(attempt.check()).toBe('posted');attempt.finish();
 // Unknown is kept, and followers cannot overtake its same-ID reconciliation.
 expect(nextDelivery(useDraftStore.getState().entries,root,cid)).toBeNull();
 reconcileOutbox(conv(cid,[sentTurn(first,'first')]),root, null);
 expect(useDraftStore.getState().entries[outgoingKey(root,first)]?.values.stage).toBe('accepted');
 expect(nextDelivery(useDraftStore.getState().entries,root,cid)?.requestId).toBe(second);
 expect(begin(root,second)).toBeTruthy();
});
test('raw input survives until its result and returns to its task card without rewriting an old question', () => {
 const id=setup(),raw=values('choice and extra words',id);
 freeze(root,fixed('sent'),raw,{from:key},[binding]);
 reconcileOutbox(conv(cid,[sentTurn(id)]),root, null);
 expect(useDraftStore.getState().entries[outgoingKey(root,id)]?.values.doc).toBe(raw.doc);
 returnReaderSubmission(root,id,'refused');
 expect(restoreReaderDraft(root,cid,'T2')).toBe(false);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 const restored=useDraftStore.getState().entries[key]!.values;
 expect(restored.doc).toBe(raw.doc);expect(restored.requestId).not.toBe(id);
 expect(useDraftStore.getState().entries[outgoingKey(root,id)]).toBeUndefined();
});
test('returning one reader answer never overwrites another draft and successful results release the only raw copy', () => {
 const id=setup();freeze(root,fixed(),values('original',id),{from:key},[binding]);updateDraft(key,{values:values('new writing')});
 returnReaderSubmission(root,id,'refused');
 expect(restoreReaderDraft(root,cid,'T1')).toBe('blocked');
 expect(useDraftStore.getState().entries[key]!.values.doc).toContain('new writing');
 expect(useDraftStore.getState().entries[outgoingKey(root,id)]!.values.doc).toContain('original');
 const second=crypto.randomUUID();freeze(root,fixed('success'),values('success',second),undefined,[binding]);
 const turn={...sentTurn(second,'success'),result:{writes:[{task:'T1',record:'L1',kind:'answered',question:'Q1',toState:null}],refused:[]}};
 reconcileOutbox(conv(cid,[turn]),root, null);
 expect(useDraftStore.getState().entries[outgoingKey(root,second)]?.values).toEqual({doc:JSON.stringify(emptyDocument()),requestId:second,reader:JSON.stringify([binding]),stage:'settled'});
 expect(readDrafts().unavailable).toBe(false);
 expect(holdsReaderTurn(readDrafts().entries,root,binding)).toBe(false);
 expect(holdsReaderTurn(useDraftStore.getState().entries,root,binding)).toBe(false);
 observeReaderTurns(root,[{...waitingReview().tasks[0]!,id:'T1',ball:null}]);
 expect(useDraftStore.getState().entries[outgoingKey(root,second)]).toBeUndefined();
 expect(useDraftStore.getState().entries[outgoingKey(root,id)]!.values.doc).toContain('original');
});

test('opening a recovered card moves another card draft aside atomically and brings it back on return', () => {
 const id=setup(),data=waitingReview(),first=data.tasks[0]!,other={...first,id:'T2',title:'Other'};
 freeze(root,fixed('first'),values('original',id),{from:key},[binding]);updateDraft(key,{values:{...values(),doc:JSON.stringify(labelled(textDocument('other unsent words'),other))}});
 returnReaderSubmission(root,id,'refused');
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 expect(useDraftStore.getState().entries[key]!.values.doc).toContain('original');
 expect(restoreReaderDraft(root,cid,'T2')).toBe(true);
 expect(useDraftStore.getState().entries[key]!.values.doc).toContain('other unsent words');
 expect(Object.values(useDraftStore.getState().entries).filter(entry=>entry.values.doc?.includes('other unsent words'))).toHaveLength(1);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 expect(useDraftStore.getState().entries[key]!.values.doc).toContain('original');
});

test('failed local persistence creates no submission and keeps the original input intact', () => {
 const id=setup(),before=useDraftStore.getState().entries;
 const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError');});
 expect(freeze(root,fixed(),values('answer',id),{from:key},[binding])).toBeNull();
 expect(useDraftStore.getState().entries).toBe(before);
 expect(useDraftStore.getState().entries[outgoingKey(root,id)]).toBeUndefined();
 expect(useDraftStore.getState().unavailable).toBe(true);
 write.mockRestore();
});

test('unadmitted reader submissions cannot be frozen under another ID for the same turn, including after reload', () => {
 const id=setup();freeze(root,fixed(),values('first',id),{from:key},[binding]);
 expect(holdsReaderTurn(useDraftStore.getState().entries,root,binding)).toBe(true);
 expect(freeze(root,fixed(),values('duplicate'),undefined,[binding])).toBeNull();
 const attempt=begin(root,id)!;attempt.check();attempt.finish();useOutbox.setState({live:new Set()});
 expect(freeze(root,fixed(),values('duplicate after reload'),undefined,[binding])).toBeNull();
 expect(freeze(root,fixed(),values('another card'),undefined,[{...binding,taskId:'T2'}])).toBeTruthy();
});

for (const replacement of ['all','operation','context-operation','append'] as const) test(`editing ${replacement} preserves only an unchanged restored operation`, async () => {
 const id=setup(),data=waitingReview(),task=data.tasks[0]!;
 useViewStore.getState().openTask(task.id,{reader:true});useSitting.setState({card:{taskId:task.id},departures:{},sent:null,emptied:null});
 const doc=labelled(textDocument('説明してください'),task);
 useDraftStore.setState({entries:{[key]:{status:'editing',values:{...values('',id),doc:JSON.stringify(markReaderOperation(textDocument(`${task.id} Approve`))),readerIntent:JSON.stringify({task:task.id,action:'continue',aboutRun:'R1',expectedTaskHash:task.hash}),readerIntentTurn:JSON.stringify(readerTurn(task))}}}});
 let posted:any;const errors=vi.spyOn(notify,'error');
 vi.stubGlobal('fetch',vi.fn().mockImplementation(async(url:string,init?:RequestInit)=>{
  if(url==='/api/coordinator/messages'){posted=JSON.parse(String(init!.body));return new Response(messageJson(conv(cid,[{...sentTurn(id,posted.text,'succeeded'),context:task.id,result:{writes:posted.intent ? [{task:task.id,record:'L9',kind:'request_accepted',toState:null}] : [],refused:[]}}]),id));}
  return reply({status:'unavailable',profile:'claude',skills:[]});
 }));
 render(<TestWorkspace data={data}><CoordinatorInput launch={{ next: { agent: 'claude', values: {} }, ready: false }}/></TestWorkspace>);
 if(replacement==='context-operation') await act(async()=>{
  const entry=useDraftStore.getState().entries[key]!;
  updateDraft(key,{values:{...entry.values,doc:JSON.stringify(labelled(markReaderOperation(textDocument(`${task.id} Approve`)),task))}});
 });
 await act(async()=>{
  const editor=(document.querySelector('[data-one-input]') as HTMLElement & {editor:import('@tiptap/react').Editor}).editor;
  if(replacement==='all') editor.commands.setContent(doc);
  else if(replacement==='append') editor.commands.insertContentAt(editor.state.doc.content.size-1,' 追記');
  else {
   let from=0,to=0;editor.state.doc.descendants((node,pos)=>{if(node.isText&&node.text?.includes('Approve')){from=pos+node.text.indexOf('Approve');to=pos+node.nodeSize;}});
   editor.commands.insertContentAt({from,to},'説明してください');
  }
 });
 expect(!!useDraftStore.getState().entries[key]!.values.readerIntent).toBe(replacement==='append');
 fireEvent.click(document.querySelector('[data-ask-send]')!);
 await waitFor(()=>expect(posted).toBeTruthy());
 if(replacement==='append') expect(posted.intent).toMatchObject({task:task.id,action:'continue'});
 else {expect(posted.intent).toBeUndefined();expect(posted.answers).toBeUndefined();expect([...useReaderSend.getState().receipts.values()].some(receipt=>receipt.binding.expectedWrites!==null)).toBe(false);}
 expect(errors).not.toHaveBeenCalled();
});

test('admitted pending operations hold the same task turn after reader state is lost', () => {
 const operation={...binding,kind:'intent' as const};
 const id=setup();freeze(root,fixed(),values('first',id),{from:key},[operation]);
 reconcileOutbox(conv(cid,[sentTurn(id)]),root, null);
 useSitting.setState({departures:{},sent:null,emptied:null,card:null});
 expect(holdsReaderTurn(useDraftStore.getState().entries,root,operation)).toBe(true);
 expect(freeze(root,fixed(),values('duplicate accepted'),undefined,[operation])).toBeNull();
 returnReaderSubmission(root,id,'refused');
 expect(holdsReaderTurn(useDraftStore.getState().entries,root,operation)).toBe(false);
 expect(freeze(root,fixed(),values('retry refused'),undefined,[operation])).toBeTruthy();
});

for(const kind of ['answer','intent'] as const) test(`${kind} submission keeps its actual question or state-transition identity`,()=>{
 const id=setup(),original={...waitingReview().tasks[0]!,id:'T1',state:'doing' as const,ball:userBall('question','Q1',at,{questionId:'Q1'})};
 const submitted={...binding,...readerTurn(original),kind};
 freeze(root,fixed(),values('original',id),{from:key},[submitted]);
 const held={...original,state:'held' as const,stateLog:[...original.stateLog,logEntry({id:'L99',kind:'reported',fromState:'doing',toState:'held'})]};
 expect(holdsReaderTurn(useDraftStore.getState().entries,root,readerTurn(Object.assign({},original,{hash:'body changed'})))).toBe(true);
 expect(holdsReaderTurn(useDraftStore.getState().entries,root,readerTurn(held))).toBe(kind==='answer');
});


test('a missing recovery source never parks the current recovered input',()=>{
 const id=setup('only the first card');freeze(root,fixed(),values('only the first card',id),{from:key},[binding]);
 returnReaderSubmission(root,id);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 const before=useDraftStore.getState().entries;
 expect(restoreReaderDraft(root,cid,'T9')).toBe(false);
 expect(useDraftStore.getState().entries).toBe(before);
 expect(parkedReaderDraft(before,root,cid,'T1')).toBeNull();
 expect(before[key]!.values.doc).toContain('only the first card');
});
test('a parked past-turn original stays discoverable for explicit recovery without automatic revival',()=>{
 const id=setup('original A');freeze(root,fixed(),values('original A',id),{from:key},[binding]);returnReaderSubmission(root,id);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 const second=crypto.randomUUID(),other={...binding,taskId:'T2',turn:'Q2'};
 freeze(root,fixed('B'),values('original B',second),undefined,[other]);returnReaderSubmission(root,second);
 expect(restoreReaderDraft(root,cid,'T2')).toBe(true);
 const entries=useDraftStore.getState().entries,saved=parkedReaderDraft(entries,root,cid,'T1');
 expect(saved?.values.doc).toContain('original A');
 expect(saved?.values.readerDraftTurn).toBe(JSON.stringify(binding));
 expect(restoreReaderDraft(root,cid,'T1',{taskId:'T1',turn:'Q-finished',phase:'doing'})).toBe(false);
 expect(useDraftStore.getState().entries).toBe(entries);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 expect(parkedReaderDraft(useDraftStore.getState().entries,root,cid,'T1')).toBeNull();
 expect(useDraftStore.getState().entries[key]!.values.doc).toContain('original A');
 expect(Object.values(useDraftStore.getState().entries).filter(entry=>entry.values.doc?.includes('original A'))).toHaveLength(1);
 expect(parkedReaderDraft(useDraftStore.getState().entries,root,cid,'T2')?.values.doc).toContain('original B');
});
test('browsing a refused answer cannot take the input from a pending answer; explicit recovery still moves each original once',()=>{
 const original=setup('original A');
 freeze(root,fixed('original A'),values('original A',original),{from:key},[binding]);
 act(()=>{mutateInput(key,input=>observed(input,{panel:{id:'T2',title:'Other'},project:null}));});
 act(()=>{mutateInput(key,input=>{
  const doc=JSON.parse(input.doc!);doc.content[0].content.push({type:'text',text:'later free words'});
  return {...input,doc:JSON.stringify(doc),phase:'composing'};
 });});
 const appended=availableInput(useDraftStore.getState().entries,root,key)!;
 expect(appended.doc).toContain('later free words');expect(appended.doc).not.toContain('original A');
 const fixedA=useDraftStore.getState().entries[outgoingKey(root,original)]!.values.submitted;
 returnReaderSubmission(root,original,'refused');
 expect(useDraftStore.getState().entries[outgoingKey(root,original)]!.values.submitted).toBe(fixedA);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 const together=availableInput(useDraftStore.getState().entries,root,key)!;
 expect(JSON.parse(together.doc!).content.flatMap((block:any)=>block.content??[]).filter((node:any)=>node.type==='text').map((node:any)=>node.text).join('')).toBe('original A');
 // A later Task's words keep their own recipient, parked instead of joining the recovered original.
 expect(together.doc).not.toContain('T2');expect(together.readerDraftTask).toBe('T1');
 expect(parkedReaderDraft(useDraftStore.getState().entries,root,cid,'T2')?.values.doc).toContain('later free words');
 expect(readDrafts().entries[key]!.values.doc).toBe(useDraftStore.getState().entries[key]!.values.doc);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(false);
 const a=setup('original A'),rawA=values('original A',a);
 freeze(root,fixed('original A'),rawA,{from:key},[binding]);returnReaderSubmission(root,a,'refused');
 act(()=>{mutateInput(key,input=>({...input,doc:JSON.stringify(emptyDocument()),phase:'composing'}));});
 act(()=>{mutateInput(key,input=>({...input,doc:JSON.stringify(labelled(textDocument('original B'),{id:'T2',title:'Other'})),phase:'composing'}));});
 const rawB=availableInput(useDraftStore.getState().entries,root,key)!,b=rawB.requestId!,other={...binding,taskId:'T2',turn:'Q2'};
 const payload={...fixed('original B'),tasks:['T2']};
 expect(freeze(root,payload,rawB,{from:key},[other])).toBe(b);
 act(()=>{mutateInput(key,input=>observed(input,{panel:{id:'T1',title:'Question'},project:null}));});
 const before=useDraftStore.getState().entries;
 expect(restoreReaderDraft(root,cid,'T1',{taskId:'T1',turn:'Q1',phase:'doing'})).toBe(false);
 expect(useDraftStore.getState().entries).toBe(before);
 expect(JSON.parse(before[outgoingKey(root,b)]!.values.submitted!)).toEqual(payload);
 const attempt=begin(root,b)!;expect(attempt.fixed).toEqual(payload);expect(attempt.requestId).toBe(b);attempt.check();attempt.finish();
 returnReaderSubmission(root,b,'refused');
 expect(restoreReaderDraft(root,cid,'T2')).toBe(true);
 expect(availableInput(useDraftStore.getState().entries,root,key)!.readerDraftTask).toBe('T2');
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(false);
 expect(availableInput(useDraftStore.getState().entries,root,key)!.doc).toContain('original A');
 expect(availableInput(useDraftStore.getState().entries,root,key)!.doc).not.toContain('original B');
 expect(restoreReaderDraft(root,cid,'T2')).toBe(true);
 expect(availableInput(useDraftStore.getState().entries,root,key)!.doc).toContain('original B');
 expect(availableInput(useDraftStore.getState().entries,root,key)!.doc).not.toContain('original A');
 expect(parkedReaderDraft(useDraftStore.getState().entries,root,cid,'T1')?.values.doc).toContain('original A');
 expect(parkedReaderDraft(useDraftStore.getState().entries,root,cid,'T1')?.values.doc).not.toContain('original B');
 for(const text of ['original A','original B'])
  expect(Object.values(useDraftStore.getState().entries).filter(entry=>!entry.values.submitted&&entry.values.doc?.includes(text))).toHaveLength(1);
});
test('a two-target payload keeps the successful target locked while only the failed draft is restored',()=>{
 const id=setup(),other={...binding,taskId:'T2',turn:'Q2'},q=decideOf([decideItem('Color', [['A Blue', 'blue']])])[0]!;
 const first={id:'T1',title:'First'},second={id:'T2',title:'Second'};
 let doc=toggleAnswer(emptyDocument(),first,choiceAnswer(answerTask('T1'),'Q1',q,q.choices[0]!));
 doc=toggleAnswer(doc,second,choiceAnswer(answerTask('T2'),'Q2',q,q.choices[0]!));
 updateDraft(key,{values:{...values('',id),doc:JSON.stringify(doc)}});
 freeze(root,{...fixed(),answers:[{task:'T1',question:'Q1'},{task:'T2',question:'Q2'}]}, {...values('multi',id),doc:JSON.stringify(doc)},{from:key},[binding,other]);
 expect(holdsReaderTurn(useDraftStore.getState().entries,root,binding)).toBe(true);
 expect(holdsReaderTurn(useDraftStore.getState().entries,root,other)).toBe(true);
 returnReaderSubmission(root,id,'refused',binding);
 expect(holdsReaderTurn(useDraftStore.getState().entries,root,binding)).toBe(false);
 expect(holdsReaderTurn(useDraftStore.getState().entries,root,other)).toBe(true);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 const restored=JSON.parse(useDraftStore.getState().entries[key]!.values.doc!);
 expect(restored.content.flatMap((block:any)=>block.content??[]).filter((node:any)=>node.type==='answerLabel').map((node:any)=>node.attrs.task)).toEqual(['T1']);
 expect(awaitsReaderResult(useDraftStore.getState().entries,root,other)).toBe(true);
});

test('two questions on one task retain separate submission and recovery identities',()=>{
 const id=setup(),other={...binding,turn:'Q2',expectedWrites:[{kind:'answered' as const,question:'Q2'}]},q=decideOf([decideItem('Color', [['A Blue', 'blue']])])[0]!,task={id:'T1',title:'First'};
 let doc=toggleAnswer(emptyDocument(),task,choiceAnswer(answerTask('T1'),'Q1',q,q.choices[0]!));
 doc=toggleAnswer(doc,task,choiceAnswer(answerTask('T1'),'Q2',q,q.choices[0]!));
 updateDraft(key,{values:{...values('',id),doc:JSON.stringify(doc)}});
 freeze(root,{...fixed(),answers:[{task:'T1',question:'Q1'},{task:'T1',question:'Q2'}]},{...values('',id),doc:JSON.stringify(doc)},{from:key},[binding,other]);
 returnReaderSubmission(root,id,'refused',binding);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 const restored=JSON.parse(useDraftStore.getState().entries[key]!.values.doc!);
 expect(restored.content.flatMap((block:any)=>block.content??[]).filter((node:any)=>node.type==='answerLabel').map((node:any)=>node.attrs.question)).toEqual(['Q1']);
 expect(awaitsReaderResult(useDraftStore.getState().entries,root,other)).toBe(true);
});

test('a card takes back its words in a later conversation without the cleared one\'s files',()=>{
 const id=setup(),file=JSON.stringify([{name:'a.txt',path:`attachments/${id}/a.txt`,absolutePath:'/old',size:1}]);
 freeze(root,{...fixed(),attachments:['a.txt']},{...values('card words',id),attachments:file},{from:key},[binding]);
 returnReaderSubmission(root,id);
 expect(restoreReaderDraft(root,'later','T1')).toBe(true);
 const back=useDraftStore.getState().entries[draftKey(root,'coordinator','later')]!.values;
 expect(back.doc).toContain('card words');
 expect(back.attachments).toBeUndefined();
});

test('an upload follows its recovered draft while another card has an empty input',async()=>{
 const id=setup('file belongs to first');freeze(root,fixed(),values('file belongs to first',id),{from:key},[binding]);
 returnReaderSubmission(root,id);restoreReaderDraft(root,cid,'T1');
 let uploaded!:(value:any)=>void;
 const pending=new Promise<any>(resolve=>uploaded=resolve);
 const upload=vi.spyOn(attachmentAPI,'uploadAttachment').mockReturnValue(pending);
 let files!:ReturnType<typeof useAttachments>;
 function FileInput(){files=useAttachments(key,{kind:'coordinator',conversationId:cid},false,inputDraftFiles(root,useDraftStore.getState().entries[key]!.values.requestId!));return null;}
 render(createElement(TestWorkspace,null,createElement(FileInput)));
 act(()=>files.add([new File(['hello'],'owned.txt',{type:'text/plain'})]));
 await waitFor(()=>expect(upload).toHaveBeenCalledOnce());
 expect(files.pending).toHaveLength(1);
 act(()=>{
  const second=crypto.randomUUID();
  freeze(root,fixed('other failure'),values('other failure',second),undefined,[{...binding,taskId:'T2',turn:'Q2'}]);
  returnReaderSubmission(root,second);
  expect(restoreReaderDraft(root,cid,'T2')).toBe(true);
 });
 expect(files.pending).toHaveLength(0);
 const parked=Object.entries(useDraftStore.getState().entries).find(([name,entry])=>name!==key && entry.values.readerDraftTask==='T1')!;
 const requestId=parked[1].values.requestId!;
 await act(async()=>uploaded({path:`attachments/${requestId}/owned.txt`,absolutePath:'/owned.txt',name:'owned.txt',size:5}));
 expect(attachmentsOf(useDraftStore.getState().entries[key]!.values)).toHaveLength(0);
 expect(attachmentsOf(useDraftStore.getState().entries[parked[0]]!.values).map(file=>file.name)).toEqual(['owned.txt']);
 act(()=>{expect(restoreReaderDraft(root,cid,'T1')).toBe(true);});
 expect(files.attached.map(file=>file.name)).toEqual(['owned.txt']);expect(files.pending).toHaveLength(0);
 upload.mockRestore();
});

test('another failure for the same card cannot overwrite its editable returned draft',()=>{
 const id=setup('first editable words');freeze(root,fixed(),values('first editable words',id),{from:key},[binding]);returnReaderSubmission(root,id);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 const later=crypto.randomUUID();freeze(root,fixed(),values('later failed words',later),undefined,[binding]);returnReaderSubmission(root,later);
 expect(restoreReaderDraft(root,cid,'T1')).toBe(false);
 expect(useDraftStore.getState().entries[key]!.values.doc).toContain('first editable words');
 expect(useDraftStore.getState().entries[outgoingKey(root,later)]!.values.doc).toContain('later failed words');
});

test('two failed question targets on one card restore together with their original question IDs',()=>{
 const id=setup(),other={...binding,turn:'Q2',expectedWrites:[{kind:'answered' as const,question:'Q2'}]},q=decideOf([decideItem('Color', [['A Blue', 'blue']])])[0]!,task={id:'T1',title:'First'};
 let doc=toggleAnswer(emptyDocument(),task,choiceAnswer(answerTask('T1'),'Q1',q,q.choices[0]!));
 doc=toggleAnswer(doc,task,choiceAnswer(answerTask('T1'),'Q2',q,q.choices[0]!));
 updateDraft(key,{values:{...values('',id),doc:JSON.stringify(doc)}});
 freeze(root,{...fixed(),answers:[{task:'T1',question:'Q1'},{task:'T1',question:'Q2'}]},{...values('',id),doc:JSON.stringify(doc)},{from:key},[binding,other]);
 returnReaderSubmission(root,id,'refused');expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 const restored=JSON.parse(useDraftStore.getState().entries[key]!.values.doc!);
 expect(restored.content.flatMap((block:any)=>block.content??[]).filter((node:any)=>node.type==='answerLabel').map((node:any)=>node.attrs.question).sort()).toEqual(['Q1','Q2']);
});

test('unsupported local fixed input is retained verbatim without a migration reader', () => {
 const task = screenData().tasks[0]!;
 const id = 'retired-state-operation', key = outgoingKey(root,id);
 const original = { conversationId:cid, text:'Original state report words', attachments:[],
   intent:{task:task.id, action:'approve', expectedTaskHash:task.hash} };
 const entry = {status:'editing' as const, values:{...values(original.text,id),submitted:JSON.stringify(original),stage:'posted',reader:JSON.stringify([binding])}};
 useDraftStore.setState({ entries:{ [key]:entry } });
 expect(begin(root,id)).toBeNull();
 expect(useDraftStore.getState().entries[key]).toEqual(entry);
});

for (const explicit of [false, true]) test(`${explicit ? 'explicit operations remain protected' : 'an admitted answer reference lets the next message go, and its card once completed'}`, () => {
 const id=setup(), submitted={...binding,kind:explicit?'intent' as const:'answer' as const};
 const held=()=>({next:holdsReaderTurn(useDraftStore.getState().entries,root,submitted),card:awaitsReaderResult(useDraftStore.getState().entries,root,submitted)});
 freeze(root,fixed(),values('sent',id),{from:key},[submitted]);
 expect(held()).toEqual({next:true,card:true});
 // Serve has it: the coordinator takes the next message after this one, while the card waits for the answer.
 reconcileOutbox(conv(cid,[sentTurn(id)]),root, null,true);
 expect(held()).toEqual({next:explicit,card:true});
 const turn={...sentTurn(id,'sent','succeeded'),result:{writes:explicit?[{task:'T1',record:'L1',kind:'answered',question:'Q1',toState:null}]:[],refused:[]}};
 reconcileOutbox(conv(cid,[turn]),root, null,false);
 expect(held()).toEqual({next:explicit,card:true});
 reconcileOutbox(conv(cid,[turn]),root, null,true);
 expect(held()).toEqual({next:explicit,card:explicit});
 expect(submittedReaderTurn(readDrafts().entries,{},root,submitted)).toBe(true);
 expect(submittedReaderTurn(readDrafts().entries,{},'/other-workspace',submitted)).toBe(false);
 expect(submittedReaderTurn(readDrafts().entries,{},root,{...submitted,turn:'new-question'})).toBe(false);
 expect(freeze(root,fixed('follow-up'),values('follow-up'),undefined,[submitted])!==null).toBe(!explicit);
});

test('a successful clarification does not block recovering a later refused follow-up on the same question', () => {
 const first=setup(),ordinary={...binding,expectedWrites:null};
 freeze(root,fixed(),values('sent',first),{from:key},[ordinary]);
 reconcileOutbox(conv(cid,[{...sentTurn(first,'sent','succeeded'),result:{writes:[],refused:[]}}]),root, null,true);
 const second=crypto.randomUUID();
 expect(freeze(root,fixed('follow-up'),values('follow-up',second),{from:key},[ordinary])).toBe(second);
 returnReaderSubmission(root,second,'refused');
 expect(restoreReaderDraft(root,cid,'T1')).toBe(true);
 const recovered=useDraftStore.getState().entries[key]!.values;
 expect(recovered.doc).toContain('follow-up');
 expect(holdsReaderTurn(readDrafts().entries,root,ordinary)).toBe(false);
 expect(submittedReaderTurn(readDrafts().entries,{},root,ordinary)).toBe(true);
 expect(freeze(root,fixed('follow-up'),recovered,{from:key},[ordinary])).toBeTruthy();
 observeReaderTurns(root,[{...waitingReview().tasks[0]!,id:'T1',ball:userBall('question','Q-new',at,{questionId:'Q-new'})}]);
 expect(useDraftStore.getState().entries[outgoingKey(root,first)]).toBeUndefined();
});

for (const recovery of ['refused','cancelled'] as const) test(`a ${recovery} free-text send releases both the sending gate and the deck`, () => {
 const id=setup(),ordinary={...binding,expectedWrites:null};
 freeze(root,fixed(),values('sent',id),{from:key},[ordinary]);
 expect(submittedReaderTurn(readDrafts().entries,{},root,ordinary)).toBe(true);
 if(recovery==='refused') returnReaderSubmission(root,id,'refused');
 else reconcileOutbox({...conv(),cancelled:[id]},root, null,true);
 expect(holdsReaderTurn(readDrafts().entries,root,ordinary)).toBe(false);
 expect(submittedReaderTurn(readDrafts().entries,{},root,ordinary)).toBe(false);
});

test('a mixed message releases completed conversation targets while protecting its explicit operation', () => {
 const id=setup(), ordinary={...binding,taskId:'T2',expectedWrites:null};
 const operation={...binding,kind:'intent' as const,expectedWrites:[{kind:'request_accepted' as const}]};
 freeze(root,fixed(),values('sent',id),{from:key},[operation,ordinary]);
 reconcileOutbox(conv(cid,[{...sentTurn(id,'sent','succeeded'),result:{writes:[{task:'T1',record:'L1',kind:'request_accepted',toState:null}],refused:[]}}]),root, null,true);
 expect(holdsReaderTurn(readDrafts().entries,root,operation)).toBe(true);
 expect(holdsReaderTurn(readDrafts().entries,root,ordinary)).toBe(false);
});

test('the same words and question with another question identity do not prove HTTP admission', () => {
  const id = setup();
  const answers = [{ task: 'T1', question: 'Q1' }];
  freeze(root, { ...fixed('original'), answers }, useDraftStore.getState().entries[key]!.values, { from: key });
  const attempt = begin(root, id)!; attempt.check(); attempt.finish();
  reconcileOutbox(conv(cid, [{ ...sentTurn(id, 'original'), answers: [{ ...answers[0], question: 'Q2' }] }]), root, null, true, 'conflict');
  const kept = useDraftStore.getState().entries[outgoingKey(root, id)]!;
  expect(kept.values.conflict).toBe('1');
  expect(JSON.parse(kept.values.submitted!).answers).toEqual(answers);
});

test('answer input refuses version guards before posting', async () => {
  const id=setup(),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(useConversation.getState().ask({conversationId:cid,id,text:'1-A',attachments:[],
    answers:[{task:'T1',question:'Q1',expectedTaskHash:'a'.repeat(64)}]} as never)).rejects.toMatchObject({code:'conflict',retry:'reread'});
  expect(fetcher).not.toHaveBeenCalled();
});


test('matching words and ID with different skill labels do not prove admission', () => {
  const id = setup();
  const payload = { ...fixed(), skills: ['alpacawork'] };
  freeze(root, payload, useDraftStore.getState().entries[key]!.values, { from: key });
  reconcileOutbox(conv(cid, [{ ...sentTurn(id), skills: ['another-skill'] }]), root, key, true, 'different skills');
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]!.values.conflict).toBe('1');
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('sent');
});

test('an unchanged refused answer remains recoverable after the editor normalizes attribute order', () => {
  const id = setup();
  const attrs = { question: 'Q1', task: 'T1', n: '1', name: 'Option1', answer: '1-Option1' };
  const doc = toggleAnswer(emptyDocument(), { id: 'T1', title: 'Question' }, attrs);
  updateDraft(key, { values: { ...values('', id), doc: JSON.stringify(doc) } });
  freeze(root, { ...fixed('T1 1-Option1'), tasks: ['T1'], answers: [{ task: 'T1', question: 'Q1' }] },
    useDraftStore.getState().entries[key]!.values, { from: key },
    [{ taskId: 'T1', title: 'Question', turn: 'Q1', phase: 'doing', kind: 'answer', answer: 'send', expectedWrites: null }]);
  const original = useDraftStore.getState().entries[key]!;
  const normalized = JSON.parse(original.values.doc!);
  const answer = normalized.content[0].content.find((node: any) => node.type === 'answerLabel');
  answer.attrs = { task: attrs.task, question: attrs.question, n: attrs.n, name: attrs.name, answer: attrs.answer };
  updateDraft(key, { values: { ...original.values, doc: JSON.stringify(normalized) } });
  refuse(root, id, 'Changed conversation', false, key);
  expect(canTakeBack(useDraftStore.getState().entries, root, id, key)).toBe(true);
  expect(takeBack(root, id, key)).toBe(true);
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]).toBeUndefined();
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('1-Option1');
});

test('opening another refused answer parks a recovered original even when its terminal identity remains taken', () => {
  const id = setup();
  const answer = (task: string) => toggleAnswer(emptyDocument(), { id: task, title: task },
    { task, question: `Q${task}`, n: '1', name: 'Option1', answer: '1-Option1' });
  const binding = (task: string) => ({ taskId: task, title: task, turn: `Q${task}`, phase: 'doing', kind: 'answer' as const, answer: 'send' as const, expectedWrites: null });
  updateDraft(key, { values: { ...values('', id), doc: JSON.stringify(answer('T1')) } });
  freeze(root, fixed('Original A'), useDraftStore.getState().entries[key]!.values, { from: key }, [binding('T1')]);
  const sent = outgoingKey(root, id), record = useDraftStore.getState().entries[sent]!;
  updateDraft(sent, { values: { ...record.values, cancelled: '1' } });
  refuse(root, id, 'Cancelled', false, key);
  expect(takeBack(root, id, key)).toBe(true);
  expect(useDraftStore.getState().entries[sent]!.values.taken).toBe('1');
  const other = crypto.randomUUID();
  freeze(root, fixed('Original B'), { ...values('', other), doc: JSON.stringify(answer('T2')) }, undefined, [binding('T2')]);
  refuse(root, other, 'Refused', false, key);
  expect(restoreReaderDraft(root, cid, 'T2')).toBe(true);
  expect(parkedReaderDraft(useDraftStore.getState().entries, root, cid, 'T1')).not.toBeNull();
  expect(restoreReaderDraft(root, cid, 'T1')).toBe(true);
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('T1');
  expect(parkedReaderDraft(useDraftStore.getState().entries, root, cid, 'T1')).toBeNull();
});

test('immediate undo restores files after the prepared input follows another Task', () => {
  const id = setup();
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'taskLabel', attrs: { id: 'T1', title: 'Original' } }, { type: 'text', text: 'sent' }
  ] }] };
  const files = [{ name: 'a.txt', path: `attachments/${id}/a.txt`, absolutePath: '/a.txt', size: 1 }];
  updateDraft(key, { values: { ...values('', id), doc: JSON.stringify(doc), attachments: JSON.stringify(files), phase: 'composing', seen: 'T1' } });
  freeze(root, { ...fixed(), tasks: ['T1'], attachments: ['a.txt'] }, useDraftStore.getState().entries[key]!.values, { from: key });
  mutateInput(key, values => observed(values, { panel: { id: 'T2', title: 'Next' }, project: null }));
  expect(attachmentsOf(availableInput(useDraftStore.getState().entries, root, key)!)).toEqual([]);
  const next = availableInput(useDraftStore.getState().entries, root, key)!.requestId!;
  const laterFiles = [{ name: 'b.txt', path: `attachments/${next}/b.txt`, absolutePath: '/b.txt', size: 2 }];
  mutateInput(key, values => ({ ...values, phase: 'composing', attachments: JSON.stringify(laterFiles),
    doc: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'taskLabel', attrs: { id: 'T2', title: 'Next' } }, { type: 'text', text: 'later' }
    ] }] }) }));
  freeze(root, { ...fixed('later'), tasks: ['T2'], attachments: ['b.txt'] }, availableInput(useDraftStore.getState().entries, root, key)!, { from: key });
  expect(cancelUnsent(root, id)).toBe('cancelled');
  const visible = () => availableInput(useDraftStore.getState().entries, root, key)!;
  expect(attachmentsOf(visible())).toEqual(files);
  expect(visible().doc).toContain('Original');
  expect(visible().doc).not.toContain('later');
  expect(attachmentsOf(useDraftStore.getState().entries[outgoingKey(root, next)]!.values)).toEqual(laterFiles);
  reconcileOutbox(conv(cid, [{ ...sentTurn(next, 'later'), tasks: ['T2'], attachments: ['b.txt'] }]), root, key, true);
  expect(attachmentsOf(visible())).toEqual(files);
  expect(visible().doc).toContain('sent');
  expect(useDraftStore.getState().entries[key]!.values.doc).not.toContain('later');
  expect(attachmentsOf(useDraftStore.getState().entries[key]!.values)).toEqual(files);
});

test("a question's choices wait only until serve admits the message sent on its card, not for the coordinator's reply", async () => {
 const data=screenData(tree({tasks:[taskFixture({id:'T1',state:'doing',ball:userBall('question','Q1',at,{questionId:'Q1'})})],
  questions:[questionFixture({id:'Q1',decide:[decideItem('Storage location',[['OptionA','Local']])]})]}));
 const id=setup();
 freeze(root,fixed(),values('sent',id),{from:key},[{...binding,turn:readerTurn(data.tasks[0]!).turn}]);
 render(<TestWorkspace data={data}><WaitingReportActions task={data.tasks[0]!} question="Q1" onFollow={() => {}} /></TestWorkspace>);
 const choice=()=>screen.getByRole('button',{name:'OptionA'}) as HTMLButtonElement;
 expect(choice().disabled).toBe(true);
 // Admitted, and the coordinator still answering it: the next answer can be chosen.
 act(()=>{reconcileOutbox(conv(cid,[sentTurn(id)]),root,null);});
 await waitFor(()=>expect(choice().disabled).toBe(false));
});
