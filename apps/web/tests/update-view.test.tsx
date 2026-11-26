// The update's places draw the one projection and send only the person's intent: one short confirmation naming the
// skills it overwrites, three kinds of stopped work, and the setting changed only from the dialog.
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { activateLocale, startI18n } from "@alpacawork/i18n";

const state = vi.hoisted(() => ({ status: { kind: "none" } as import("../src/features/update/update-state").UpdateStatus }));
vi.mock("../src/features/update/update-state", async (original) => {
  const real = await original<typeof import("../src/features/update/update-state")>();
  return { ...real, useUpdateStatus: () => state.status, pressUpdate: vi.fn(), retryUpdate: vi.fn(), continueUpdate: vi.fn(),
    approveStart: vi.fn(), postponeUpdate: vi.fn() };
});
import { approveStart, continueUpdate, postponeUpdate, pressUpdate, retryUpdate, useUpdateLocal, type Confirmation, type UpdateStatus } from "../src/features/update/update-state";
import { UpdateCard, UpdateConfirmDialog, UpdateMark, VersionLine, useGearLabel } from "../src/features/update/UpdateView";
import { APP_VERSION } from "../src/lib/app-version";

const available = (extra: Partial<Extract<UpdateStatus, { kind: "available" }>> = {}): UpdateStatus =>
  ({ kind: "available", candidateId: "c1", version: "0.10.0", runs: 0, requiresNoRuns: false, changes: null, note: null, ...extra });
const opId = "4f9c2c1e-8a8b-4a43-9a4d-6f1d2f0b9c11";
beforeAll(async () => { startI18n(); await activateLocale("ja"); });
beforeEach(() => { useUpdateLocal.setState({ confirm: null, sending: false }); vi.clearAllMocks(); });
const d = (c: string) => c.repeat(64);
const start = (extra: object = {}): Confirmation => ({ at: { root: "/fixture", boundary: undefined }, candidateId: "c1", version: "0.10.0", runs: 0,
  requiresNoRuns: false, changes: null, skills: ["alpacawork"], reviewDigest: d("a"), ...extra });
const open = (confirmation: Confirmation) => act(() => useUpdateLocal.setState({ confirm: confirmation }));
afterEach(cleanup);
function Gear() { return <span data-gear>{useGearLabel()}</span>; }
const Places = () => <><UpdateMark /><UpdateCard /><UpdateConfirmDialog /><VersionLine /></>;

test("nothing to start: no mark, the card says this is the latest with nothing to press; the version stays at the foot", () => {
  state.status = { kind: "none" };
  const { container } = render(<Places />);
  expect(container.querySelector("[data-update-mark]")).toBeNull();
  expect(container.querySelector("[data-update-action]")).toBeNull();
  expect(container.querySelector("[data-update-state]")?.textContent).toContain("最新の版です");
  expect(container.querySelector("[data-version-line]")?.textContent).toBe(`alpacawork ${APP_VERSION}`);
});

test("a version to start: the ↓ mark, a line naming it beside the running one with its notes, and Update, whose press goes to the review first", () => {
  state.status = available({ runs: 2 });
  const { container } = render(<><Places /><Gear /></>);
  expect(container.querySelector("[data-update-mark]")?.getAttribute("data-update-mark")).toBe("available");
  expect(container.querySelector("[data-gear]")?.textContent).toBe("設定 — 0.10.0 があります");
  expect(container.querySelector("[data-update-state]")?.textContent).toContain("新しい版があります");
  expect(container.querySelector("[data-update-state]")?.textContent).toContain(`alpacawork ${APP_VERSION}0.10.0`);
  expect(container.querySelector("[data-update-notes]")?.getAttribute("href")).toBe("https://github.com/alpacakit/alpacawork/releases/tag/v0.10.0");
  fireEvent.click(screen.getByRole("button", { name: "アップデート" }));
  expect(pressUpdate).toHaveBeenCalledWith(state.status);
});

test("a version refused while agents work says so before any press, offers the coordinator's pause instruction to copy instead of Update until none works, and its confirmation says why", async () => {
  state.status = available({ runs: 2, requiresNoRuns: true });
  let copied = "";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  const first = render(<Places />);
  expect(first.container.querySelector("[data-update-state]")?.textContent).toContain("作業中のエージェント（2件）");
  expect(first.container.querySelector("[data-update-action]")).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "止める指示をコピー" })); });
  expect(copied).toMatch(/0\.10\.0 に更新します.*保留にして.*今の作業を終えるまで待つ/);
  first.unmount();
  state.status = available({ runs: 0, requiresNoRuns: true });
  render(<Places />);
  expect(screen.queryByRole("button", { name: "止める指示をコピー" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "アップデート" }));
  expect(pressUpdate).toHaveBeenCalledWith(state.status);
  open(start({ requiresNoRuns: true }));
  expect(document.querySelector("[data-update-body]")?.textContent).toContain("作業中のエージェントがいないときだけできます");
});

