import { act, fireEvent, render } from "@testing-library/react";
import { SearchField } from "../src/features/chrome/SearchField";
import { analysisHome, type AnalysisPlace } from "../src/features/analysis/place";
import { AnalysisLayers } from "../src/features/analysis/AnalysisLayers";
import { useState } from "react";
import { ChartHead, PointerTip, Rule, RuleCard, Rules } from "../src/features/analysis/parts";
import { BarChart, ChartGroup, changesByBin, Parts, Row } from "../src/features/analysis/rows";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { TodayMarks } from "../src/features/analysis/FaceSwitch";
import { FaceSkeleton } from "../src/features/analysis/FaceSkeleton";
import { FRESH_AFTER_MS } from "../src/features/analysis/data";
import { queryClient } from "../src/data/query-client";
import { useViewStore } from "../src/state/view-store";
import { giveFocusBack, openerChain } from "../src/lib/focus-return";
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
  // The keys: the first arrow starts on the span's last day, the next ones move it, Enter opens it.
  fireEvent.keyDown(chart, { key: "ArrowLeft" });
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

test("the last thing done says the day: a day the pointer left waiting gives way to a key; Escape in the legend gives the focus to its chart; a list closed gives it back to where it was opened", () => {
  vi.useFakeTimers();
  const bins = Array.from({ length: 10 }, (_, at) => ({ from: `2026-11-${String(at + 1).padStart(2, "0")}`, to: `2026-11-${String(at + 1).padStart(2, "0")}`, complete: true }));
  const day = (bin: { from: string; to: string }) => ({ from: bin.from, to: bin.to });
  const rows = [{ name: "トークン", total: (at: number) => `${at}`, list: (bin: { from: string; to: string }) => ({ set: "used" as const, value: "tokens" as const, ...day(bin) }),
    parts: (at: number) => [{ color: "", name: "出力", value: `${at}`, list: (bin: { from: string; to: string }) => ({ set: "used" as const, value: "output" as const, ...day(bin) }) }] }];
  const list = { set: "used", value: "output", group: null, member: null } as const;
  // The list's window as Layers is: it takes the focus as it opens and, closing, gives it back to what opened it
  // (only when the focus was in it or is gone). Closing is a step of the history, which lets go of a day.
  const surface = document.createElement("button");
  let chain: Element[] = [];
  const open = () => {
    useViewStore.setState({ analysis: { look: "usage", span: { period: "7d" }, list, card: null } });
    chain = openerChain(document.activeElement);
    document.body.append(surface); surface.focus();
  };
  const closeList = () => {
    const inside = document.activeElement === surface;
    surface.remove();
    act(() => { useViewStore.setState({ analysis: { look: "usage", span: { period: "7d" }, list: null, card: null } }); });
    if (inside) giveFocusBack(chain);
    act(() => { dispatchEvent(new PopStateEvent("popstate")); vi.advanceTimersByTime(50); });
  };
  const view = render(<div><button type="button">月ごと</button>
    <ChartGroup bins={bins} span={{ from: "2026-11-01", to: "2026-11-07" }} today="2026-11-30" bucket="day" rows={rows} open={open}>
      <Row row={0} left={<span>期間の数</span>}><BarChart row={0} height="h-16" scale={{ top: 40, label: "40" }} values={at => [["", at + 1]]} /></Row>
    </ChartGroup></div>);
  const legend = () => view.container.querySelector("[data-day-legend]");
  const chart = view.container.querySelector<HTMLElement>("[data-chart-row]")!;
  const columns = view.container.querySelectorAll("[data-day-column]");
  const outside = view.getByRole("button", { name: "月ごと" });
  // A quick move left leaves a day waiting; a key wins over it, in the chart or anywhere else on the screen.
  fireEvent.mouseMove(columns[8]!, { clientX: 800, clientY: 10 });
  fireEvent.mouseMove(columns[7]!, { clientX: 700, clientY: 10 });
  chart.focus();
  fireEvent.keyDown(chart, { key: "Home" });
  act(() => { vi.advanceTimersByTime(500); });
  expect(legend()?.textContent).toContain("11/1");
  fireEvent.mouseMove(columns[8]!, { clientX: 800, clientY: 10 });
  fireEvent.mouseMove(columns[7]!, { clientX: 700, clientY: 10 });
  fireEvent.keyDown(outside, { key: "Tab" });
  act(() => { vi.advanceTimersByTime(500); });
  expect(legend()?.textContent).toContain("11/9");
  // Escape on a part of the legend: the span's numbers again, and the focus on the chart.
  const part = view.getByRole("button", { name: /出力/ });
  part.focus();
  fireEvent.keyDown(part, { key: "Escape" });
  expect(legend()).toBeNull();
  expect(document.activeElement).toBe(chart);
  // A list opened from a part of the legend: closed, the same day is shown and its part has the focus again.
  fireEvent.keyDown(chart, { key: "End" });
  view.getByRole("button", { name: /出力/ }).focus();
  fireEvent.click(view.getByRole("button", { name: /出力/ }));
  expect(legend()).toBeNull();
  closeList();
  expect(legend()?.textContent).toContain("11/10");
  expect(document.activeElement?.textContent).toContain("出力");
  // Opened with the pointer while the focus was elsewhere: closed, the focus is on the chart that opened it.
  outside.focus();
  document.elementsFromPoint = () => [chart];
  fireEvent.click(columns[3]!, { clientX: 10, clientY: 10 });
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  closeList();
  expect(document.activeElement).toBe(chart);
  // The person moved the focus out of the list before closing it: it stays where they put it.
  fireEvent.keyDown(chart, { key: "End" });
  fireEvent.keyDown(chart, { key: "Enter" });
  outside.focus();
  closeList();
  expect(document.activeElement).toBe(outside);
  expect(legend()).toBeNull();
  fireEvent.keyDown(chart, { key: "End" });
  view.getByRole("button", { name: /出力/ }).focus();
  fireEvent.click(view.getByRole("button", { name: /出力/ }));
  outside.focus();
  closeList();
  expect(document.activeElement).toBe(outside);
  expect(legend()).toBeNull();
  view.unmount();
  useViewStore.setState({ analysis: null });
});

