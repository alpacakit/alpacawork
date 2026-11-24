import { act, render } from "@testing-library/react";
import { useState } from "react";
import { PointerTip } from "../src/features/analysis/parts";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { TodayMarks } from "../src/features/analysis/FaceSwitch";
import { FRESH_AFTER_MS } from "../src/features/analysis/data";
import { queryClient } from "../src/data/query-client";
import { screenData, TestWorkspace } from "./fixtures";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("ja"); });
afterEach(() => { vi.useRealTimers(); queryClient.clear(); });

const today = (count: number, { total = count, cursor = null as string | null, outcome = "passed", from = 1 } = {}) => ({
  head: { timeZone: "UTC", today: "2026-11-24", firstDay: "2026-11-01", project: null, period: { from: "2026-11-24", to: "2026-11-24" }, previous: null },
  total, cursor,
  rows: Array.from({ length: count }, (_, at) => ({ id: `T${at + from}`, title: "t", project: "P100", outcome, finishedAt: "2026-11-24T01:00:00Z", value: null })),
});

test("today's marks are read again when the workspace changes while the list stays open", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const answers = [today(1), today(2)];
  const marks = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("analysis/list") ? answers.shift() ?? today(2) : {}), { status: 200 }));
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => marks(String(input)));
  const data = screenData();
  const view = render(<TestWorkspace data={data}><TodayMarks /></TestWorkspace>);
  await vi.waitFor(() => expect(view.container.querySelectorAll("button i")).toHaveLength(1));
  // A change notice: the index moves on, and after the short wait the marks are asked for again.
  view.rerender(<TestWorkspace data={{ ...data, info: { ...data.info, rev: data.info.rev + 1 } }}><TodayMarks /></TestWorkspace>);
  await act(async () => { await vi.advanceTimersByTimeAsync(FRESH_AFTER_MS + 10); });
  await vi.waitFor(() => expect(view.container.querySelectorAll("button i")).toHaveLength(2));
});

test("today's marks show only a whole reading, and a page that fails is not asked for again", async () => {
  let second: (body: unknown) => void = () => {};
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("analysis/list")) return new Response("{}", { status: 200 });
    asked.push(url);
    if (!url.includes("cursor=")) return new Response(JSON.stringify(today(100, { total: 105, cursor: "c2", outcome: "reworked" })), { status: 200 });
    return new Promise<Response>(resolve => { second = body => resolve(new Response(JSON.stringify(body), { status: body ? 200 : 400 })); });
  });
  const view = render(<TestWorkspace data={screenData()}><TodayMarks /></TestWorkspace>);
  await vi.waitFor(() => expect(asked).toHaveLength(2));
  // Part of the day is read: nothing is told of it yet.
  expect(view.container.querySelector("button")).toBeNull();
  await act(async () => second(today(5, { total: 105, from: 101 })));
  await vi.waitFor(() => expect(view.container.querySelectorAll("button i")).toHaveLength(105));
  expect(view.container.querySelector("button")!.getAttribute("title")).toMatch(/105\D.*\b5\b/);
  view.unmount(); queryClient.clear(); asked.length = 0;
  // A next page refused: asked once, not again.
  const failed = render(<TestWorkspace data={screenData()}><TodayMarks /></TestWorkspace>);
  await vi.waitFor(() => expect(asked).toHaveLength(2));
  await act(async () => second(null));
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(asked).toHaveLength(2);
  failed.unmount();
});

test("a small window opened under a finger closes when Back moves to another step", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(hover: none)", media: query, addEventListener() {}, removeEventListener() {} }));
  function Shown() {
    const [root, setRoot] = useState<HTMLElement | null>(null);
    return <div ref={setRoot}><i data-tip-tap="" data-tip="作業中 35分" /><PointerTip root={root} /></div>;
  }
  const view = render(<Shown />);
  await act(async () => (view.container.querySelector("[data-tip-tap]") as HTMLElement).click());
  expect(view.getByText("作業中 35分", { selector: "[role=presentation]" })).toBeTruthy();
  await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); });
  expect(view.queryByText("作業中 35分", { selector: "[role=presentation]" })).toBeNull();
});