test("Cancel sends nothing and changes no setting", () => {
  state.status = available();
  render(<Places />);
  open(start());
  fireEvent.click(screen.getByRole("checkbox", { name: "次回もこの確認を表示する" }));
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  expect(document.querySelector("[data-update-confirm]")).toBeNull();
  expect(useUpdateLocal.getState().confirm).toBeNull();
  expect(approveStart).not.toHaveBeenCalled();
});

test("waiting for Runs: the ring mark, one phrase and Postpone, which cancels that operation", () => {
  state.status = { kind: "waiting", opId, version: "0.10.0", runs: 2 };
  const { container } = render(<Places />);
  expect(container.querySelector("[data-update-mark]")?.getAttribute("data-update-mark")).toBe("busy");
  expect(container.querySelector("[data-update-state]")?.textContent).toContain("エージェントの作業が終わるのを待っています");
  fireEvent.click(screen.getByRole("button", { name: "延期する" }));
  expect(postponeUpdate).toHaveBeenCalledWith(opId);
});

test("offered again after a withdrawn version: the line says which was withdrawn before the version offered now", () => {
  state.status = available({ version: "0.10.1", note: { kind: "withdrawn", version: "0.10.0" } });
  const { container } = render(<Places />);
  expect(container.querySelector("[data-update-state]")?.textContent).toMatch(/新しい版があります.*0\.10\.1.*0\.10\.0 は取り下げられました/);
  expect(screen.getByRole("button", { name: "アップデート" })).toBeTruthy();
});

test("withdrawn with nothing else: no mark, no action; done offers Reload", () => {
  state.status = { kind: "withdrawn", version: "0.10.0" };
  const first = render(<Places />);
  expect(first.container.querySelector("[data-update-mark]")).toBeNull();
  expect(first.container.querySelector("[data-update-action]")).toBeNull();
  first.unmount();
  state.status = { kind: "done", version: "0.10.0" };
  render(<Places />);
  expect(screen.getByRole("button", { name: "再読み込み" })).toBeTruthy();
});

test("an edit cancelled in one confirmation is gone at the next: it opens checked again", () => {
  state.status = available();
  render(<Places />);
  open(start());
  fireEvent.click(screen.getByRole("checkbox", { name: "次回もこの確認を表示する" }));
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  open(start());
  expect((screen.getByRole("checkbox", { name: "次回もこの確認を表示する" }) as HTMLInputElement).checked).toBe(true);
});

test("done keeps a mark on the gear until the page is loaded again, and its name says to reload", () => {
  state.status = { kind: "done", version: "0.10.0" };
  const { container } = render(<Places />);
  expect(container.querySelector("[data-update-mark]")?.getAttribute("data-update-mark")).toBe("done");
});

test("applying and recovering: the ring mark, one phrase and nothing to press", () => {
  for (const [kind, words] of [["applying", "新しい版に切り替えています…"], ["recovering", "切り替えを元に戻しています…"]] as const) {
    state.status = { kind, opId, version: "0.10.0" };
    const { container, unmount } = render(<Places />);
    expect(container.querySelector("[data-update-mark]")?.getAttribute("data-update-mark")).toBe("busy");
    expect(container.querySelector("[data-update-state]")?.textContent).toContain(words);
    expect(container.querySelector("[data-update-action]")).toBeNull();
    unmount();
  }
});

test("the one confirmation: from which version to which, what changes, the working agents, no way back, the skills it overwrites by name; Update sends it", () => {
  state.status = available({ runs: 2 });
  render(<Places />);
  const confirmation = start({ runs: 2, changes: ["速くなりました"], skills: ["alpacawork", "alpacawork-betterquality"] });
  open(confirmation);
  const dialog = document.querySelector("[data-update-confirm]")!;
  expect(within(dialog as HTMLElement).getByRole("heading").textContent).toContain("0.10.0");
  expect(dialog.querySelector("[data-update-from]")?.textContent).toBe(`${APP_VERSION} → 0.10.0 リリースノート`);
  expect(dialog.textContent).toContain("速くなりました");
  expect(dialog.querySelector("[data-update-body]")?.textContent).toContain(`${APP_VERSION} に戻せません`);
  expect(dialog.querySelector("[data-update-body]")?.textContent).toContain("（2件）");
  expect(dialog.querySelector("[data-update-overwrite]")?.textContent).toContain("alpacawork、alpacawork-betterquality");
  fireEvent.click(screen.getByRole("checkbox", { name: "次回もこの確認を表示する" }));
  fireEvent.click(document.querySelector("[data-update-submit]")!);
  expect(approveStart).toHaveBeenCalledWith(confirmation, false);
});

