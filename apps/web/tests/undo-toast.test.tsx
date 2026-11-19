import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { Toaster } from "../src/components/ui/toaster";
import { notify, useToasts } from "../src/lib/notify";
import { SurfaceDocument } from "../src/lib/surface";
import { endUndoOffer, offerUndo, useUndoOffers, type UndoOffer } from "../src/data/undo-offers";
import { frameOf, SAID_FOR, watchUndoOffers } from "../src/features/undo/undo-toast";

/** One undo frame a window, drawn from the offers; it shows, and never ends, what the delivery owner holds. */
beforeAll(async () => { startI18n(); await i18n.changeLanguage("ja"); });
const empty = () => ({ toasts: [], held: new Map(), covered: new Map(), time: new Map(), hidden: new Set<string>() });
// The page starts the frames for its life (main.tsx); each case does the same, and stops them after.
let stop: () => void;
beforeEach(() => { vi.useFakeTimers({ now: 1_000_000 }); useToasts.setState(empty()); useUndoOffers.setState({ offers: [] }); stop = watchUndoOffers(); });
afterEach(() => {
  act(() => useUndoOffers.setState({ offers: [] }));
  act(() => stop());
  cleanup();
  act(() => useToasts.setState(empty()));
  vi.useRealTimers(); vi.restoreAllMocks();
});

let next = 0;
function offer(text: string, more: Partial<UndoOffer> = {}): UndoOffer {
  const at = Date.now();
  return { id: `op-${++next}`, text, mark: "success", at, until: at + 5000, undo: vi.fn(async () => "cancelled" as const), ...more };
}
/** Each card's words, its second line, and whether it has the way back, drawn newest first. */
const cards = (at: Document = document) => [...at.querySelectorAll<HTMLElement>("[data-toast]")].map(card =>
  [card.querySelector("[data-toast-text]")!.textContent, card.querySelector("[data-toast-text] + p")?.textContent ?? "", !!card.querySelector("[data-toast-action]")]);
const list = () => document.querySelector<HTMLElement>("[data-toaster] ol")!;
const press = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "取り消す" })); }); };

test("the frame's one rule: the newest offer and how many more; held, it keeps what it shows", () => {
  const [a, b, c] = [offer("A"), offer("B"), offer("C")], now = Date.now();
  expect(frameOf([], false, {}, now)).toBeNull();
  expect(frameOf([a, b, c], false, {}, now)).toEqual({ offer: c, open: true, others: 2 });
  // Held: what was shown stays, a newer one only counts; its time ending there takes only its button.
  expect(frameOf([a, b, c, offer("D")], true, { shown: c }, now)).toMatchObject({ offer: c, open: true, others: 3 });
  expect(frameOf([a, b], true, { shown: c }, now)).toEqual({ offer: c, open: false, others: 2 });
  // A press under way: no button at all, whichever offer is shown.
  expect(frameOf([a, b], false, { pressing: c.id }, now)).toEqual({ offer: b, open: false, others: 1 });
  // What a press came to stands while held and for SAID_FOR, then the rule above shows the newest.
  const said = { text: "取り消しました", kind: "success" as const, until: now + SAID_FOR };
  expect(frameOf([a, b], true, { shown: c, said }, now + 60_000)).toEqual({ said, others: 2 });
  expect(frameOf([a, b], false, { said }, now)).toEqual({ said, others: 2 });
  expect(frameOf([a, b], false, { said }, now + SAID_FOR)).toEqual({ offer: b, open: true, others: 1 });
});

test("one frame a window: the newest offer in one line, how many more, and a line that runs out at its time", () => {
  render(<Toaster />);
  act(() => { offerUndo(offer("T416 を保留にしました")); });
  expect(cards()).toEqual([["T416 を保留にしました", "", true]]);
  expect(document.querySelector<HTMLElement>("[data-toast]")!.dataset.kind).toBe("success");
  // The toast's time line, run by the offer's own time: it runs while the frame is pointed at too.
  const line = () => document.querySelector<HTMLElement>("[data-toast-time]")!;
  expect(line().style.getPropertyValue("--time-left")).toBe("1");
  expect(line().style.getPropertyValue("--time-left-ms")).toBe("5000ms");
  fireEvent.pointerOver(list());
  expect(line().dataset.running).toBe("true");
  fireEvent.pointerOut(list());
  act(() => { offerUndo(offer("送信しました", { mark: "info" })); offerUndo(offer("T418 を完了にしました")); });
  expect(cards()).toEqual([["T418 を完了にしました", "ほかに取り消せる操作 2 件", true]]);
  // No reading time or "three at once" takes it away while its offers last, nor keeps it once they end.
  act(() => { notify.success("コピーしました"); notify.info("限度です"); notify.success("保存しました"); notify.error("送れませんでした"); });
  act(() => vi.advanceTimersByTime(60_000));
  expect(cards()).toEqual([["送れませんでした", "", false], ["T418 を完了にしました", "ほかに取り消せる操作 2 件", true]]);
  act(() => { for (const each of useUndoOffers.getState().offers) endUndoOffer(each.id); });
  expect(cards()).toEqual([["送れませんでした", "", false]]);
});