test("a day left waiting and dropped by another span leaves none of its listeners behind", () => {
  vi.useFakeTimers();
  const bins = Array.from({ length: 10 }, (_, at) => ({ from: `2026-11-${String(at + 1).padStart(2, "0")}`, to: `2026-11-${String(at + 1).padStart(2, "0")}`, complete: true }));
  const rows = [{ name: "トークン", total: (at: number) => `${at}` }];
  const live = new Map<string, Set<unknown>>();
  const add = vi.spyOn(window, "addEventListener").mockImplementation((kind, fn) => { live.set(kind, (live.get(kind) ?? new Set()).add(fn)); });
  const remove = vi.spyOn(window, "removeEventListener").mockImplementation((kind, fn) => { live.get(kind)?.delete(fn); });
  const group = (from: string) => <ChartGroup bins={bins} span={{ from, to: "2026-11-07" }} today="2026-11-30" bucket="day" rows={rows} open={() => {}}>
    <Row row={0} left={<span>期間の数</span>}><BarChart row={0} height="h-16" scale={{ top: 40, label: "40" }} values={at => [["", at + 1]]} /></Row>
  </ChartGroup>;
  const view = render(group("2026-11-01"));
  for (const from of ["2026-11-02", "2026-11-03", "2026-11-04"]) {
    const columns = view.container.querySelectorAll("[data-day-column]");
    fireEvent.mouseMove(columns[8]!, { clientX: 800, clientY: 10 });
    fireEvent.mouseMove(columns[7]!, { clientX: 700, clientY: 10 });
    expect(live.get("keydown")?.size ?? 0).toBe(1);
    view.rerender(group(from));
  }
  for (const kind of ["keydown", "focusin", "wheel"]) expect(live.get(kind)?.size ?? 0).toBe(0);
  add.mockRestore(); remove.mockRestore();
  view.unmount();
});

test("how the numbers are counted is always open under the breakdown, and the way to it at the charts' head takes the focus there", () => {
  const page = render(<><ChartHead /><p>charts</p>
    <Rules><RuleCard><Rule name="手直しなし">受け入れたタスクのうち</Rule></RuleCard><RuleCard><Rule name="全期間">記録の最初の日から</Rule></RuleCard></Rules></>);
  // Nothing opens or closes: the rules are read as they stand, a section named by its heading, cards of names and what each counts.
  const region = page.getByRole("region", { name: "数え方" });
  expect(region.querySelectorAll("dl")).toHaveLength(2);
  expect([...region.querySelectorAll("dt")].map(name => name.textContent)).toEqual(["手直しなし", "全期間"]);
  expect(page.container.querySelector("[aria-expanded]")).toBeNull();
  fireEvent.click(page.getByRole("link", { name: "数え方" }));
  expect(document.activeElement).toBe(page.getByRole("heading", { name: "数え方" }));
});

test("a list's next page stands as rows while it is read, and one that could not be read says so and is asked again", async () => {
  let page: (body: unknown) => void = () => {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("analysis/list")) return new Response("{}", { status: 200 });
    if (!url.includes("cursor=")) return new Response(JSON.stringify(today(100, { total: 103, cursor: "c2" })), { status: 200 });
    return new Promise<Response>(resolve => { page = body => resolve(new Response(JSON.stringify(body ?? { error: { code: "unavailable", message: "x", retry: "later" } }), { status: body ? 200 : 503 })); });
  });
  const place = { ...analysisHome(), list: { set: "finished" as const, value: null, group: null, member: null } };
  const view = render(<TestWorkspace data={screenData()}><AnalysisLayers place={place} project={null} days={null} beside={false} /></TestWorkspace>);
  await vi.waitFor(() => expect(view.container.querySelectorAll("[data-analysis-layer] li")).toHaveLength(100));
  await act(async () => view.getByRole("button", { name: /残り/ }).click());
  // Asked for: its rows' places stand where they will come, not nothing.
  await vi.waitFor(() => expect(view.container.querySelector("[data-analysis-layer] [data-skeleton]")).not.toBeNull());
  await act(async () => page(null));
  await vi.waitFor(() => expect(view.container.querySelector("[data-read-failure]")).not.toBeNull());
  expect(view.container.querySelectorAll("[data-analysis-layer] li")).toHaveLength(100);
  await act(async () => view.getByRole("button", { name: i18n.t("retry") }).click());
  await act(async () => page(today(3, { total: 103, from: 101 })));
  await vi.waitFor(() => expect(view.container.querySelectorAll("[data-analysis-layer] li")).toHaveLength(103));
  expect(view.container.querySelector("[data-read-failure]")).toBeNull();
  view.unmount();
});