test("no release notes known: no list, the overwrite notice all the same", () => {
  state.status = available();
  render(<Places />);
  open(start());
  const dialog = document.querySelector("[data-update-confirm]")!;
  expect(dialog.querySelector("ul")).toBeNull();
  expect(dialog.querySelector("[data-update-body]")?.textContent).not.toContain("エージェント");
  expect(dialog.querySelector("[data-update-overwrite]")?.textContent).toContain("（alpacawork）");
});

test("failed: the ! mark, the next step for its kind of fault, that the current version keeps working, and Try again on the same candidate", () => {
  state.status = { kind: "failed", candidateId: "c1", version: "0.10.0", category: "other" };
  const { container, rerender } = render(<Places />);
  expect(container.querySelector("[data-update-mark]")?.getAttribute("data-update-mark")).toBe("failed");
  expect(container.querySelector("[data-update-state]")?.textContent).toContain("アップデートできませんでした");
  expect(container.querySelector("[data-update-state]")?.textContent).toContain("今の版のまま使えます");
  fireEvent.click(screen.getByRole("button", { name: "再試行" }));
  expect(retryUpdate).toHaveBeenCalledWith(state.status);
  state.status = { ...state.status, category: "network" };
  rerender(<Places />);
  expect(container.querySelector("[data-update-state]")?.textContent).toContain("インターネット接続を確かめてから再試行してください");
  state.status = { ...state.status, category: "disk" };
  rerender(<Places />);
  expect(container.querySelector("[data-update-state]")?.textContent).toContain("空きを作ってから再試行してください");
});

test("a switch refused for unfinished Runs explains when to retry the same candidate and offers the pause instruction", async () => {
  state.status = { kind: "failed", candidateId: "c1", version: "0.10.0", category: "other", runConflict: { reason: "database", runs: 3 } };
  const { container, rerender } = render(<Places />);
  expect(container.querySelector("[data-update-state]")?.textContent).toContain("（3件）");
  expect(screen.getByRole("button", { name: "止める指示をコピー" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "再試行" }));
  expect(retryUpdate).toHaveBeenCalledWith(state.status);
  try {
    await act(async () => { await activateLocale("en"); });
    expect(container.querySelector("[data-update-state]")?.textContent).toContain("3 agents are working");
    state.status = { ...state.status, runConflict: { reason: "database", runs: 1 } };
    rerender(<Places />);
    expect(container.querySelector("[data-update-state]")?.textContent).toContain("an agent is working");
  } finally { await act(async () => { await activateLocale("ja"); }); }
});

test("needing attention: the ! mark, one phrase (the version, or the new version when not known) and Continue", () => {
  state.status = { kind: "attention", opId, version: "0.10.0" };
  const first = render(<><Places /><Gear /></>);
  expect(first.container.querySelector("[data-update-mark]")?.getAttribute("data-update-mark")).toBe("attention");
  expect(first.container.querySelector("[data-gear]")?.textContent).toBe("設定 — アップデートで対応が必要です");
  expect(first.container.querySelector("[data-update-state]")?.textContent).toContain("切り替えが途中で止まっています");
  fireEvent.click(screen.getByRole("button", { name: "続ける" }));
  expect(continueUpdate).toHaveBeenCalledWith(state.status);
  first.unmount();
  state.status = { kind: "attention", opId: null, version: null };
  const second = render(<Places />);
  expect(second.container.querySelector("[data-update-state]")?.textContent).toContain("続けると、止まったところから進めます");
});

test("while a press is answered its button keeps the keyboard's focus: it says it is busy and ignores presses", () => {
  state.status = { kind: "attention", opId, version: "0.10.0" };
  render(<Places />);
  const button = screen.getByRole("button", { name: "続ける" });
  button.focus();
  act(() => useUpdateLocal.setState({ sending: true }));
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(continueUpdate).not.toHaveBeenCalled();
  act(() => useUpdateLocal.setState({ sending: false }));
  fireEvent.click(button);
  expect(continueUpdate).toHaveBeenCalledTimes(1);
});
