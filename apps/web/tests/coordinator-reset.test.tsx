import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { CoordinatorCard } from "../src/features/coordinator/CoordinatorCard";
import { CoordinatorContext } from "../src/features/coordinator/CoordinatorContext";
import { useConversation } from "../src/features/coordinator/coordinator";
import { resetReason } from "../src/features/coordinator/reset-words";
import { rememberWriteIdentity } from "../src/data/write-identity";
import type { CoordinatorReset, CoordinatorTurn } from "../src/data/coordinator";
import { screenData, TestWorkspace, tree, dto } from "./fixtures";
import { SERVED, setConversationState, snapshotJson } from "./conversation-fixture";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 6, minute)).toISOString();
const answered = (id: string, minute: number): CoordinatorTurn => ({ id, at: at(minute), ask: `ask ${id}`, attachments: [], status: "succeeded",
  waiting: false, answer: `answer ${id}`, answeredAt: at(minute), seen: true, error: null, result: null });
const empty = { id: "conversation-1", nextLaunch: { agent: "claude", values: {} }, ...SERVED, busy: false, turns: [] as CoordinatorTurn[] };
/** A reset's ID is a UUID; tests name it by its last digit. */
const resetId = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const reset = (n: number, before: string | null, reason: CoordinatorReset["reason"] = { kind: "asked" }): CoordinatorReset =>
  ({ id: resetId(n), beforeRequestId: before, at: at(30), reason });
const json = (body: unknown) => new Response(snapshotJson(body), { status: 200 });
const card = () => render(<TestWorkspace data={screenData(tree({ tasks: [dto()] }))}><CoordinatorCard /></TestWorkspace>);
const thread = () => document.querySelector<HTMLElement>("[data-coordinator-thread]")!;
/** The thread's rows top to bottom: each message by its ID, each reset line by its kind. */
const order = () => [...thread().children].map(row => (row as HTMLElement).dataset.coordinatorMessage ?? (row as HTMLElement).dataset.coordinatorResetLine
  ?? ((row as HTMLElement).dataset.earlier !== undefined ? "earlier" : (row as HTMLElement).dataset.earlierMore !== undefined ? "more" : "?"));

beforeAll(() => startI18n());
beforeEach(async () => {
  await i18n.changeLanguage("ja");
  screenData(tree({ tasks: [dto()] }));
  rememberWriteIdentity("/fixture", "conversation-1", "initial");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setConversationState({ conversation: null, open: true, expanded: false, engaged: false, read: true, error: null }); });

test("a reset is said in one line before the message it started with, with its reason, and at the end until there is one", () => {
  const conversation = { ...empty, turns: [answered("a", 1), answered("b", 2)],
    resets: [reset(1, "b", { kind: "context", over: { tokens: 200000 } } as const), reset(2, null)] };
  vi.stubGlobal("fetch", vi.fn(async () => json(conversation)));
  setConversationState({ open: true, expanded: true, read: true, conversation });
  card();
  // The older exchange folds into the history; the line stays with the latest one.
  expect(order()).toEqual(["earlier", "context", "b", "asked"]);
  const lines = [...thread().querySelectorAll<HTMLElement>("[data-coordinator-reset-line]")].map(line => line.textContent);
  expect(lines[0]).toContain("コーディネーターをリセットしました · 使用量が20万トークンを超えたため");
  // Asked for by the person: no reason.
  expect(lines[1]).toBe("コーディネーターをリセットしました引き継いだメモを見る");
});

test("each reason reads as the line says it, the AI change by its models", () => {
  const t = i18n.getFixedT("ja", "ui");
  expect(resetReason({ kind: "asked" }, t)).toBeNull();
  expect(resetReason({ kind: "context", over: { percent: 50 } }, t)).toBe("使用量が50%を超えたため");
  expect(resetReason({ kind: "another_ai", from: { agent: "claude", values: { model: "opus", effort: "medium" } },
    to: { agent: "codex", values: { model: "gpt-6.2-sol", effort: "high" } } }, t)).toBe("AI を opus から gpt-6.2-sol に変えたため");
  expect(resetReason({ kind: "fallback" }, t)).toBe("予備の AI に移ったため");
});

