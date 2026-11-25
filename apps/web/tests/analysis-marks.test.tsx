import { act, fireEvent, render } from "@testing-library/react";
import { SearchField } from "../src/features/chrome/SearchField";
import { analysisHome } from "../src/features/analysis/place";
import { useState } from "react";
import { PointerTip } from "../src/features/analysis/parts";
import { BarChart, ChartGroup, Row } from "../src/features/analysis/rows";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { TodayMarks } from "../src/features/analysis/FaceSwitch";
import { FRESH_AFTER_MS } from "../src/features/analysis/data";
import { queryClient } from "../src/data/query-client";
import { useViewStore } from "../src/state/view-store";
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

test("today's marks of another project stand out of reach until this project's are read", async () => {
  let held: (body: unknown) => void = () => {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("analysis/list")) return new Response("{}", { status: 200 });
    if (!url.includes("project=")) return new Response(JSON.stringify(today(14)), { status: 200 });
    return new Promise<Response>(resolve => { held = body => resolve(new Response(JSON.stringify(body), { status: 200 })); });
  });
  const view = render(<TestWorkspace data={screenData()}><TodayMarks /></TestWorkspace>);
  await vi.waitFor(() => expect(view.container.querySelectorAll("button i")).toHaveLength(14));
  expect(view.container.querySelector("[data-answer]")!.getAttribute("data-answer")).toBe("current");
  act(() => useViewStore.setState({ project: "P100" }));
  // Every-project marks still drawn while one project's are read: they cannot be pressed.
  expect(view.container.querySelector("[data-answer]")!.getAttribute("data-answer")).toBe("other");
  expect(view.container.querySelector("button")!.closest("[inert]")).not.toBeNull();
  await act(async () => held(today(1)));
  await vi.waitFor(() => expect(view.container.querySelectorAll("button i")).toHaveLength(1));
  expect(view.container.querySelector("button")!.closest("[inert]")).toBeNull();
  act(() => useViewStore.setState({ project: null }));
});

test("a search typed just before the face changes to Use is dropped with the change", async () => {
  vi.useFakeTimers();
  useViewStore.setState({ navigationReady: true, query: "", analysis: analysisHome() });
  const view = render(<SearchField />);
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "R" } });
  act(() => useViewStore.getState().showAnalysis(null));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(useViewStore.getState()).toMatchObject({ query: "", analysis: null });
  expect((view.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  view.unmount();
});

