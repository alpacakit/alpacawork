import { beforeEach as beforeSendCase } from 'vitest';
import { allowFixtureWrites } from './read-fixtures';
beforeSendCase(allowFixtureWrites);
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { Toaster } from "../src/components/ui/toaster";
import { notify, recordFailure, SHOWN, useToasts } from "../src/lib/notify";
import { SurfaceDocument } from "../src/lib/surface";
import { ApiError } from "../src/data/client";
import { clearCoordinator } from "../src/data/coordinator";
import { admitAttachmentRemoval, removeAttachment } from "../src/data/attachments";
import { describeProblem } from "../src/features/forms/problem-text";

/** The one owner of toasts — how long, how many, what replaces what, which window, and what a failure says. */
beforeAll(async () => { startI18n(); await i18n.changeLanguage("ja"); });
beforeEach(() => { vi.useFakeTimers(); useToasts.setState({ toasts: [], held: new Map(), covered: new Map(), hidden: new Set() }); });
afterEach(() => { cleanup(); act(() => useToasts.setState({ toasts: [], held: new Map(), covered: new Map(), hidden: new Set() })); vi.useRealTimers(); vi.restoreAllMocks(); });

/** What is shown, in the order it came (drawn newest first, at the top). */
const shown = () => [...document.querySelectorAll<HTMLElement>("[data-toast]")].map(toast => toast.textContent).reverse();

test("each kind that goes by itself stands its own time, a way back longer; a failure and a check stay until closed", () => {
  render(<Toaster />);
  act(() => { notify.success("コピーしました"); notify.error("取り消せませんでした"); });
  act(() => { notify.info("限度です", { action: { label: "開く", run: () => {} } }); });
  act(() => { notify.pending("保存中…", { id: "check" }); });
  act(() => vi.advanceTimersByTime(4100));
  expect(shown()).toEqual(["取り消せませんでした", "限度です開く", "保存中…"]);
  act(() => vi.advanceTimersByTime(4000));
  expect(shown()).toEqual(["取り消せませんでした", "保存中…"]);
  act(() => vi.advanceTimersByTime(600_000));
  expect(shown()).toEqual(["取り消せませんでした", "保存中…"]);
  fireEvent.click(screen.getAllByRole("button", { name: "通知を閉じる" })[1]!);
  expect(shown()).toEqual(["保存中…"]);
});

test("whether a toast stays is its kind's alone: a failure and a check stay, the rest go, whatever the caller passes", () => {
  render(<Toaster />);
  const drawn = () => [...document.querySelectorAll<HTMLElement>("[data-toast]")].reverse()
    .map(toast => [toast.dataset.kind, !!toast.dataset.stays, !!toast.querySelector("[data-toast-time]")]);
  for (const kinds of [["success", "error"], ["info", "pending"]] as const) {
    act(() => { for (const kind of kinds) notify[kind](`${kind} の知らせ`, { id: kind, ongoing: true, action: { label: "開く", run: () => {} } }); });
    expect(drawn().slice(-2)).toEqual([[kinds[0], false, true], [kinds[1], true, false]]);
    act(() => vi.advanceTimersByTime(600_000));
  }
  expect(shown()).toEqual(["error の知らせ開く", "pending の知らせ開く"]);
});