test("a send not yet gone takes the info mark; the button presses the offer shown", async () => {
  render(<Toaster />);
  const first = offer("T416 を保留にしました"), sent = offer("送信しました", { mark: "info" });
  act(() => { offerUndo(first); offerUndo(sent); });
  expect(document.querySelector<HTMLElement>("[data-toast]")!.dataset.kind).toBe("info");
  await press();
  expect(sent.undo).toHaveBeenCalledTimes(1);
  expect(first.undo).not.toHaveBeenCalled();
});

test("held: a new offer comes in at once and only counts; a press is said in place and nothing comes next until let go", async () => {
  render(<Toaster />);
  const shown = offer("T418 を完了にしました", { undone: "完了を取り消しました" });
  act(() => { offerUndo(offer("T416 を保留にしました")); offerUndo(shown); });
  fireEvent.pointerOver(list());
  act(() => { offerUndo(offer("送信しました", { mark: "info" })); });
  expect(cards()).toEqual([["T418 を完了にしました", "ほかに取り消せる操作 2 件", true]]);
  await press();
  expect(cards()).toEqual([["完了を取り消しました", "", false]]);
  act(() => endUndoOffer(shown.id));
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.queryByRole("button", { name: "取り消す" })).toBeNull();
  fireEvent.pointerOut(list());
  expect(cards()).toEqual([["送信しました", "ほかに取り消せる操作 1 件", true]]);
});

test("a finger or a key lets go before its press is answered: what it came to still stands SAID_FOR before the next", async () => {
  render(<Toaster />);
  act(() => { offerUndo(offer("T416 を保留にしました")); offerUndo(offer("T418 を完了にしました")); });
  act(() => screen.getByRole("button", { name: "取り消す" }).focus());
  act(() => { offerUndo(offer("送信しました", { mark: "info" })); });
  expect(cards()).toEqual([["T418 を完了にしました", "ほかに取り消せる操作 2 件", true]]);
  await press();
  // The button went with the focus on it, which lets the window go.
  expect(document.activeElement).toBe(document.body);
  expect(cards()).toEqual([["取り消しました", "", false]]);
  act(() => vi.advanceTimersByTime(SAID_FOR - 1));
  expect(cards()).toEqual([["取り消しました", "", false]]);
  act(() => vi.advanceTimersByTime(1));
  expect(cards()).toEqual([["送信しました", "ほかに取り消せる操作 1 件", true]]);
});

test("while a press is under way no button shows, even for the next offer", async () => {
  render(<Toaster />);
  let answer!: (result: "cancelled") => void;
  const pressed = offer("T418 を完了にしました", { undo: vi.fn(() => new Promise<"cancelled">(resolve => { answer = resolve; })) });
  act(() => { offerUndo(offer("T416 を保留にしました")); offerUndo(pressed); });
  await press();
  act(() => endUndoOffer(pressed.id));
  expect(cards()).toEqual([["T416 を保留にしました", "", false]]);
  await act(async () => answer("cancelled"));
  expect(cards()).toEqual([["取り消しました", "", false]]);
});

test("held: the shown offer's time ending takes only its button; let go, the frame shows the newest or goes", () => {
  render(<Toaster />);
  const [older, shown] = [offer("T416 を保留にしました"), offer("T418 を完了にしました")];
  act(() => { offerUndo(older); offerUndo(shown); });
  fireEvent.pointerOver(list());
  act(() => endUndoOffer(shown.id));
  expect(cards()).toEqual([["T418 を完了にしました", "ほかに取り消せる操作 1 件", false]]);
  expect(document.querySelector("[data-toast-time]")).toBeNull();
  act(() => endUndoOffer(older.id));
  expect(cards()).toEqual([["T418 を完了にしました", "", false]]);
  fireEvent.pointerOut(list());
  expect(cards()).toEqual([]);
});

