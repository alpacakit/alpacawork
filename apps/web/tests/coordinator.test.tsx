import { announceConversation } from './conversation-fixture';
import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { CoordinatorCard } from "../src/features/coordinator/CoordinatorCard";
import { useConversation } from "../src/features/coordinator/coordinator";
import { useViewStore } from "../src/state/view-store";
import { coordinatorErrorReason } from "../src/features/coordinator/parts";
import { notify } from "../src/lib/notify";
import { markCoordinatorSeen, type CoordinatorTurn } from "../src/data/coordinator";
import { rememberWriteIdentity } from "../src/data/write-identity";
import { useConnection } from "../src/data/connection";
import type { ControlTreeDTO } from "@alpacawork/contract/control";
import type { LaunchMemory } from "@alpacawork/contract/agent-selection";
import { useConversationChanges, useLaunchPicker } from "../src/features/forms/launch-choice";
import { screenData, TestWorkspace, tree, dto, openReference, launchProfile } from "./fixtures";
import { setAutoSwipe } from "../src/features/reader/next-question";
import * as messageTimes from '../src/features/coordinator/message-time';
import { appHintDone } from '../src/features/coordinator/app-hint';
import { useDialogStore } from '../src/state/dialog-store';

const empty = { id: "conversation-1", agent: null, warm: 'none' as 'none' | 'preparing' | 'ready' | 'failed', busy: false, cancelled: [], turns: [] };
const turn = { id: "turn-1", at: new Date().toISOString(), ask: "T13 ?", tasks: ["T13"],
  attachments: [], status: "running", waiting: false, answer: null, seen: false, answeredAt: null, error: null, result: null };
function stubFetch(fetcher: (...args: any[]) => any) {
  vi.stubGlobal("fetch", (url: string, ...args: any[]) => url.startsWith("/api/coordinator/skills")
    ? Promise.resolve(reply({ status: "unavailable", profile: "claude", skills: [], reason: "test profile" }))
    : fetcher(url, ...args));
}
function writeEditor(text: string) {
  const field = screen.getByRole("textbox", { name: "Message the coordinator" }) as HTMLElement & { editor: import('@tiptap/react').Editor };
  act(() => field.editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }));
}
const reply = (body: unknown) => new Response(snapshotJson(body), { status: 200 });
beforeAll(() => startI18n());
// Store-only calls need the same live read basis as calls made by a rendered workspace.
beforeEach(() => {
  // Its sends from the input are read leaving their cards: auto-swipe on.
  setAutoSwipe(true);
  screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }));
  // Store-only transport cases begin after a new admission has fixed the original epoch.
  for (const id of ["turn-1", "next"]) rememberWriteIdentity("/fixture", id, "initial");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useLaunchPicker.setState({ open: false }); useConversationChanges.setState({ conversation: null, agent: null, changes: {} }); setConversationState({ conversation: null, open: true, expanded: false, engaged: false, read: true, error: null }); });

test('selecting another Task leaves an unengaged conversation thread alone, while new turns and language still redraw it', async () => {
  await i18n.changeLanguage('en');
  const first: CoordinatorTurn = { ...turn, status: 'succeeded', answer: 'Stable answer', answeredAt: turn.at, seen: true };
  setConversationState({ conversation: { ...empty, turns: [first] }, open: false, expanded: false, engaged: false, read: true });
  useViewStore.setState({ selected: null, reader: { ...useViewStore.getState().reader, open: false } });
  const get = vi.fn().mockImplementation(() => { throw new Error('an unengaged card must not fetch'); });
  stubFetch(get);
  const formatted = vi.spyOn(messageTimes, 'messageTime');
  try {
    render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: 'T13' })] }))}><CoordinatorCard /></TestWorkspace>);
    // A folded card keeps the actual thread in its detached portal; it still must not format it on each selection.
    await waitFor(() => expect(formatted).toHaveBeenCalledWith(first.at, 'en'));
    formatted.mockClear();
    act(() => useViewStore.getState().openTask('T13', { reader: true }));
    expect(formatted).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    act(() => setConversationState({ conversation: { ...empty, turns: [first, { ...first, id: 'turn-2', ask: 'New message' }] } }));
    expect(formatted).toHaveBeenCalled();
    formatted.mockClear();
    await act(async () => { await i18n.changeLanguage('ja'); });
    expect(formatted).toHaveBeenCalled();
    expect(formatted.mock.calls.some(([, language]) => language === 'ja')).toBe(true);
  } finally {
    formatted.mockRestore();
    await i18n.changeLanguage('en');
  }
});

test("coordinator failure codes become Japanese and English reasons", async () => {
  const reason = (error: CoordinatorTurn["error"]) => coordinatorErrorReason({ error });
  await i18n.changeLanguage("ja");
  expect(reason("conversation_busy")).toBe("会話が使用中です");
  expect(reason("launch")).toBe("エージェントを起動できませんでした");
  expect(reason("attachment_save")).toBe("返答の添付を保存できませんでした");
  await i18n.changeLanguage("en");
  expect(reason("conversation_busy")).toBe("The conversation is in use");
  expect(reason("output")).toBe("Could not read the reply");
  expect(reason("attachment_save")).toBe("Could not save the reply attachments");
});