test("a toast that goes by itself shows the time it has left as a line that stops while pointed at or focused", () => {
  render(<Toaster />);
  act(() => { notify.success("保存しました"); });
  const line = () => document.querySelector<HTMLElement>("[data-toast-time]")!;
  const left = () => [Number(line().style.getPropertyValue("--time-left")), line().style.getPropertyValue("--time-left-ms"), line().hasAttribute("data-running")];
  expect(left()).toEqual([1, "4000ms", true]);
  act(() => vi.advanceTimersByTime(1000));
  // While it runs it is not drawn again: the line runs out by itself, at the clock's end.
  expect(left()).toEqual([1, "4000ms", true]);
  const list = document.querySelector("[data-toaster] ol")!;
  fireEvent.pointerOver(list);
  expect(left()).toEqual([0.75, "3000ms", false]);
  act(() => vi.advanceTimersByTime(30_000));
  expect(left()).toEqual([0.75, "3000ms", false]);
  fireEvent.pointerOut(list);
  expect(left()).toEqual([0.75, "3000ms", true]);
  act(() => vi.advanceTimersByTime(1500));
  // The keyboard stops it the same way.
  act(() => { notify.success("保存しました", { action: { label: "元に戻す", run: () => {} } }); });
  expect(left()).toEqual([1, "8000ms", true]);
  act(() => vi.advanceTimersByTime(2000));
  act(() => screen.getByRole("button", { name: "元に戻す" }).focus());
  expect(left()).toEqual([0.75, "6000ms", false]);
  act(() => (document.activeElement as HTMLElement).blur());
  expect(left()).toEqual([0.75, "6000ms", true]);
  act(() => vi.advanceTimersByTime(6100));
  expect(shown()).toEqual([]);
});

test("the same words again begin the line again with the clock, so it runs out as the toast goes", () => {
  render(<Toaster />);
  act(() => { notify.success("コピーしました"); });
  const line = () => document.querySelector<HTMLElement>("[data-toast-time]")!;
  const first = line();
  act(() => vi.advanceTimersByTime(2000));
  act(() => { notify.success("コピーしました"); });
  // A line of its own, from the whole, not the one before going on from where it was.
  expect(line()).not.toBe(first);
  expect([line().style.getPropertyValue("--time-left"), line().style.getPropertyValue("--time-left-ms"), line().hasAttribute("data-running")]).toEqual(["1", "4000ms", true]);
  act(() => vi.advanceTimersByTime(3900));
  expect(shown()).toEqual(["コピーしました"]);
  act(() => vi.advanceTimersByTime(200));
  expect(shown()).toEqual([]);
});

test("a hidden window stops the time a toast has left, and it goes on from there when the window is seen again", () => {
  render(<Toaster />);
  act(() => { notify.info("限度です"); });
  act(() => vi.advanceTimersByTime(3000));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  const line = document.querySelector<HTMLElement>("[data-toast-time]")!;
  expect([line.style.getPropertyValue("--time-left"), line.hasAttribute("data-running")]).toEqual(["0.5", false]);
  act(() => vi.advanceTimersByTime(60_000));
  expect(shown()).toEqual(["限度です"]);
  hidden.mockReturnValue(false);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  act(() => vi.advanceTimersByTime(3100));
  expect(shown()).toEqual([]);
});

test("pointing at or focusing a toast stops its clock, and it goes on from where it was when left", () => {
  render(<Toaster />);
  act(() => { notify.success("保存しました", { action: { label: "元に戻す", run: () => {} } }); });
  act(() => vi.advanceTimersByTime(7000));
  const toast = document.querySelector<HTMLElement>("[data-toaster] ol")!;
  fireEvent.pointerOver(toast);
  act(() => vi.advanceTimersByTime(30_000));
  expect(shown()).toEqual(["保存しました元に戻す"]);
  fireEvent.pointerOut(toast);
  act(() => vi.advanceTimersByTime(900));
  expect(shown()).toHaveLength(1);
  act(() => vi.advanceTimersByTime(200));
  expect(shown()).toEqual([]);
  // The keyboard holds it the same way.
  act(() => { notify.success("保存しました", { action: { label: "元に戻す", run: () => {} } }); });
  act(() => screen.getByRole("button", { name: "元に戻す" }).focus());
  act(() => vi.advanceTimersByTime(30_000));
  expect(shown()).toHaveLength(1);
});