test("the parts' number columns are measured again only when their words change, not on every drawing", () => {
  const bins = [{ from: "2026-11-01", to: "2026-11-01", complete: true }, { from: "2026-11-02", to: "2026-11-02", complete: true }];
  const rows = [{ name: "終わったタスク", total: (at: number) => `${at}` }];
  const read = vi.spyOn(Element.prototype, "getBoundingClientRect");
  const measured = () => read.mock.contexts.filter(cell => (cell as HTMLElement).dataset?.partCol).length;
  const group = (value: string) => <ChartGroup bins={bins} span={{ from: "2026-11-01", to: "2026-11-02" }} today="2026-11-30" bucket="day" rows={rows} open={() => {}}>
    <Row row={0} left={<Parts items={[{ color: "", name: "手直しなし", value }]} />}>
      <BarChart row={0} height="h-16" scale={{ top: 4, label: "4" }} values={at => [["", at + 1]]} /></Row>
  </ChartGroup>;
  const view = render(group("3件"));
  const first = measured();
  expect(first).toBeGreaterThan(0);
  view.rerender(group("3件"));
  expect(measured()).toBe(first);
  view.rerender(group("12件"));
  expect(measured()).toBeGreaterThan(first);
  read.mockRestore();
  view.unmount();
});

test("a bin says each change once, however many agents took it on its days", () => {
  const week = [{ from: "2026-11-16", to: "2026-11-22", complete: true }, { from: "2026-11-23", to: "2026-11-29", complete: true }];
  const marks = changesByBin(week, [
    { day: "2026-11-24", words: ["alpacawork 0.1.6 → 0.1.7", "スキル review を更新"] },
    { day: "2026-11-25", words: ["alpacawork 0.1.6 → 0.1.7"] },
    { day: "2026-11-30", words: ["スキル plan を追加"] },
  ]);
  expect([...marks]).toEqual([[1, ["alpacawork 0.1.6 → 0.1.7", "スキル review を更新"]]]);
});

test("the face's stand-in asks the server for nothing, so the face's own answer is read first", async () => {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => { asked.push(String(input)); return new Response("{}", { status: 200 }); });
  for (const look of ["tasks", "usage"] as const) {
    const view = render(<TestWorkspace data={screenData()}><FaceSkeleton look={look} span={{ period: "7d" }} bucket="day" /></TestWorkspace>);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    view.unmount();
  }
  expect(asked.filter(url => url.includes("analysis/"))).toEqual([]);
});

test("the pointed day's band follows the pointer at once, even while the legend's day waits, and no chart's bars are drawn again for it", () => {
  vi.useFakeTimers();
  const bins = Array.from({ length: 10 }, (_, at) => ({ from: `2026-11-${String(at + 1).padStart(2, "0")}`, to: `2026-11-${String(at + 1).padStart(2, "0")}`, complete: true }));
  const rows = [{ name: "トークン", total: (at: number) => `${at}` }];
  let drawn = 0;
  const view = render(<ChartGroup bins={bins} span={{ from: "2026-11-01", to: "2026-11-10" }} today="2026-11-30" bucket="day" rows={rows} open={() => {}}>
    <Row row={0} left={<span>期間の数</span>}><BarChart row={0} height="h-16" scale={{ top: 40, label: "40" }} values={at => { drawn++; return [["", at + 1]]; }} /></Row>
  </ChartGroup>);
  const columns = view.container.querySelectorAll("[data-day-column]");
  const lit = () => [...view.container.querySelectorAll<HTMLElement>("[data-bin][data-lit]")].map(bin => Number(bin.dataset.bin));
  const legend = () => view.container.querySelector("[data-day-legend]")?.textContent ?? "";
  const before = drawn;
  fireEvent.mouseMove(columns[8]!, { clientX: 800, clientY: 10 });
  expect(new Set(lit())).toEqual(new Set([8]));
  // A quick move left: the legend still says the day before, the band already stands on the new day.
  fireEvent.mouseMove(columns[7]!, { clientX: 700, clientY: 10 });
  expect(new Set(lit())).toEqual(new Set([7]));
  expect(legend()).toContain("11/9");
  act(() => { vi.advanceTimersByTime(500); });
  expect(legend()).toContain("11/8");
  expect(drawn).toBe(before);
});