test("a known cause from the Run's own error replaces the recorded reason in both languages", async () => {
  const weekly = { error: "exit" as const, failure: { cause: "weekly_limit" as const, message: "You've hit your weekly limit · resets Nov 8, 8pm (Asia/Tokyo)" } };
  const capacity = { error: "exit" as const, failure: { cause: "model_capacity" as const, message: "Selected model is at capacity. Please try a different model." } };
  const general = { error: "exit" as const, failure: { message: "Service unavailable." } };
  await i18n.changeLanguage("ja");
  expect(coordinatorErrorReason(weekly)).toBe("週の利用上限に達しました");
  expect(coordinatorErrorReason(capacity)).toBe("モデルが混み合っています（容量不足）");
  expect(coordinatorErrorReason(general)).toBe("エージェントが途中で終了しました");
  await i18n.changeLanguage("en");
  expect(coordinatorErrorReason(weekly)).toBe("Weekly usage limit reached");
  expect(coordinatorErrorReason(capacity)).toBe("The model is at capacity");
  expect(coordinatorErrorReason(general)).toBe("The agent exited before finishing");
});

test("a failed turn says its cause and then the Run's error words in full, and only the words it has", async () => {
  await i18n.changeLanguage("en");
  const weekly = "You've hit your weekly limit · resets Nov 8, 8pm (Asia/Tokyo)";
  const long = `API Error: 500 ${"x".repeat(1500)}\nend`;
  const failed = (id: string, failure?: CoordinatorTurn["failure"]): CoordinatorTurn =>
    ({ ...turn, id, status: "failed", waiting: false, error: "exit", answeredAt: new Date().toISOString(), seen: true, ...failure ? { failure } : {} });
  stubFetch(vi.fn().mockResolvedValue(reply({ ...empty })));
  for (const [shown, reason, words] of [
    [failed("weekly", { cause: "weekly_limit", message: weekly }), "Weekly usage limit reached", weekly],
    [failed("general", { message: long }), "The agent exited before finishing", long],
    [failed("plain"), "The agent exited before finishing", null],
  ] as const) {
    setConversationState({ conversation: { ...empty, turns: [shown] }, open: true, expanded: true, read: true });
    const { unmount } = render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
    const alert = await screen.findByRole("alert");
    expect(alert.firstChild?.textContent).toBe(`Could not receive a reply: ${reason}`);
    expect(alert.querySelector("[data-coordinator-failure-message]")?.textContent ?? null).toBe(words);
    expect(screen.getByRole("button", { name: "Send again" })).toBeTruthy();
    unmount();
  }
});

test("a folded exchange and the folded conversation say the cause, not the Run's words", async () => {
  await i18n.changeLanguage("en");
  const weekly = "You've hit your weekly limit · resets Nov 8, 8pm (Asia/Tokyo)";
  const failed: CoordinatorTurn = { ...turn, id: "weekly", status: "failed", waiting: false, error: "exit", seen: true,
    answeredAt: new Date().toISOString(), failure: { cause: "weekly_limit", message: weekly } };
  stubFetch(vi.fn().mockResolvedValue(reply({ ...empty })));
  setConversationState({ conversation: { ...empty, turns: [failed] }, open: true, expanded: false, read: true });
  const pill = render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  const words = (await screen.findByRole("button", { name: /Could not receive a reply/ })).textContent;
  expect(words).toContain("Could not receive a reply: Weekly usage limit reached");
  expect(words).not.toContain("resets");
  pill.unmount();
  setConversationState({ conversation: { ...empty, turns: [failed] }, open: true, expanded: true, read: true });
  const { container } = render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  await screen.findByRole("alert");
  fireEvent.click(container.querySelector('[data-coordinator-message="weekly"] [data-exchange-toggle]')!);
  const row = container.querySelector('[data-coordinator-message="weekly"][data-exchange="folded"]');
  expect(row?.querySelector("[data-exchange-outcome]")?.textContent).toBe("Could not receive a reply: Weekly usage limit reached");
  expect(row?.querySelector("[data-coordinator-failure-message]")).toBeNull();
});