test("a check replaced under the pointer lets its confirmation expire when the document points behind it", () => {
  render(<Toaster />);
  act(() => notify.error("確かめてください", { id: "recovery", action: { label: "確かめる", run: () => {} } }));
  const check = screen.getByRole("button", { name: "確かめる" });
  fireEvent.pointerOver(check);
  act(() => check.focus());
  act(() => notify.success("保存されていました", { id: "recovery" }));
  expect(check.isConnected).toBe(false);
  // The removed action cannot deliver its leave; the browser reports the newly exposed background instead.
  fireEvent.pointerOver(document.body);
  act(() => vi.advanceTimersByTime(4100));
  expect(shown()).toEqual([]);
});

test("the same words again replace the toast where it stands and restart it; different words stack, newest last", () => {
  render(<Toaster />);
  act(() => { notify.info("届きませんでした"); });
  act(() => vi.advanceTimersByTime(5000));
  act(() => { notify.info("届きませんでした"); notify.success("コピーしました"); });
  expect(shown()).toEqual(["届きませんでした", "コピーしました"]);
  expect(document.querySelector<HTMLElement>("[data-toast-time]")!.style.getPropertyValue("--time-left-ms")).toBe("4000ms");
  expect(document.querySelectorAll<HTMLElement>("[data-toast-time]")[1]!.style.getPropertyValue("--time-left-ms")).toBe("6000ms");
  act(() => vi.advanceTimersByTime(5000));
  expect(shown()).toEqual(["届きませんでした"]);
  // A check replaced in place by its result keeps its place and is read as the new kind.
  act(() => { notify.pending("保存中…", { id: "check" }); });
  expect(document.querySelector("[data-toast][data-kind=pending]")).toBeTruthy();
  act(() => { notify.success("保存されていました", { id: "check" }); });
  expect(document.querySelector("[data-toast][data-kind=pending]")).toBeNull();
  expect(screen.getByText("保存されていました").closest("[role=status]")).toBeTruthy();
});

test("past three in a window, what would go by itself goes first, and a way back that must not be missed never does", () => {
  render(<Toaster />);
  act(() => { notify.error("回答が保存されたか分かりません", { id: "recovery", action: { label: "確かめる", run: () => {} } }); });
  act(() => { for (const n of [1, 2, 3, 4, 5]) notify.success(`コピーしました ${n}`); });
  expect(shown()).toHaveLength(SHOWN);
  expect(shown()[0]).toContain("回答が保存されたか分かりません");
  expect(shown().slice(1)).toEqual(["コピーしました 4", "コピーしました 5"]);
  // A failure stays as well, beside the newest of the rest.
  act(() => { notify.error("取り消せませんでした"); notify.success("コピーしました 6"); });
  expect(shown().slice(1)).toEqual(["取り消せませんでした", "コピーしました 6"]);
  // A result-check notification can be hidden with Escape too; its action is not run.
  const recovery = document.querySelector<HTMLElement>('[data-toast-id="recovery"]')!;
  expect(recovery.querySelector("[aria-label='通知を閉じる']")).not.toBeNull();
  act(() => recovery.querySelector("button")!.focus());
  fireEvent.keyDown(recovery, { key: "Escape" });
  expect(shown().some(text => text?.includes("回答が保存されたか分かりません"))).toBe(false);
  // Escape still closes only the focused notification and goes no further.
  const behind = vi.fn();
  document.addEventListener("keydown", behind);
  const failure = [...document.querySelectorAll<HTMLElement>("[data-toast]")].find(toast => toast.textContent?.includes("取り消せませんでした"))!;
  act(() => failure.querySelector<HTMLElement>("button")!.focus());
  fireEvent.keyDown(failure.querySelector("button")!, { key: "Escape" });
  expect(shown().some(text => text?.includes("取り消せませんでした"))).toBe(false);
  expect(behind).not.toHaveBeenCalled();
  document.removeEventListener("keydown", behind);
});

test("a failure is read as an alert, the rest politely, and nothing takes the focus", () => {
  render(<><button>入力</button><Toaster /></>);
  const input = screen.getByRole("button", { name: "入力" }); input.focus();
  act(() => { notify.error("送れませんでした"); notify.success("コピーしました"); notify.info("限度です"); });
  expect(screen.getByRole("alert").textContent).toBe("送れませんでした");
  expect(screen.getAllByRole("status").map(each => each.textContent)).toEqual(["限度です", "コピーしました"]);
  expect(document.querySelector("[data-toaster]")?.getAttribute("aria-live")).toBe("off");
  expect(document.activeElement).toBe(input);
});