test("the memo a reset handed over is read when its line asks for it", async () => {
  const conversation = { ...empty, turns: [answered("a", 1)], resets: [reset(1, "a")] };
  const fetcher = vi.fn(async (url: string) => url === `/api/coordinator/resets/${resetId(1)}/memo`
    ? new Response(JSON.stringify({ text: "決めたこと: 今週中に出す", updatedAt: at(20) }), { status: 200 }) : json(conversation));
  vi.stubGlobal("fetch", fetcher);
  setConversationState({ open: true, expanded: true, read: true, conversation });
  card();
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/memo"))).toHaveLength(0);
  fireEvent.click(document.querySelector("[data-coordinator-reset-memo]")!);
  await waitFor(() => expect(document.querySelector("[data-coordinator-reset-memo-text]")?.textContent).toContain("決めたこと: 今週中に出す"));
  expect(document.querySelector("[data-coordinator-reset-memo-text]")?.textContent).toContain("メモの後の発言も AI に渡しています。");
});

test("older turns are counted while folded, and read a page at a time once opened, each once", async () => {
  const older = Array.from({ length: 3 }, (_, index) => answered(`old-${index}`, index));
  const pages: Record<string, { turns: CoordinatorTurn[]; more: string | null }> = {
    "old-2": { turns: [older[1]!, older[2]!], more: "old-1" }, "old-1": { turns: [older[0]!, older[1]!], more: null } };
  const fetcher = vi.fn(async (url: string) => {
    const page = /^\/api\/coordinator\/turns\?conversationId=conversation-1&before=(.+)$/.exec(url);
    return page ? new Response(JSON.stringify({ ...pages[decodeURIComponent(page[1]!)], resets: [] }), { status: 200 }) : json(conversation);
  });
  const conversation = { ...empty, earlier: { count: 3, before: "old-2" }, turns: [answered("a", 10), answered("b", 11)] };
  vi.stubGlobal("fetch", fetcher);
  setConversationState({ open: true, expanded: true, read: true, conversation });
  card();
  // Counted whole: the older exchanges here and the 3 not read yet.
  expect(Number(/(\d+)件/.exec(thread().querySelector("[data-earlier]")?.textContent ?? "")?.[1])).toBeGreaterThanOrEqual(3);
  fireEvent.click(thread().querySelector("[data-earlier] button")!);
  expect(order()).toEqual(["more", "a", "b"]);
  fireEvent.click(thread().querySelector("[data-earlier-more] button")!);
  await waitFor(() => expect(order()).toEqual(["more", "old-1", "old-2", "a", "b"]));
  fireEvent.click(thread().querySelector("[data-earlier-more] button")!);
  // The first turn is here: nothing more to read, and the page that overlapped added nothing twice.
  await waitFor(() => expect(order()).toEqual(["old-0", "old-1", "old-2", "a", "b"]));
});

test("reset waits for the answer at work; clearing still takes a second press", () => {
  setConversationState({ open: true, read: true, conversation: { ...empty, busy: true, turns: [{ ...answered("a", 1), status: "running", answer: null, answeredAt: null }] } });
  const fetcher = vi.fn(async (_url: string) => json(empty));
  vi.stubGlobal("fetch", fetcher);
  render(<TestWorkspace data={screenData(tree({ tasks: [dto()] }))}><CoordinatorContext /></TestWorkspace>);
  fireEvent.click(document.querySelector("[data-coordinator-context]")!);
  const button = document.querySelector<HTMLButtonElement>("[data-coordinator-reset]")!;
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain("返事の後にリセットできます");
  fireEvent.click(document.querySelector("[data-coordinator-clear]")!);
  expect(document.querySelector("[data-coordinator-clear]")?.textContent).toContain("もう一度で消去");
  expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith("/api/coordinator/clear"))).toHaveLength(0);
});