test("a busy turn can be sent again from the card", async () => {
  await i18n.changeLanguage("en");
  const failed: CoordinatorTurn = { ...turn, status: "failed", waiting: false, error: "conversation_busy", answeredAt: new Date().toISOString(), seen: true };
  setConversationState({ conversation: { ...empty, turns: [failed] }, open: true, expanded: true, read: true });
  const fetcher = vi.fn().mockResolvedValue(reply({ ...empty, turns: [failed, { ...turn, id: "retry-1", status: "queued", waiting: true }] }));
  stubFetch(fetcher);
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  fireEvent.click(await screen.findByRole("button", { name: "Send again" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({ conversationId: empty.id, retryOf: turn.id, text: turn.ask, tasks: turn.tasks, attachments: [] });
});

test("a turn sent again goes with the reply reference as well as the questions its draft answered", async () => {
  await i18n.changeLanguage("en");
  const replyTo = { id: "source-request", answeredAt: new Date().toISOString(), head: "Original answer" };
  const answers = ["L-first", "L-second"].map(question => ({ task: "T13", question }));
  const failed: CoordinatorTurn = { ...turn, status: "failed", waiting: false, error: "conversation_busy", answeredAt: new Date().toISOString(), seen: true, answers, replyTo };
  setConversationState({ conversation: { ...empty, turns: [failed] }, open: true, expanded: true, read: true });
  const fetcher = vi.fn().mockResolvedValue(reply({ ...empty, turns: [failed, { ...turn, id: "retry-1", status: "queued", waiting: true, answers }] }));
  stubFetch(fetcher);
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  fireEvent.click(await screen.findByRole("button", { name: "Send again" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const posted = JSON.parse(fetcher.mock.calls[0]![1].body);
  expect(posted).toMatchObject({ text: turn.ask, replyTo: replyTo.id });
  expect(posted.answers).toEqual(answers);
});

test("a server accepted message appears and a later read supplies its answer", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(empty))
    .mockResolvedValueOnce(reply({ ...empty, turns: [turn] }))
    .mockResolvedValueOnce(reply({ ...empty, turns: [{ ...turn, status: "succeeded", waiting: false, answer: "Checked", answeredAt: new Date().toISOString() }] }));
  stubFetch(fetcher);
  await useConversation.getState().refresh();
  screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }));
  await useConversation.getState().ask({ conversationId: useConversation.getState().conversation!.id, id: "turn-1", text: "T13 ?", tasks: ["T13"], attachments: [], selected: { model: "opus" } });
  expect(useConversation.getState().conversation?.turns[0]?.status).toBe("running");
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ conversationId: "conversation-1", id: "turn-1", text: "T13 ?", tasks: ["T13"],
    attachments: [], selected: { model: "opus" } });
  await useConversation.getState().refresh();
  expect(useConversation.getState().conversation?.turns[0]?.answer).toBe("Checked");
  expect(useConversation.getState().read).toBe(false);
});

test("folded, a failed last turn says it failed, not the answer before it", async () => {
  await i18n.changeLanguage("en");
  const earlier: CoordinatorTurn = { ...turn, id: "turn-0", status: "succeeded", waiting: false, answer: "Previous answer.Continued", answeredAt: "2026-10-16T08:00:00.000Z" };
  const failed: CoordinatorTurn = { ...turn, status: "failed", waiting: false, error: "conversation_busy", answeredAt: "2026-10-16T09:00:00.000Z" };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ ...empty, turns: [earlier, failed] })));
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  await act(() => useConversation.getState().refresh());
  const pill = await waitFor(() => { const found = document.querySelector<HTMLElement>("[data-coordinator-pill]"); expect(found).not.toBeNull(); return found!; });
  expect(pill.textContent).toContain("The conversation is in use");
  expect(pill.textContent).not.toContain("Previous answer");
});

test("clear replaces the conversation and ignores a stale read", async () => {
  let release!: (value: Response) => void;
  const stale = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply({ ...empty, turns: [turn] }))
    .mockReturnValueOnce(stale).mockResolvedValueOnce(reply({ id: "conversation-2", agent: null, warm: 'none' as const, busy: false, cancelled: [], turns: [] })));
  await useConversation.getState().refresh();
  const pending = useConversation.getState().refresh();
  await useConversation.getState().clear();
  release(reply({ ...empty, turns: [turn] }));
  await pending;
  expect(useConversation.getState().conversation).toEqual({ id: "conversation-2", agent: null, warm: 'none' as const, busy: false, cancelled: [], turns: [] });
});

test("the input standing at the foot does not warm a new conversation up; opening the conversation warms it once", async () => {
  await i18n.changeLanguage("en");
  const fetcher = vi.fn().mockResolvedValueOnce(reply(empty)).mockResolvedValueOnce(reply({ ...empty, warm: 'preparing' as const, busy: true }))
    .mockResolvedValue(reply({ ...empty, warm: 'preparing' as const, busy: true }));
  stubFetch(fetcher);
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  await act(() => useConversation.getState().refresh());
  await waitFor(() => expect(useConversation.getState().conversation?.id).toBe(empty.id));
  // Standing there from the page's start is not turning to it: nothing is loaded in the background yet.
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/coordinator/warm")).toHaveLength(0);
  act(() => useConversation.getState().setExpanded(true));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/coordinator/warm")).toHaveLength(1));
  const warms = fetcher.mock.calls.filter(([url]) => url === "/api/coordinator/warm");
  expect(warms).toHaveLength(1);
  expect(JSON.parse(warms[0]![1].body)).toEqual({ conversationId: "conversation-1", selected: {}, agent: "claude" });
  // Already warming, a later open does not ask again.
  act(() => { useConversation.getState().setExpanded(false); useConversation.getState().setExpanded(true); });
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/coordinator").length).toBeGreaterThan(1));
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/coordinator/warm")).toHaveLength(1);
});