test("a toast is shown in the window its press was in; when that window goes, only what stays moves to the app's", () => {
  const own = document.implementation.createHTMLDocument("pip");
  render(<Toaster />);
  const pip = render(<SurfaceDocument value={own}><Toaster name="coordinator" /></SurfaceDocument>, { container: own.body });
  act(() => {
    notify.success("コピーしました", { from: own.body });
    notify.error("送れませんでした", { from: "coordinator" });
    notify.error("回答が保存されたか分かりません", { from: "coordinator" });
    notify.success("アーカイブしました");
  });
  expect(own.querySelectorAll("[data-toast]")).toHaveLength(3);
  expect(shown()).toEqual(["アーカイブしました"]);
  pip.unmount();
  expect(shown()).toEqual(["送れませんでした", "回答が保存されたか分かりません", "アーカイブしました"]);
  // With the coordinator back in the app's window, what it says is said there.
  act(() => { notify.info("限度です", { from: "coordinator" }); });
  expect(shown()).toContain("限度です");
});

test("a failure is said in the person's words: a refusal with serve's reason, a fault without its technical words", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  render(<Toaster />);
  act(() => { notify.failure(new ApiError("DIAGNOSTIC", "voice_too_large", "fix"), { about: "attach" }); });
  expect(screen.getByRole("alert").textContent).toBe("音声は16 MiBまでです");
  expect(warn).toHaveBeenCalledWith("[attach]", expect.any(ApiError));
  act(() => { notify.failure(new DOMException("signal timed out", "TimeoutError"), { about: "voice" }); });
  expect(document.body.textContent).not.toContain("signal timed out");
  expect(error).toHaveBeenCalledWith("[voice]", expect.any(DOMException));
  // No answer to a write: not said as failed, but as to be checked; to a read, as to be asked again.
  expect(describeProblem(new ApiError("x", "network_error", "check")).title).toBe("保存結果を確認してください。");
  expect(describeProblem(new ApiError(() => i18n.t("workspace.networkError"), "network_error", "later"))).toEqual(
    { title: "少し待ってからやり直してください。", detail: "", refusal: false });
  expect(describeProblem(new TypeError("Failed to fetch"))).toEqual({ title: i18n.t("problem.unexpected"), detail: "", refusal: false });
});

