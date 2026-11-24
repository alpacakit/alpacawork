import { setConversationState } from './conversation-fixture';
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ATTENDED_MS, useConversationReading, opening } from "../src/features/coordinator/read-boundary";
import { useConversation } from "../src/features/coordinator/coordinator";
import type { CoordinatorTurn } from "../src/data/coordinator";

// Conversation visibility alone controls observation; history folding never controls reading.
const reply = (id: string, seen = false): CoordinatorTurn => ({ id, at: "", ask: id, attachments: [], status: "succeeded",
  waiting: false, answer: "Done", answeredAt: "2026-10-21T10:00:00Z", seen, error: null, result: null });
let observed: ReturnType<typeof vi.fn<(ids: readonly string[]) => void>>, flushed: ReturnType<typeof vi.fn<(keepalive?: boolean) => void>>;
let visibility: DocumentVisibilityState;
function Harness() { useConversationReading(document, "fixture", "conversation"); return null; }
const conversation = (turns: CoordinatorTurn[]) => ({ id: "conversation", nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false, cancelled: [], turns });
const read = () => observed.mock.calls.flatMap(call => call[0]);
const touch = (type = "pointerdown") => act(() => { document.dispatchEvent(new Event(type)); });
// Mounted, then a person acts on the page (the press that opens the conversation).
const mount = () => { render(<Harness />); touch(); };
const show = (visible: DocumentVisibilityState) => act(() => { visibility = visible; document.dispatchEvent(new Event("visibilitychange")); });
// Each case starts well past the last one's actions: the page's last action is kept per document.
let clock = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock += 10 * ATTENDED_MS);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  observed = vi.fn(); flushed = vi.fn();
  setConversationState(useConversation.getInitialState());
  const turns = [reply("old", true), reply("unread"), reply("latest", true)];
  setConversationState({ root: "fixture", conversation: conversation(turns), expanded: true, open: true, opening: opening(turns),
    observeSeen: observed, flushSeen: flushed });
});
afterEach(() => { cleanup(); vi.useRealTimers(); setConversationState(useConversation.getInitialState()); });

test("opening observes folded and latest replies together, and new replies use the same rule", () => {
  mount();
  expect(read()).toEqual(["unread"]);
  observed.mockClear();
  act(() => setConversationState({ conversation: conversation([reply("old", true), reply("unread", true), reply("latest", true), reply("new")]) }));
  expect(observed).toHaveBeenLastCalledWith(["new"]);
});

test("a pending presentation refresh cannot keep completed replies unread", () => {
  const turns = [reply("old", true), reply("unread")];
  setConversationState({ conversation: conversation(turns), opening: opening(turns, 99) });
  mount();
  expect(read()).toEqual(["unread"]);
});

test("a page out of sight reads nothing until it is shown again, and leaving it sends what is pending", () => {
  const turns = [reply("old", true)];
  setConversationState({ conversation: conversation(turns), opening: opening(turns) });
  mount();
  show("hidden");
  expect(flushed).toHaveBeenCalledWith(true);
  act(() => setConversationState({ conversation: conversation([...turns, reply("new")]) }));
  expect(read()).toEqual([]);
  show("visible");
  expect(read()).toEqual(["new"]);
});

test("opening only the input leaves a closed conversation unread", () => {
  setConversationState({ open: true, expanded: false, opening: null });
  mount();
  act(() => setConversationState({ conversation: conversation([reply("old", true), reply("unread"), reply("closed")]) }));
  expect(read()).toEqual([]);
});

test("a reply reaching an open page nobody has acted on for a while stays unread until someone acts there", () => {
  const turns = [reply("old", true)];
  setConversationState({ conversation: conversation(turns), opening: opening(turns) });
  mount();
  vi.advanceTimersByTime(ATTENDED_MS + 1);
  act(() => setConversationState({ conversation: conversation([...turns, reply("new")]) }));
  expect(read()).toEqual([]);
  touch("keydown");
  expect(read()).toEqual(["new"]);
});