test("a conversation that has messages is not warmed up and shows no getting ready", async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ ...empty, turns: [{ ...turn, status: "succeeded", waiting: false, answer: "Done", answeredAt: new Date().toISOString(), seen: true }] }));
  stubFetch(fetcher);
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  act(() => useConversation.getState().setExpanded(true));
  await waitFor(() => expect(document.querySelector("[data-ask-answer]")?.textContent).toBe("Done"));
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/coordinator/warm")).toHaveLength(0);
  expect(document.querySelector("[data-coordinator-warm]")).toBeNull();
});

test("a cleared conversation says how far the coordinator has got ready, offers examples unless it failed, and nothing once it has a message", async () => {
  await i18n.changeLanguage("ja");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(empty)));
  setConversationState({ conversation: { ...empty, warm: "preparing" }, open: true, expanded: true, read: true });
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  const row = () => document.querySelector<HTMLElement>("[data-coordinator-warm]");
  // The one status line goes through the states the person reads; four examples to start from stand under it, except
  // when it could not start.
  const says = (state: string, words: string) => {
    expect(row()?.dataset.coordinatorWarm).toBe(state);
    expect(row()?.querySelector('[role="status"]')?.textContent).toBe(words);
    expect(row()?.querySelectorAll("[data-warm-example]")).toHaveLength(state === "failed" ? 0 : 4);
  };
  says("preparing", "コーディネーターを起動中です");
  act(() => setConversationState({ conversation: { ...empty, warm: "ready" } }));
  says("ready", "こんにちは。何をお手伝いしますか？");
  act(() => setConversationState({ conversation: { ...empty, warm: "failed" } }));
  says("failed", "コーディネーターの起動に失敗しました。");
  // Before the server has a warm-up, the page's own ask stands for it: about to go or on its way, then refused.
  act(() => setConversationState({ conversation: { ...empty, warm: "none" } }));
  says("preparing", "コーディネーターを起動中です");
  act(() => setConversationState({ warmRefused: empty.id }));
  says("failed", "コーディネーターの起動に失敗しました。");
  act(() => setConversationState({ warmRefused: null }));
  act(() => setConversationState({ conversation: { ...empty, warm: "ready", turns: [{ ...turn, status: "succeeded", waiting: false, answer: "Done", answeredAt: new Date().toISOString() }] } }));
  await waitFor(() => expect(document.querySelector("[data-ask-answer]")?.textContent).toBe("Done"));
  expect(row()).toBeNull();
});

test("a first conversation points to the phone and app guide until it is pressed, closed or the conversation has a message", async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(empty)));
  const hint = () => document.querySelector<HTMLElement>("[data-app-hint]");
  const fresh = () => { appHintDone.remove(); useDialogStore.setState({ dialog: null }); };
  fresh();
  setConversationState({ conversation: { ...empty, warm: "ready" }, open: true, expanded: true, read: true });
  const view = render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  // Pressed: the settings open on the apps tab, and the line is gone for good.
  fireEvent.click(screen.getByRole("button", { name: "Use on your phone or as an app" }));
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: "settings", tab: "apps" });
  expect(hint()).toBeNull();
  // Closed: gone too, and the settings stay shut.
  fresh(); view.rerender(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  await waitFor(() => expect(hint()).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Close this tip" }));
  expect(hint()).toBeNull();
  expect(useDialogStore.getState().dialog).toBeNull();
  // A conversation with a message: the person has started, so a later empty conversation shows no line either.
  fresh();
  act(() => setConversationState({ conversation: { ...empty, warm: "ready", turns: [{ ...turn, status: "succeeded", waiting: false, answer: "Done", answeredAt: new Date().toISOString() }] } }));
  await waitFor(() => expect(appHintDone.get()).toBe(true));
  act(() => setConversationState({ conversation: { ...empty, warm: "ready" } }));
  expect(document.querySelector("[data-coordinator-warm]")).not.toBeNull();
  expect(hint()).toBeNull();
  appHintDone.remove();
});

test("a first message sent while the coordinator is still getting ready takes the getting-ready line's place", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(empty)));
  // Serve holds the message behind its warm-up: queued and waiting, in no list but the thread's end.
  setConversationState({ conversation: { ...empty, warm: "preparing", busy: true, turns: [{ ...turn, status: "queued", waiting: true }] }, open: true, expanded: true, read: true });
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  expect(document.querySelector("[data-coordinator-waiting]")).not.toBeNull();
  expect(document.querySelector("[data-coordinator-warm]")).toBeNull();
});

test("a warm-up the server refuses leaves the cleared conversation saying it could not get ready", async () => {
  await i18n.changeLanguage("ja");
  const fetcher = vi.fn(async (url: string) => url === "/api/coordinator/warm"
    ? new Response(JSON.stringify({ error: { code: "internal", message: "down" } }), { status: 500 }) : reply(empty));
  stubFetch(fetcher);
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  await act(() => useConversation.getState().refresh());
  act(() => useConversation.getState().setExpanded(true));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/coordinator/warm")).toHaveLength(1));
  await waitFor(() => expect(document.querySelector("[data-coordinator-warm]")?.textContent).toBe("コーディネーターの起動に失敗しました。"));
  expect(useConversation.getState().warmRefused).toBe(empty.id);
});