// Narrow too: sonner (the earlier toast library) is not drawn or depended on again. That no other toast is drawn is shown
// by the one Toaster's own tests, not by this.
test("sonner is not drawn or depended on again", () => {
  const src = join(__dirname, "../src");
  const files = (readdirSync(src, { recursive: true }) as string[]).filter(file => /\.tsx?$/.test(file));
  const drawing = files.filter(file => /from ["']sonner["']|data-sonner/.test(readFileSync(join(src, file), "utf8")));
  expect(drawing).toEqual([]);
  expect(JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")).dependencies.sonner).toBeUndefined();
});

test("every way back that stays is shown however many there are, with the newest of the rest beside them", () => {
  render(<Toaster />);
  act(() => { for (const n of [1, 2, 3, 4]) notify.error(`unknown${n} の結果を確認できません`, { id: `u${n}`, action: { label: "確かめる", run: () => {} } }); });
  act(() => { notify.success("コピーしました"); });
  expect(shown()).toEqual(["unknown1 の結果を確認できません確かめる", "unknown2 の結果を確認できません確かめる",
    "unknown3 の結果を確認できません確かめる", "unknown4 の結果を確認できません確かめる", "コピーしました"]);
});

test("what the person is on stays: a focused 元に戻す is not pushed out by newer toasts, nor timed out by a pointer passing over another", () => {
  render(<Toaster />);
  act(() => { notify.success("アーカイブしました", { action: { label: "元に戻す", run: () => {} } }); });
  act(() => screen.getByRole("button", { name: "元に戻す" }).focus());
  act(() => { for (const n of [1, 2, 3]) notify.success(`コピーしました ${n}`); });
  expect(screen.getByRole("button", { name: "元に戻す" })).toBe(document.activeElement);
  const list = document.querySelector("[data-toaster] ol")!;
  fireEvent.pointerOver(list); fireEvent.pointerOut(list);
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("button", { name: "元に戻す" })).toBe(document.activeElement);
  // Let go, what is over the room goes, and the rest goes in its time.
  act(() => (document.activeElement as HTMLElement).blur());
  expect(shown()).toHaveLength(3);
  act(() => vi.advanceTimersByTime(9000));
  expect(shown()).toEqual([]);
});

test("a lost answer is said as unknown even where the caller names the failure; a refusal and a fault take the caller's words", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<Toaster />);
  act(() => { notify.failure(new ApiError(() => i18n.t("workspace.networkError"), "network_error", "check"), { about: "withdraw", text: "取り消せませんでした。もう送り始めています。" }); });
  expect(screen.getByRole("alert").textContent).toBe("保存結果を確認してください。");
  act(() => useToasts.setState({ toasts: [] }));
  act(() => { notify.failure(new ApiError("already running", "conflict", "reread"), { about: "withdraw", text: "取り消せませんでした。もう送り始めています。" }); });
  expect(screen.getByRole("alert").textContent).toContain("取り消せませんでした。もう送り始めています。");
});

test("no answer keeps its cause at every boundary that says it, for the record", async () => {
  const lost = new TypeError("source failure");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(lost)));
  await expect(clearCoordinator("c1")).rejects.toMatchObject({ code: "network_error", retry: "check", cause: lost });
  const destination = { kind: "coordinator", conversationId: "c1" } as const;
  await expect(removeAttachment(destination, "r1", "a.png", admitAttachmentRemoval(destination))).rejects.toMatchObject({ code: "network_error", cause: lost });
  vi.unstubAllGlobals();
});

test("while a dialog is open, what stayed from before waits (kept); what goes by itself and what comes meanwhile stand over it", () => {
  render(<Toaster />);
  act(() => { notify.error("unknown の結果を確認できません", { id: "u", action: { label: "確かめる", run: () => {} } }); });
  let uncover = () => {}, inner = () => {};
  act(() => { uncover = notify.cover(document); });
  expect(shown()).toEqual([]);
  act(() => { notify.info("限度です"); });
  expect(shown()).toEqual(["限度です"]);
  act(() => vi.advanceTimersByTime(60_000));
  // A failure of what is done in the dialog is said over it, and stays; a dialog over that one does not send it away.
  act(() => { notify.error("保存できませんでした"); });
  act(() => { inner = notify.cover(document); });
  expect(shown()).toEqual(["保存できませんでした"]);
  act(() => inner());
  act(() => uncover());
  expect(shown()).toEqual(["unknown の結果を確認できません確かめる", "保存できませんでした"]);
});

test("the same failure again while a dialog is open is a new one, said over it; an owner's ongoing event is not", () => {
  render(<Toaster />);
  act(() => {
    notify.error("コピーできません");
    notify.error("読み直せませんでした", { id: "reload", ongoing: true });
  });
  let uncover = () => {};
  act(() => { uncover = notify.cover(document); });
  expect(shown()).toEqual([]);
  act(() => {
    notify.error("コピーできません");
    notify.error("読み直せませんでした", { id: "reload", ongoing: true });
  });
  expect(shown()).toEqual(["コピーできません"]);
  act(() => uncover());
  expect(shown()).toEqual(["コピーできません", "読み直せませんでした"]);
});

