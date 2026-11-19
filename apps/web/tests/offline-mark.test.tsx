import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { onlineManager } from "@tanstack/react-query";
import { i18n, startI18n } from "@alpacawork/i18n";
import { useConnection } from "../src/data/connection";
import { formatNoticeTime } from "../src/domain/time";
import { OfflineMark } from "../src/features/chrome/OfflineMark";
import { NARROW_QUERY } from "../src/state/view-store";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("ja"); });
afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  useConnection.setState({ lastReceivedAt: undefined });
});

// The screen's one mark tells the time of the feed's last arrival, the newest any of the screen was.
test("the offline mark tells no time before anything arrived", () => {
  render(<OfflineMark />);
  const mark = screen.getByRole("button", { name: "オフライン" });
  expect(mark.textContent).toBe("");
  fireEvent.click(mark);
  const explanation = document.querySelector("[data-offline-explanation]")!;
  expect(explanation.textContent).not.toMatch(/\d{2}:\d{2}/);
  expect(explanation.textContent).toContain("接続が戻るまで、送信や変更はできません。");
});

test("the offline mark tells the feed's last arrival and offers to reconnect where there is something to reach", () => {
  const at = Date.parse("2026-10-24T09:23:00+09:00");
  const reconnect = vi.fn();
  useConnection.setState({ lastReceivedAt: at, reconnect });
  render(<OfflineMark />);
  const clock = formatNoticeTime(new Date(at).toISOString());
  fireEvent.click(screen.getByRole("button", { name: `オフライン · ${clock} に取得` }));
  expect(document.querySelector("[data-offline-explanation]")!.textContent).toContain(`${clock} 時点の内容を表示しています。`);
  fireEvent.click(document.querySelector("[data-offline-reconnect]")!);
  expect(reconnect).toHaveBeenCalledOnce();
  expect(document.querySelector("[data-offline-explanation]")).toBeNull();
});

test("a browser that says it is offline has nothing to reconnect to", () => {
  onlineManager.setOnline(false);
  render(<OfflineMark />);
  fireEvent.click(screen.getByRole("button", { name: "オフライン" }));
  expect(document.querySelector("[data-offline-reconnect]")).toBeNull();
});

// On a phone the popup is a sheet whose head already has the one ×; what it holds adds none of its own.
test("on a phone the offline sheet has one close button", () => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ ...original(query), matches: query === NARROW_QUERY }));
  try {
    render(<OfflineMark />);
    fireEvent.click(screen.getByRole("button", { name: "オフライン" }));
    const sheet = document.querySelector<HTMLElement>("[data-slot=sheet]")!;
    expect(within(sheet).getAllByRole("button", { name: "閉じる" })).toHaveLength(1);
  } finally { vi.restoreAllMocks(); }
});