test("a press that comes too late is said as sent; the last one taken back is said as a notice of its own", async () => {
  render(<Toaster />);
  const late = offer("送信しました", { mark: "info", undo: vi.fn(async () => "already_dispatched" as const) });
  act(() => { offerUndo(late); });
  await press();
  expect(cards()).toEqual([["すでに送ったため、取り消せませんでした", "", false]]);
  act(() => vi.advanceTimersByTime(SAID_FOR));
  expect(cards()).toEqual([["すでに送ったため、取り消せませんでした", "", false]]);
  // A later offer opens a frame of its own; the notice reads on under it.
  act(() => { offerUndo(offer("T416 を保留にしました")); });
  expect(cards()).toEqual([["T416 を保留にしました", "", true], ["すでに送ったため、取り消せませんでした", "", false]]);
  act(() => endUndoOffer(late.id));
  act(() => vi.advanceTimersByTime(10_000));
  expect(cards()).toEqual([["T416 を保留にしました", "", true]]);
});

test("an undo that fails says so and keeps the button", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<Toaster />);
  act(() => { offerUndo(offer("T416 を保留にしました", { undo: vi.fn(async () => { throw new Error("broken"); }) })); });
  await press();
  expect(cards()).toEqual([["取り消せませんでした", "", false], ["T416 を保留にしました", "", true]]);
});

test("closing (×, Escape, a swipe) only puts the frame away: nothing is taken back or sent, and a later offer opens it again", () => {
  render(<Toaster />);
  const [a, b] = [offer("T416 を保留にしました"), offer("T418 を完了にしました")];
  act(() => { offerUndo(a); offerUndo(b); });
  fireEvent.click(screen.getByRole("button", { name: "通知を閉じる" }));
  expect(cards()).toEqual([]);
  expect(useUndoOffers.getState().offers.map(each => each.id)).toEqual([a.id, b.id]);
  expect(a.undo).not.toHaveBeenCalled();
  expect(b.undo).not.toHaveBeenCalled();
  act(() => { offerUndo(offer("送信しました", { mark: "info" })); });
  expect(cards()).toEqual([["送信しました", "", true]]);
  act(() => { endUndoOffer(a.id); endUndoOffer(b.id); });
  expect(cards()).toEqual([["送信しました", "", true]]);
});

test("a dialog over the window does not hold the frame back", () => {
  render(<Toaster />);
  const uncover = notify.cover(document);
  act(() => { offerUndo(offer("T416 を保留にしました")); });
  expect(cards()).toEqual([["T416 を保留にしました", "", true]]);
  act(uncover);
});

test("each window draws the frame of the offers pressed in it", () => {
  const own = document.implementation.createHTMLDocument("pip");
  render(<Toaster />);
  const pip = render(<SurfaceDocument value={own}><Toaster name="coordinator" /></SurfaceDocument>, { container: own.body });
  act(() => {
    offerUndo(offer("T416 を保留にしました"));
    offerUndo(offer("送信しました", { mark: "info", from: "coordinator" }));
    offerUndo(offer("もう一つ送信しました", { mark: "info", from: own.body }));
  });
  expect(cards()).toEqual([["T416 を保留にしました", "", true]]);
  expect(cards(own)).toEqual([["もう一つ送信しました", "ほかに取り消せる操作 1 件", true]]);
  // When that window goes, its offers join the app's frame.
  pip.unmount();
  expect(cards()).toEqual([["もう一つ送信しました", "ほかに取り消せる操作 2 件", true]]);
});

test("a frame that comes while another toast is held comes in at once, under it, so nothing under the pointer moves", () => {
  render(<Toaster />);
  act(() => { notify.error("確かめてください", {}); });
  fireEvent.pointerOver(list());
  act(() => { offerUndo(offer("T416 を保留にしました")); });
  expect(cards()).toEqual([["確かめてください", "", false], ["T416 を保留にしました", "", true]]);
});

test("stopped, the frames go, and nothing more is drawn", () => {
  render(<Toaster />);
  act(() => { offerUndo(offer("T416 を保留にしました")); });
  expect(useToasts.getState().toasts.map(toast => toast.kept)).toEqual([true]);
  act(() => stop());
  expect(useToasts.getState().toasts).toEqual([]);
  act(() => { offerUndo(offer("T418 を完了にしました")); });
  expect(useToasts.getState().toasts).toEqual([]);
  stop = watchUndoOffers();
});