test("what was not shown when a hold began does not come in while it lasts, though it comes again under a dialog", () => {
  render(<Toaster />);
  act(() => {
    notify.success("アーカイブしました", { action: { label: "元に戻す", run: () => {} } });
    notify.error("確かめられません", { action: { label: "確かめる", run: () => {} } });
  });
  let uncover = () => {};
  act(() => { uncover = notify.cover(document); });
  expect(shown()).toEqual(["アーカイブしました元に戻す"]);
  const undo = screen.getByRole("button", { name: "元に戻す" });
  fireEvent.pointerOver(undo);
  // The same failure again is new, and may stand over the dialog, but not while the toast under the pointer is held.
  act(() => { notify.error("確かめられません", { action: { label: "確かめる", run: () => {} } }); });
  expect(shown()).toEqual(["アーカイブしました元に戻す"]);
  expect(screen.queryByRole("button", { name: "確かめる" })).toBeNull();
  fireEvent.pointerOut(undo);
  expect(shown()).toEqual(["アーカイブしました元に戻す", "確かめられません確かめる"]);
  act(() => uncover());
});

test("a toast closed while held is no longer kept by the hold, so the same slot again waits to come in", () => {
  render(<Toaster />);
  act(() => {
    notify.success("アーカイブしました", { action: { label: "元に戻す", run: () => {} } });
    notify.error("確かめられません", { id: "check", action: { label: "確かめる", run: () => {} } });
  });
  const failure = document.querySelector<HTMLElement>('[data-toast-id="check"]')!;
  fireEvent.pointerOver(failure);
  fireEvent.click(failure.querySelector<HTMLElement>("[aria-label='通知を閉じる']")!);
  expect(shown()).toEqual(["アーカイブしました元に戻す"]);
  const undo = screen.getByRole("button", { name: "元に戻す" });
  fireEvent.pointerOver(undo);
  act(() => { notify.error("確かめられません", { id: "check", action: { label: "確かめる", run: () => {} } }); });
  expect(shown()).toEqual(["アーカイブしました元に戻す"]);
  fireEvent.pointerOut(undo);
  expect(shown()).toEqual(["アーカイブしました元に戻す", "確かめられません確かめる"]);
});

test("what goes by itself stands as long as its drawn words take to read: a second and 100ms a character, at least its kind's", () => {
  render(<Toaster />);
  const life = () => document.querySelector<HTMLElement>("[data-toast-time]")!.style.getPropertyValue("--time-left-ms");
  // Short: its kind's least (a success 4s, a notice 6s, a way back 8s).
  act(() => { notify.success("コピーしました"); });
  expect(life()).toBe("4000ms");
  act(() => useToasts.setState({ toasts: [], time: new Map() }));
  // Long: words drawn from elements (a title in its own span) and the detail count; the buttons do not.
  const title = "とても長いタスクの題名がここに入ります".repeat(4);
  act(() => { notify.success(<><span data-recovery-title>「{title}」</span>に送りました</>, { detail: "詳しく", action: { label: "元に戻す", run: () => {} } }); });
  const chars = `「${title}」に送りました詳しく`.length;
  expect(life()).toBe(`${1000 + chars * 100}ms`);
  act(() => vi.advanceTimersByTime(1000 + chars * 100 - 100));
  expect(shown()).toHaveLength(1);
  act(() => vi.advanceTimersByTime(200));
  expect(shown()).toEqual([]);
  // And never more than 15s.
  act(() => { notify.info("あ".repeat(400)); });
  expect(life()).toBe("15000ms");
});

