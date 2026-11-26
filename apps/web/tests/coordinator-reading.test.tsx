import { setConversationState, SERVED, servedTurn } from './conversation-fixture';
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useConversationReading, opening } from "../src/features/coordinator/read-boundary";
import { useConversation } from "../src/features/coordinator/coordinator";
import type { CoordinatorTurn } from "../src/data/coordinator";

// A person's action on a visible page with the conversation open reads what it shows; history folding never controls reading.
const reply = (id: string, seen = false): CoordinatorTurn => servedTurn('conversation', { id, at: "", ask: id, attachments: [], status: "succeeded",
  waiting: false, answer: "Done", answeredAt: "2026-10-21T10:00:00Z", seen, error: null, result: null });
let observed: ReturnType<typeof vi.fn<(ids: readonly string[]) => void>>, flushed: ReturnType<typeof vi.fn<(keepalive?: boolean) => void>>;
let visibility: DocumentVisibilityState;
function Harness() { useConversationReading(document, "fixture", "conversation"); return null; }
const conversation = (turns: CoordinatorTurn[]) => ({ id: "conversation", nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns });
const read = () => observed.mock.calls.flatMap(call => call[0]);
const touch = (type = "pointerdown") => act(() => { document.dispatchEvent(new Event(type)); });
// Mounted folded, then opened by a press: the opening is the first action.
const mount = () => { render(<Harness />); act(() => setConversationState({ expanded: true })); };
const show = (visible: DocumentVisibilityState) => act(() => { visibility = visible; document.dispatchEvent(new Event("visibilitychange")); });
beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  observed = vi.fn(); flushed = vi.fn();
  setConversationState(useConversation.getInitialState());
  const turns = [reply("old", true), reply("unread"), reply("latest", true)];
  setConversationState({ root: "fixture", conversation: conversation(turns), expanded: false, open: true, opening: opening(turns),
    observeSeen: observed, flushSeen: flushed });
});
afterEach(() => { cleanup(); setConversationState(useConversation.getInitialState()); });

test("opening reads folded and latest replies; a reply arriving later stays unread until the next action there", () => {
  mount();
  expect(read()).toEqual(["unread"]);
  observed.mockClear();
  act(() => setConversationState({ conversation: conversation([reply("old", true), reply("unread", true), reply("latest", true), reply("new")]) }));
  expect(read()).toEqual([]);
  touch("keydown");
  expect(observed).toHaveBeenLastCalledWith(["new"]);
});

test("text entered without a key event is an action", () => {
  mount();
  observed.mockClear();
  act(() => setConversationState({ conversation: conversation([reply("old", true), reply("unread", true), reply("new")]) }));
  expect(read()).toEqual([]);
  touch("beforeinput");
  expect(read()).toEqual(["new"]);
});

test("a press before the conversation has loaded leaves what arrives unread until the next action", () => {
  setConversationState({ conversation: null });
  render(<Harness />);
  act(() => setConversationState({ expanded: true, opening: opening([], 1) }));
  act(() => setConversationState({ conversation: conversation([reply("old", true), reply("first")]) }));
  expect(read()).toEqual([]);
  touch();
  expect(read()).toEqual(["first"]);
});

test("a pending presentation refresh cannot keep completed replies unread", () => {
  const turns = [reply("old", true), reply("unread")];
  setConversationState({ conversation: conversation(turns), opening: opening(turns, 99) });
  mount();
  expect(read()).toEqual(["unread"]);
});

test("a page out of sight reads nothing; coming back into view is not an action; leaving it sends what is pending", () => {
  const turns = [reply("old", true)];
  setConversationState({ conversation: conversation(turns), opening: opening(turns) });
  mount();
  show("hidden");
  expect(flushed).toHaveBeenCalledWith(true);
  act(() => setConversationState({ conversation: conversation([...turns, reply("new")]) }));
  touch();
  expect(read()).toEqual([]);
  show("visible");
  expect(read()).toEqual([]);
  touch();
  expect(read()).toEqual(["new"]);
});

test("opening only the input leaves a closed conversation unread", () => {
  setConversationState({ open: true, expanded: false, opening: null });
  render(<Harness />);
  act(() => setConversationState({ conversation: conversation([reply("old", true), reply("unread"), reply("closed")]) }));
  touch();
  expect(read()).toEqual([]);
});