test("a late refusal of an earlier conversation's warm-up neither replaces the shown one's nor says it", async () => {
  await i18n.changeLanguage("ja");
  let refuseEarlier!: () => void;
  const earlier = new Promise<Response>(resolve => { refuseEarlier = () => resolve(new Response(JSON.stringify({ error: { code: "internal", message: "down" } }), { status: 500 })); });
  const refused = () => new Response(JSON.stringify({ error: { code: "internal", message: "down" } }), { status: 500 });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => url !== "/api/coordinator/warm" ? reply(empty)
    : JSON.parse(String(init?.body)).conversationId === "conversation-a" ? earlier : refused());
  stubFetch(fetcher);
  setConversationState({ conversation: { ...empty, id: "conversation-a" }, open: true, warmRefused: null });
  const asking = useConversation.getState().warm({});
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/coordinator/warm")).toHaveLength(1));
  setConversationState({ conversation: { ...empty, id: "conversation-b" } });
  await act(() => useConversation.getState().warm({}));
  expect(useConversation.getState().warmRefused).toBe("conversation-b");
  refuseEarlier(); await act(() => asking);
  expect(useConversation.getState().warmRefused).toBe("conversation-b");
});

test("with no adapter configured the warm-up is asked all the same, and its refusal is said", async () => {
  await i18n.changeLanguage("ja");
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url === "/api/coordinator/warm"
    ? new Response(JSON.stringify({ error: { code: "invalid_settings", message: "No configured agent can be the coordinator" } }), { status: 400 }) : reply(empty));
  stubFetch(fetcher);
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })], profiles: [] }))}><CoordinatorCard /></TestWorkspace>);
  await act(() => useConversation.getState().refresh());
  act(() => useConversation.getState().setExpanded(true));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/coordinator/warm")).toHaveLength(1));
  expect(JSON.parse(fetcher.mock.calls.find(([url]) => url === "/api/coordinator/warm")![1]!.body as string).agent).toBeUndefined();
  await waitFor(() => expect(document.querySelector("[data-coordinator-warm]")?.textContent).toBe("コーディネーターの起動に失敗しました。"));
});

test("an answer is drawn by the reports' Markdown and task references open the task through their card", async () => {
  const answer = "## Summary\n**T1** Review.\n\n- First item\n\n| Field | State |\n|---|---|\n| Test | Passed |\n\n```\npnpm build\n```";
  setConversationState({ conversation: { ...empty, turns: [{ ...turn, status: "succeeded", waiting: false, answer, answeredAt: new Date().toISOString(), seen: true }] }, open: true, expanded: true, read: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(empty)));
  const openTask = vi.spyOn(useViewStore.getState(), "openTask");
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  const area = document.querySelector<HTMLElement>("[data-ask-answer]")!;
  expect(area.querySelector("h3")?.textContent).toBe("Summary");
  expect(area.querySelector(`strong [data-task-reference='T1']`)).not.toBeNull();
  expect(area.querySelector("li")?.textContent).toBe("First item");
  expect([...area.querySelectorAll("td")].map(cell => cell.textContent)).toEqual(["Field", "State", "Test", "Passed"]);
  expect(area.querySelector("pre")?.textContent).toBe("pnpm build");
  openReference(area.querySelector<HTMLElement>(`[data-task-reference='T1']`)!);
  expect(openTask).toHaveBeenCalledWith("T1", { reader: true });
});

/** The screen's data with the person's launch memory as the index brings it. */
const remembering = (memory: LaunchMemory) => { const data = screenData(tree({ profiles: launchProfiles })); return { ...data, info: { ...data.info, launchMemory: memory } }; };
const launchProfiles: ControlTreeDTO["profiles"] = [launchProfile("claude", { model: ["opus", "fable"], effort: ["high", "max"] }),
  launchProfile("codex", { model: ["gpt-6.1-sol", "gpt-6-astra"], effort: ["low", "xhigh"] })];