test("what its owner keeps stands until its owner ends it, under a dialog and a hold too, and its line runs out at its owner's time", () => {
  vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
  const now = Date.now();
  render(<Toaster />);
  act(() => { notify.success("コピーしました"); });
  const list = document.querySelector("[data-toaster] ol")!;
  fireEvent.pointerOver(list);
  let uncover = () => {};
  act(() => { uncover = notify.cover(document); });
  // Pointed at and under a dialog, an offer still comes in, under what is there.
  act(() => { notify.success("T1 を保留にしました", { id: "undo:1", ongoing: true, kept: true, line: { at: now, until: now + 5000 },
    action: { label: "取り消す", run: () => {} } }); });
  expect(shown()).toEqual(["T1 を保留にしました取り消す", "コピーしました"]);
  const line = () => document.querySelector<HTMLElement>('[data-toast-id="undo:1"] [data-toast-time]')!;
  const first = line();
  // Its line runs while held: its owner's time is not stopped here.
  expect([first.style.getPropertyValue("--time-left"), first.style.getPropertyValue("--time-left-ms"), first.hasAttribute("data-running")]).toEqual(["1", "5000ms", true]);
  act(() => { vi.advanceTimersByTime(2000); });
  // Republished with the same time (its count changed), the same line goes on; with a new time, a new line.
  act(() => { notify.success("T1 を保留にしました", { id: "undo:1", ongoing: true, kept: true, line: { at: now, until: now + 5000 }, detail: "ほかに 1 件" }); });
  expect(line()).toBe(first);
  act(() => { notify.success("T2 を保留にしました", { id: "undo:1", ongoing: true, kept: true, line: { at: now + 2000, until: now + 7000 } }); });
  expect(line()).not.toBe(first);
  expect(line().style.getPropertyValue("--time-left-ms")).toBe("5000ms");
  fireEvent.pointerOut(list);
  act(() => uncover());
  // Nothing here takes it away, nor crowds it out.
  act(() => { for (const n of [1, 2, 3, 4]) notify.success(`コピーしました ${n}`); });
  act(() => vi.advanceTimersByTime(60_000));
  expect(shown()).toEqual(["T2 を保留にしました"]);
  act(() => notify.dismiss("undo:1"));
  expect(shown()).toEqual([]);
});

test("a failure passed on from one place to the next is recorded once, by the first", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fault = new TypeError("x");
  recordFailure(fault, "report approve"); recordFailure(fault, "form save");
  notify.failure(fault, { about: "again" });
  expect(error.mock.calls).toEqual([["[report approve]", fault]]);
});

test("a failure wrapped as another's cause is the same failure, recorded once", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fault = new TypeError("unreadable answer");
  const wrapped = Object.assign(new Error("Cannot confirm"), { cause: fault });
  recordFailure(fault, "coordinator send"); recordFailure(wrapped, "reader send");
  const other = new TypeError("other"), outer = Object.assign(new Error("outer"), { cause: other });
  recordFailure(outer, "first"); recordFailure(other, "second");
  expect(error.mock.calls).toEqual([["[coordinator send]", fault], ["[first]", outer]]);
});

test("a dialog opened while the toasts are pointed at still sends what stays to wait", () => {
  render(<Toaster />);
  act(() => { notify.error("unknown の結果を確認できません", { id: "u", action: { label: "確かめる", run: () => {} } }); });
  act(() => notify.hold(document, true));
  act(() => { notify.cover(document); });
  expect(shown()).toEqual([]);
});

test("what comes while a toast is pointed at waits to come in until it is let go, so the one under the pointer stays put", () => {
  render(<Toaster />);
  act(() => { notify.error("u1 の結果を確認できません", { id: "u1", action: { label: "確かめる", run: () => {} } }); });
  const list = document.querySelector("[data-toaster] ol")!;
  fireEvent.pointerOver(list);
  act(() => { notify.error("u2 の結果を確認できません", { id: "u2", action: { label: "確かめる", run: () => {} } }); notify.success("コピーしました"); });
  expect(shown()).toEqual(["u1 の結果を確認できません確かめる"]);
  fireEvent.pointerOut(list);
  expect(shown()).toEqual(["u1 の結果を確認できません確かめる", "u2 の結果を確認できません確かめる", "コピーしました"]);
});