test("a conversion under way when the face changes is dropped, and its confirmation runs no search", async () => {
  vi.useFakeTimers();
  useViewStore.setState({ navigationReady: true, query: "", analysis: analysisHome() });
  const view = render(<SearchField />);
  const box = view.container.querySelector<HTMLInputElement>("[data-search-input]")!;
  fireEvent.compositionStart(box);
  fireEvent.change(box, { target: { value: "けんさく" } });
  act(() => useViewStore.getState().showAnalysis(null));
  fireEvent.compositionEnd(box, { target: { value: "検索" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(useViewStore.getState()).toMatchObject({ query: "", analysis: null });
  view.unmount();
});

test("on a computer the pointed row's left says the day and comes back; a press on a bar's part opens that part's tasks of the day", () => {
  const days = (count: number) => Array.from({ length: count }, (_, at) => ({ from: `2026-11-${String(at + 1).padStart(2, "0")}`, to: `2026-11-${String(at + 1).padStart(2, "0")}`, complete: true }));
  const opened = vi.fn();
  const day = (bin: { from: string; to: string }) => ({ from: bin.from, to: bin.to });
  const rows = [{ name: "終わったタスク", total: (at: number) => `${at}件`, list: (bin: { from: string; to: string }) => ({ set: "finished" as const, value: null, ...day(bin) }),
    parts: (at: number) => [{ color: "bg-done", name: "手直しなし", value: `${at}件`, list: (bin: { from: string; to: string }) => ({ set: "passed" as const, value: "lead" as const, ...day(bin) }) }] }];
  const group = (bucket: "day" | "week", bins: ReturnType<typeof days>) =>
    <ChartGroup bins={bins} span={{ from: "2026-11-01", to: "2026-11-07" }} today="2026-11-30" bucket={bucket} rows={rows} open={opened}>
      <Row row={0} left={<span>期間の数</span>}><BarChart row={0} height="h-16" scale={{ top: 40, label: "40件" }} values={at => [["bg-done", at + 1, 0]]} /></Row>
    </ChartGroup>;
  const view = render(group("day", days(30)));
  const columns = view.container.querySelectorAll("[data-day-column]");
  const legend = () => view.container.querySelector("[data-day-legend]");
  fireEvent.mouseMove(columns[28]!, { clientX: 10, clientY: 10 });
  expect(legend()?.textContent).toContain("28件");
  // Nothing is laid over the charts.
  expect(view.queryByRole("presentation")).toBeNull();
  fireEvent.mouseLeave(columns[28]!.parentElement!);
  expect(legend()).toBeNull();
  // A press on the bar's part opens that part's tasks of that day; on the column elsewhere, the row's.
  const part = view.container.querySelectorAll("[data-part]")[28]!;
  const chart = view.container.querySelector("[data-chart-row]")!;
  document.elementsFromPoint = () => [part, chart];
  fireEvent.click(columns[28]!, { clientX: 10, clientY: 10 });
  expect(opened).toHaveBeenLastCalledWith({ set: "passed", value: "lead", from: "2026-11-29", to: "2026-11-29" });
  document.elementsFromPoint = () => [chart];
  fireEvent.click(columns[28]!, { clientX: 10, clientY: 10 });
  expect(opened).toHaveBeenLastCalledWith({ set: "finished", value: null, from: "2026-11-29", to: "2026-11-29" });
  // Another step of time lets go of the day pointed at.
  fireEvent.mouseMove(columns[29]!, { clientX: 10, clientY: 10 });
  view.rerender(group("week", days(4).map(bin => ({ ...bin, complete: false }))));
  expect(legend()).toBeNull();
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  view.unmount();
});

test("a chart takes the keys: the arrows choose the day its legend says, Enter opens that day; from the chart straight to its legend the day stays and its parts open that day's", () => {
  const bins = Array.from({ length: 10 }, (_, at) => ({ from: `2026-11-${String(at + 1).padStart(2, "0")}`, to: `2026-11-${String(at + 1).padStart(2, "0")}`, complete: true }));
  const opened = vi.fn();
  const day = (bin: { from: string; to: string }) => ({ from: bin.from, to: bin.to });
  const rows = [{ name: "終わったタスク", total: (at: number) => `${at}件`, list: (bin: { from: string; to: string }) => ({ set: "finished" as const, value: null, ...day(bin) }),
    parts: (at: number) => [{ color: "bg-reworked", name: "手直しあり", value: `${at}件`, list: (bin: { from: string; to: string }) => ({ set: "reworked" as const, value: "lead" as const, ...day(bin) }) }] }];
  const view = render(<div>
    <ChartGroup bins={bins} span={{ from: "2026-11-01", to: "2026-11-07" }} today="2026-11-30" bucket="day" rows={rows} open={opened}>
      <Row row={0} left={<span>期間の数</span>}><BarChart row={0} height="h-16" scale={{ top: 40, label: "40件" }} values={at => [["bg-reworked", at + 1, 0]]} /></Row>
    </ChartGroup>
    <button type="button">外</button>
  </div>);
  const legend = () => view.container.querySelector("[data-day-legend]");
  const chart = view.container.querySelector<HTMLElement>("[data-chart-row]")!;
  // The keys: the chart starts on the span's last day, the arrows move it, Enter opens it.
  fireEvent.focus(chart);
  expect(legend()?.textContent).toContain("11/7");
  fireEvent.keyDown(chart, { key: "ArrowRight" });
  expect(legend()?.textContent).toContain("11/8");
  fireEvent.keyDown(chart, { key: "Enter" });
  expect(opened).toHaveBeenLastCalledWith({ set: "finished", value: null, from: "2026-11-08", to: "2026-11-08" });
  // The pointer: from a column straight to the row's left, the day stays; a part there opens that part's tasks of the day.
  const columns = view.container.querySelectorAll("[data-day-column]");
  fireEvent.mouseMove(columns[2]!, { clientX: 10, clientY: 10 });
  const left = view.container.querySelector("[data-row='0']")!.firstElementChild!;
  fireEvent.mouseLeave(columns[2]!.parentElement!, { relatedTarget: left });
  expect(legend()?.textContent).toContain("11/3");
  fireEvent.click(view.getByRole("button", { name: /手直しあり/ }));
  expect(opened).toHaveBeenLastCalledWith({ set: "reworked", value: "lead", from: "2026-11-03", to: "2026-11-03" });
  // Going left fast toward the legend, the days crossed are not taken; arriving in the row, the day stays.
  fireEvent.mouseMove(columns[6]!, { clientX: 600, clientY: 10 });
  fireEvent.mouseMove(columns[4]!, { clientX: 400, clientY: 12 });
  fireEvent.mouseMove(columns[1]!, { clientX: 100, clientY: 12 });
  fireEvent.mouseLeave(columns[1]!.parentElement!, { relatedTarget: left });
  expect(legend()?.textContent).toContain("11/7");
  // Leaving the row lets go of the day.
  fireEvent.mouseMove(columns[2]!, { clientX: 10, clientY: 10 });
  fireEvent.mouseLeave(view.container.querySelector("[data-row='0']")!, { relatedTarget: view.getByRole("button", { name: "外" }) });
  expect(legend()).toBeNull();
  view.unmount();
});