test("the coordinator input offers every adapter and sends its chosen model and effort", async () => {
  await i18n.changeLanguage("en");
  const fetcher = vi.fn().mockImplementation(async (url: string) => url === "/api/launch-memory"
    ? new Response(JSON.stringify({ memory: { agent: null, values: {} } }), { status: 200, headers: { "Content-Type": "application/json" } })
    : reply({ ...empty, turns: [] }));
  stubFetch(fetcher);
  render(<TestWorkspace data={remembering({ agent: "codex", values: { claude: { model: "fable", effort: "low" } } })}><CoordinatorCard /></TestWorkspace>);
  useConversation.getState().setOpen(true);
  // A new conversation starts with the last agent chosen on any screen, its first model and its lightest effort.
  const picker = await screen.findByRole("button", { name: i18n.t("forms:agentPicker.pickerLabel", { agent: "gpt-6.1-sol(low)" }) });
  fireEvent.click(picker);
  // The kept model comes back on its agent; the kept effort is no longer offered, so its first value is used.
  fireEvent.click(screen.getByRole("radio", { name: /fable/ }));
  expect(screen.getByRole("button", { name: i18n.t("forms:agentPicker.pickerLabel", { agent: "fable(high)" }) })).toBeTruthy();
  // It can switch to either configured Codex model.
  expect(screen.getByText("gpt-6.1-sol")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /gpt-6-astra/ }));
  expect(screen.queryByRole("radio", { name: "max" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "xhigh" }));
  // Each choice is kept on the server, for the next new conversation on any screen: the row chosen, each time.
  const saved = fetcher.mock.calls.filter(([url]) => url === "/api/launch-memory").map(([, init]) => JSON.parse(init.body).change);
  expect(saved.slice(-2)).toEqual([{ kind: "choose", agent: "codex", values: { model: "gpt-6-astra" } },
    { kind: "choose", agent: "codex", values: { effort: "xhigh" } }]);
  writeEditor("Continued");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === "/api/coordinator/messages")).toBe(true));
  const sent = fetcher.mock.calls.find(([url]) => url === "/api/coordinator/messages")!;
  expect(JSON.parse(sent[1].body)).toMatchObject({ text: "Continued", agent: "codex", selected: { model: "gpt-6-astra", effort: "xhigh" } });
});

test("a message going on in the conversation sends only what is changed in its picker, not this device's last choice", async () => {
  await i18n.changeLanguage("en");
  const fetcher = vi.fn().mockImplementation(async () => reply({ ...empty, agent: "claude", previousValues: { model: "fable", effort: "high" },
    turns: [{ ...turn, status: "succeeded", waiting: false, answer: "Done", answeredAt: new Date().toISOString() }] }));
  stubFetch(fetcher);
  render(<TestWorkspace data={remembering({ agent: "codex", values: { claude: { model: "opus", effort: "max" } } })}><CoordinatorCard /></TestWorkspace>);
  useConversation.getState().setOpen(true);
  await act(() => useConversation.getState().refresh());
  const sent = () => fetcher.mock.calls.filter(([url]) => url === "/api/coordinator/messages").map(([, init]) => JSON.parse(init.body));
  // The conversation's agent and its previous values, not the device's last ones.
  fireEvent.click(await screen.findByRole("button", { name: /^fable\(high\)/ }));
  fireEvent.click(screen.getByRole("radio", { name: "max" }));
  writeEditor("Think harder");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(sent()).toHaveLength(1));
  expect(sent()[0]).toMatchObject({ agent: "claude", selected: { effort: "max" } });
  expect(sent()[0].selected).not.toHaveProperty("model");
});

test("a message whose conversation's agent the settings no longer enable, with no other agent left, says so and does not go", async () => {
  await i18n.changeLanguage("en");
  const fetcher = vi.fn().mockImplementation(async () => reply({ ...empty, agent: "claude", previousValues: { model: "opus", effort: "high" },
    turns: [{ ...turn, status: "succeeded", waiting: false, answer: "Done", answeredAt: new Date().toISOString() }] }));
  stubFetch(fetcher);
  render(<TestWorkspace data={screenData(tree({ profiles: [] }))}><CoordinatorCard /></TestWorkspace>);
  useConversation.getState().setOpen(true);
  await act(() => useConversation.getState().refresh());
  expect(await screen.findByText(i18n.t("forms:agentPicker.brief.gone"))).toBeTruthy();
  writeEditor("Continue please");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText(i18n.t("forms:agentPicker.problem.gone", { agent: "claude" }))).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => url === "/api/coordinator/messages")).toBe(false);
});

test("a message whose conversation's previous model is no longer offered does not go: the picker opens to choose again", async () => {
  await i18n.changeLanguage("en");
  const fetcher = vi.fn().mockImplementation(async () => reply({ ...empty, agent: "claude", previousValues: { model: "sonnet", effort: "max" }, turns: [{ ...turn, status: "succeeded", waiting: false, answer: "Done", answeredAt: new Date().toISOString() }] }));
  stubFetch(fetcher);
  render(<TestWorkspace data={screenData(tree({ profiles: launchProfiles }))}><CoordinatorCard /></TestWorkspace>);
  useConversation.getState().setOpen(true);
  await act(() => useConversation.getState().refresh());
  // Closed, the chip says what to do in one short line; the whole reason is its title.
  const said = await screen.findByRole("alert");
  expect(said.textContent).toBe(i18n.t("forms:agentPicker.brief.select_value", { row: i18n.t("forms:responsibleForm.model") }));
  expect(said.getAttribute("title")).toMatch(/sonnet/);
  writeEditor("Go on");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(document.querySelector("[data-agent-picker-menu]")).not.toBeNull();
  expect(fetcher.mock.calls.some(([url]) => url === "/api/coordinator/messages")).toBe(false);
  // Chosen again, it goes with that choice only.
  fireEvent.click(screen.getByRole("radio", { name: /^fable/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === "/api/coordinator/messages")).toBe(true));
  expect(JSON.parse(fetcher.mock.calls.find(([url]) => url === "/api/coordinator/messages")![1].body).selected).toEqual({ model: "fable" });
});