// What this guards is narrow: no console call and no alert of a file's own is added. It does not show that every
// failure reaches recordFailure or a shared part (a catch can still drop one): each path's own tests show that.
test("no console and no alert of a file's own besides the shared parts", () => {
  const src = join(__dirname, "../src");
  const files = (readdirSync(src, { recursive: true }) as string[]).filter(file => /\.tsx?$/.test(file));
  const read = (file: string) => readFileSync(join(src, file), "utf8");
  // A failure is recorded by recordFailure (lib/notify.ts) and nowhere else.
  expect(files.filter(file => file !== "lib/notify.ts" && /console\.(warn|error)\(/.test(read(file)))).toEqual([]);
  // What is said in place takes one of the shared parts: FieldError (by an input), Message (components/ui/message.tsx:
  // a failure, a caution, an empty place, its role chosen by its tone), the toasts. The conversation's own records of a
  // message's outcome are the only other alerts.
  const alerts = files.filter(file => /role="alert"/.test(read(file))).sort();
  expect(alerts).toEqual(["components/ui/field.tsx", "features/coordinator/CoordinatorThread.tsx", "features/coordinator/LocalOutcome.tsx"]);
});

for (const kind of ['success', 'error', 'info', 'pending'] as const) test(`${kind} hides only its ongoing event, releases it on completion, and permits a new one`, () => {
  render(<Toaster />);
  const run = vi.fn(), id = `hide-${kind}`;
  act(() => notify[kind]('Hide just this event', { id, ongoing: true, action: { label: 'Check', run } }));
  fireEvent.click(screen.getByRole('button', { name: '通知を閉じる' }));
  expect(shown()).toEqual([]);
  expect(run).not.toHaveBeenCalled();
  act(() => {
    notify.suspend(id);
    expect(notify[kind]('Same event republished', { id, ongoing: true })).toBeUndefined();
  });
  expect(useToasts.getState().hidden).toEqual(new Set([id]));
  act(() => notify.success('Final result of the hidden event', { id }));
  expect(shown()).toEqual([]);
  expect(useToasts.getState().hidden.size).toBe(0);
  act(() => notify.info('A new event in the same slot', { id }));
  expect(shown()).toEqual(['A new event in the same slot']);
});

for (const kind of ['success', 'error', 'info', 'pending'] as const) test(`${kind}: one-off notices may repeat after hiding, with no retained IDs`, () => {
  const id = 'fixed-slot';
  for (let n = 0; n < 1000; n++) {
    notify[kind]('Same words, a different event', { id });
    expect(useToasts.getState().toasts).toHaveLength(1);
    notify.hide(id);
  }
  expect(useToasts.getState().hidden.size).toBe(0);
  expect(useToasts.getState().toasts).toEqual([]);
});

test('ending an owner-held event releases its hidden ID even when its card was removed', () => {
  for (let n = 0; n < 1000; n++) {
    const id = `operation-${n}`;
    notify.error('Unknown result', { id, ongoing: true });
    notify.hide(id);
    expect(useToasts.getState().hidden.has(id)).toBe(true);
    notify.dismiss(id);
  }
  expect(useToasts.getState().hidden.size).toBe(0);
  notify.error('A new event', { id: 'operation-0', ongoing: true });
  expect(useToasts.getState().toasts).toHaveLength(1);
});


test("connection loss has no read toast; server failures retain their own outcome", () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  render(<Toaster />);
  act(() => { notify.failure(new ApiError("service refused", "read_failed", "later"),
    { id: "personal-read", about: "read", text: "Reload failed" }); });
  expect(screen.getByRole("alert").textContent).toContain("Reload failed");
  const network = new ApiError("connection failed", "network_error", "later");
  act(() => { notify.failure(network, { id: "personal-read", about: "read", text: "Reload failed" }); });
  expect(document.querySelector("[data-toast]")).toBeNull();
  expect(errorLog).toHaveBeenCalled();
  act(() => { notify.failure(network, { about: "same read" }); });
  expect(document.querySelector("[data-toast]")).toBeNull();
  for (const code of ["forbidden", "invalid_response", "http_error"]) {
    act(() => { notify.failure(new ApiError("server replied", code, "later"),
      { id: "personal-read", about: "read", text: "Reload failed" }); });
    expect(screen.getByRole("alert").textContent).toContain("Reload failed");
  }
});