test("a failed turn sent again with a previous model no longer offered does not go until chosen again, then goes once", async () => {
  await i18n.changeLanguage("en");
  const failed: CoordinatorTurn = { ...turn, status: "failed", waiting: false, error: "conversation_busy", answeredAt: new Date().toISOString() };
  const previousValues = { model: "sonnet", effort: "max" };
  setConversationState({ conversation: { ...empty, agent: "claude", previousValues, turns: [failed] }, open: true, expanded: true, read: true });
  const fetcher = vi.fn().mockImplementation(async () => reply({ ...empty, agent: "claude", previousValues, turns: [failed, { ...turn, id: "retry-1", status: "queued", waiting: true }] }));
  stubFetch(fetcher);
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })], profiles: launchProfiles }))}><CoordinatorCard /></TestWorkspace>);
  const posts = () => fetcher.mock.calls.filter(([url]) => url === "/api/coordinator/messages").map(([, init]) => JSON.parse(init.body));
  fireEvent.click(await screen.findByRole("button", { name: "Send again" }));
  await waitFor(() => expect(document.querySelector("[data-agent-picker-menu]")).not.toBeNull());
  expect(posts()).toEqual([]);
  fireEvent.click(screen.getByRole("radio", { name: /^fable/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send again" }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]).toMatchObject({ agent: "claude", selected: { model: "fable" } });
});

test("a message sent again after an unknown result goes with the choice it was first sent with", async () => {
  await i18n.changeLanguage("en");
  const done = { ...empty, agent: "claude", previousValues: { model: "opus", effort: "high" }, turns: [{ ...turn, status: "succeeded", waiting: false, answer: "Done", answeredAt: new Date().toISOString() }] };
  let lost = true;
  const fetcher = vi.fn().mockImplementation(async (url: string) => {
    if (url === "/api/coordinator/messages" && lost) { lost = false; throw new TypeError("network"); }
    return reply(done);
  });
  stubFetch(fetcher);
  render(<TestWorkspace data={remembering({ agent: "claude", values: { claude: { model: "fable", effort: "max" } } })}><CoordinatorCard /></TestWorkspace>);
  useConversation.getState().setOpen(true);
  await act(() => useConversation.getState().refresh());
  fireEvent.click(await screen.findByRole("button", { name: /^opus\(high\)/ }));
  fireEvent.click(screen.getByRole("radio", { name: "max" }));
  writeEditor("Continued");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  // Unknown, its line says so and the conversation keeps it to resend.
  await screen.findByText("Couldn't confirm whether it arrived.");
  act(() => useConversation.getState().setExpanded(true));
  // Chosen anew in between, the chip changes; the message sent again does not.
  fireEvent.click(screen.getByRole("radio", { name: "high" }));
  fireEvent.click(screen.getByRole("button", { name: "Send again" }));
  const sent = () => fetcher.mock.calls.filter(([url]) => url === "/api/coordinator/messages").map(([, init]) => JSON.parse(init.body));
  await waitFor(() => expect(sent()).toHaveLength(2));
  expect(sent()[1].id).toBe(sent()[0].id);
  expect(sent()[1].selected).toEqual({ effort: "max" });
});

test("after changing to a model without effort, the coordinator input sends no effort", async () => {
  await i18n.changeLanguage("en");
  const profiles: ControlTreeDTO["profiles"] = [launchProfile("pi", { model: ["model-with-effort", "fixed-first"], effort: ["high", "low", "medium"] },
    ["effort"], { "fixed-first": ["effort"] })];
  const fetcher = vi.fn().mockImplementation(async () => reply({ ...empty, agent: "pi", previousValues: { model: "model-with-effort", effort: "high" }, turns: [{ ...turn, status: "succeeded", waiting: false, answer: "Done", answeredAt: new Date().toISOString(), seen: true }] }));
  stubFetch(fetcher);
  render(<TestWorkspace data={screenData(tree({ profiles }))}><CoordinatorCard /></TestWorkspace>);
  useConversation.getState().setOpen(true);
  await act(() => useConversation.getState().refresh());
  fireEvent.click(await screen.findByRole("button", { name: i18n.t("forms:agentPicker.pickerLabel", { agent: "model-with-effort(high)" }) }));
  fireEvent.click(screen.getByRole("radio", { name: /fixed-first/ }));
  expect(screen.queryByRole("radio", { name: "low" })).toBeNull();
  writeEditor("Continued");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === "/api/coordinator/messages")).toBe(true));
  const sent = JSON.parse(fetcher.mock.calls.find(([url]) => url === "/api/coordinator/messages")![1].body);
  expect(sent).toMatchObject({ agent: "pi" });
  expect(sent.selected).toEqual({ model: "fixed-first" });
});

test("a send's answer arriving after a newer read of the conversation does not bring the queued turn back", async () => {
  setConversationState({ conversation: empty, open: false, read: true, error: null });
  let release!: (value: Response) => void;
  const delayed = new Promise<Response>((resolve) => { release = resolve; });
  const done = { ...empty, turns: [{ ...turn, status: "succeeded", waiting: false, answer: "final answer", answeredAt: new Date().toISOString() }] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/messages") ? delayed : reply(done)));
  const pending = useConversation.getState().ask({ conversationId: useConversation.getState().conversation!.id, id: turn.id, text: turn.ask, attachments: [], selected: {} });
  announceConversation("a:answered");
  await waitFor(() => expect(useConversation.getState().conversation?.turns[0]?.answer).toBe("final answer"));
  release(reply({ ...empty, turns: [{ ...turn, status: "queued", waiting: true }] }));
  expect(await pending).toBe(true);
  expect(useConversation.getState().conversation?.turns[0]?.answer).toBe("final answer");
});

test("a send that fails takes nothing from a read sent before it: the read's answer is shown", async () => {
  setConversationState({ conversation: { ...empty, turns: [turn as CoordinatorTurn] }, open: false, read: true, error: null });
  let release!: (value: Response) => void;
  const delayed = new Promise<Response>((resolve) => { release = resolve; });
  const done = { ...empty, turns: [{ ...turn, status: "succeeded", waiting: false, answer: "final answer", answeredAt: new Date().toISOString() }] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/messages")) throw new TypeError("send offline");
    return delayed;
  }));
  announceConversation("a:send-failed");
  await expect(useConversation.getState().ask({ conversationId: useConversation.getState().conversation!.id, id: "next", text: "next", attachments: [], selected: {} })).rejects.toThrow();
  release(reply(done));
  await waitFor(() => expect(useConversation.getState().conversation?.turns[0]?.answer).toBe("final answer"));
});

test("a warm-up that fails takes nothing from a read sent before it", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setConversationState({ conversation: empty, open: true, read: true, error: null });
  let release!: (value: Response) => void;
  const delayed = new Promise<Response>((resolve) => { release = resolve; });
  const done = { ...empty, turns: [{ ...turn, status: "succeeded", waiting: false, answer: "elsewhere", answeredAt: new Date().toISOString() }] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/warm")) throw new TypeError("warm offline");
    return delayed;
  }));
  announceConversation("a:warm-failed");
  await useConversation.getState().warm({});
  release(reply(done));
  await waitFor(() => expect(useConversation.getState().conversation?.turns[0]?.answer).toBe("elsewhere"));
  expect(useConversation.getState().error).toBeNull();
});

test("a late queue action cannot replace a newer completed conversation read", async () => {
  setConversationState({ conversation: { ...empty, turns: [turn as CoordinatorTurn] }, open: false, read: true, error: null });
  let release!: (value: Response) => void;
  const delayed = new Promise<Response>(resolve => { release = resolve; });
  const done = { ...empty, turns: [{ ...turn, status: 'succeeded', waiting: false, answer: 'newest answer', answeredAt: new Date().toISOString() }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/send-now') ? delayed : reply(done)));
  const action = useConversation.getState().messageAction('send-now', 'queued');
  announceConversation('a:queue-action-answered');
  await waitFor(() => expect(useConversation.getState().conversation?.turns[0]?.answer).toBe('newest answer'));
  release(reply({ ...empty, turns: [{ ...turn, status: 'running', waiting: false }] }));
  await action;
  expect(useConversation.getState().conversation?.turns[0]?.answer).toBe('newest answer');
});

test("mounting a closed unread coordinator does not read it until it is opened", async () => {
  setConversationState({ conversation: null, open: false, read: false, error: null });
  const fetcher = vi.fn().mockResolvedValue(reply({ ...empty, warm: 'preparing' as const, busy: true }));
  stubFetch(fetcher);
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), dto({ id: "T13" })] }))}><CoordinatorCard /></TestWorkspace>);
  expect(document.querySelector('[data-coordinator-write]')).toBeTruthy();
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator')).toHaveLength(0);
  act(() => useConversation.getState().setOpen(true));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator')).toHaveLength(1));
});


test("a coordinator read ACK keeps its leave-page delivery and requires a live workspace write basis", async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ conversationId: empty.id, seen: [turn.id] }));
  vi.stubGlobal("fetch", fetcher);
  await expect(markCoordinatorSeen(empty.id, [turn.id], true)).resolves.toEqual({ conversationId: empty.id, seen: [turn.id] });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]![0]).toBe("/api/coordinator/read");
  expect(fetcher.mock.calls[0]![1].keepalive).toBe(true);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ conversationId: empty.id, seen: [turn.id] });
  const connection = useConnection.getState();
  try {
    useConnection.setState({ offline: true });
    await expect(markCoordinatorSeen(empty.id, [turn.id], true)).rejects.toMatchObject({ code: "write_unavailable", retry: "later" });
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { useConnection.setState(connection); }
});
