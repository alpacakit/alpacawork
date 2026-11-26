import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { beforeAll, afterEach, expect, onTestFinished, test, vi } from "vitest";
import { recordNotes } from "./time-history-fixture";
import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { firstReportMedia, reportDisplay, reportEvent, reportTone } from "../src/domain/report-events";
import { reasonedTurn } from "../src/domain/lead";
import { projectTimeHistory, timeHistoryBase } from "../src/domain/time-history";
import { compactMark, laneMarks } from "../src/features/tree/time-line";
import { ContextPage, ReportFeed } from "../src/features/reader/ReportFeed";
import { TurnReason } from "../src/features/reader/TurnReason";
import { WaitingReportActions } from "../src/features/reader/WaitingReportActions";
import { useDraftStore } from "../src/features/forms/draft-store";
import { answersIn, documentSchema } from "../src/features/coordinator/editor/document";
import { useViewStore } from "../src/state/view-store";
import { useConversation } from "../src/features/coordinator/coordinator";
import { useDialogStore } from "../src/state/dialog-store";
import { Reader } from "../src/features/reader/Reader";
import { useTimeView } from "../src/state/time-view";
import { TaskAbout } from "../src/features/reader/TaskAbout";
import { at, decideItem, dto, historyFixture, indexOf, logEntry, questionFixture, run, screenData, taskFixture, TestWorkspace, tree, userBall , valuesView } from "./fixtures";
import { queryClient } from "../src/data/query-client";
import { receivePatch, resources } from "../src/data/resources";
import { historyCursor } from "@alpacawork/contract";
/** Where a jump in the column goes: the row it brings into view (the glide itself is scroll-report's). */
const jump = vi.hoisted(() => ({ to: (_target: HTMLElement, _block?: string) => {} }));
/** Steps as the server lists them once the lead's row is opened. */
const listedSteps = (steps: { id: string; tool: string; kind: "command"; text: string; state: "running" | "done" }[]) => ({
  total: steps.length, version: steps.length, complete: true, generation: 1,
  steps: steps.map((step, n) => ({ n, id: step.id, tool: step.tool, kind: step.kind, text: step.text, more: 0, about: null, state: step.state, changed: n + 1 })) });
// Every step of a Run, as the server reads them from its output once the lead's row is opened.
const runSteps = vi.hoisted(() => ({ of: (_run: string): Promise<unknown> => new Promise(() => {}) }));
vi.mock("../src/data/run-steps", () => ({ readRunSteps: (run: string) => runSteps.of(run), readRunStep: () => new Promise(() => {}) }));
vi.mock("../src/features/reader/scroll-report", () => ({
  scrollReport: (target: HTMLElement, block: string, landed?: () => void) => { jump.to(target, block); landed?.(); },
}));

beforeAll(() => startI18n());
afterEach(cleanup);

/** T1's responsible, idle: a report it writes is a card on the column's rail. */
const idle = (id = "P1", taskId = "T1") => ({ id, taskId, agentId: `A${id}`, profileKey: "codex", responsible: true,
  active: true, revision: 1, startedAt: at, endedAt: null, headRunId: null,
  runtime: { displayState: "idle" as const, reason: null, sourceRunIds: [], runningCount: 0, queuedCount: 0,
    since: null, lastOutputAt: null, activityKind: null, toolName: null } });

/** What a row says of who it was between, as a screen reader hears it, and its kind. */
const said = (row: Element | null) => `${row?.querySelector("[data-row-said]")?.textContent ?? ""} · ${row?.querySelector("[data-row-kind]")?.textContent ?? ""}`;

test("live updates keep an older report mounted while History refreshes", async () => {
  queryClient.clear();
  const value = tree({ tasks: [dto()] });
  const data = screenData(value);
  const index = indexOf(value);
  const key = resources.history(index.root, "T1").queryKey;
  const page = { events: historyFixture([{ id: "Lolder", kind: "comment", title: "Older report" }]), nextBefore: null };
  let release: ((response: Response) => void) | undefined;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const phases: string[] = [];
  render(<TestWorkspace data={data}><Profiler id="reports" onRender={(_id, phase) => phases.push(phase)}>
    <ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} />
  </Profiler></TestWorkspace>);
  act(() => queryClient.setQueryData(key, { pages: [page], pageParams: [null] }));
  const row = await waitFor(() => {
    const found = document.querySelector('[data-report-key="log:T1:Lolder"]');
    expect(found, [...document.querySelectorAll('[data-report-key]')].map(item => item.getAttribute('data-report-key')).join(',')).not.toBeNull();
    return found!;
  });
  const keyed = { upsert: {}, remove: [] };
  act(() => receivePatch(queryClient, { rev: index.rev + 1, generation: index.generation, sourcePv: 1 as never,
    tasks: { upsert: [{ ...index.tasks[0]!, hash: "b".repeat(64) }], remove: [] }, placements: { upsert: [], remove: [] },
    runs: { upsert: [], remove: [] }, home: { upsert: [], remove: [] }, counts: { closed: keyed, home: keyed, tasks: keyed, children: keyed },
    requiredPv: { view: keyed, history: { upsert: { T1: 1 as never }, remove: [] }, page: keyed, timeline: keyed, search: keyed }, meta: {} }));
  expect(row.isConnected).toBe(true);
  expect(document.querySelector('[data-report-key="log:T1:Lolder"]')).toBe(row);
  expect(phases.filter(phase => phase === "mount")).toHaveLength(1);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  release!(new Response(snapshotJson({ generation: "a", sourcePv: 1, events: page.events, hasOlder: false, oldestKey: historyCursor(page.events[0]!) })));
  await waitFor(() => expect(queryClient.getQueryState(key)?.fetchStatus).toBe("idle"));
  expect(document.querySelector('[data-report-key="log:T1:Lolder"]')).toBe(row);
  fetcher.mockRestore();
});
/** For one test; the language goes back after it. */
async function inEnglish() {
  const was = i18n.language;
  await i18n.changeLanguage("en");
  onTestFinished(async () => { await i18n.changeLanguage(was); });
}

test("a report keeps its plain title and Markdown description as separate fields", () => {
  const event = historyFixture([{ id: "L1", kind: "comment", title: "## **New view** [ready](plan.md)",
    summary: "A short update.\n![Red box: review point](review.png)" }])[0]!;
  const report = reportEvent(event, () => null);
  expect(report).toMatchObject({ text: event.title, description: event.summary });
  expect(firstReportMedia(report.description!)).toBe("review.png");
});

test("a hold and its restoration say only which state who set; what they recorded opens below", async () => {
  await inEnglish();
  // As History has them: the question, the hold the user set, and the Coordinator taking it up again.
  const data = screenData(tree({ tasks: [dto({ state: "doing" })], history: { T1: historyFixture([
    { id: "Lback", kind: "changed", at: "2026-09-24T09:20:00Z", state: "doing", by: "main", title: "Preview URL", summary: "Now" },
    { id: "Lhold", kind: "changed", at: "2026-09-24T09:10:00Z", state: "held", by: "human", title: "Preview URL", summary: "Later" },
    { id: "Lask", kind: "question", open: true, title: "Preview URL", summary: "Please review" }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const line = (key: string) => document.querySelector(`[data-report-key="${key}"] [data-row-words]`)?.textContent;
  const name = (key: string) => said(document.querySelector(`[data-report-key="${key}"]`));
  expect([name("log:T1:Lhold"), line("log:T1:Lhold")]).toEqual(["From You to Owner · Change", "Set to On hold"]);
  expect([name("log:T1:Lback"), line("log:T1:Lback")]).toEqual(["From Coordinator to Owner · Change", "Set to In progress"]);
  fireEvent.click(document.querySelector<HTMLElement>('[data-report-key="log:T1:Lhold"] button')!);
  expect(document.querySelector('[data-report-key="log:T1:Lhold"]')?.textContent).toContain("Later");
});

test("a dialogue with the Coordinator about the task is a row of the user's words that opens the Markdown answer", async () => {
  await inEnglish();
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([{ id: "turn-1", kind: "dialogue",
    title: "Have the fictional catalog cards been checked?", summary: "## Check results\n\n**Sample card** was read." }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  // Your words and the Coordinator's reply are a row each, each saying whose it is.
  const words = document.querySelector<HTMLElement>('[data-report-key="dialogue:T1:turn-1"]')!;
  expect(said(words)).toBe("From You to Coordinator · Message");
  expect(words.querySelector("[data-row-words]")?.textContent).toBe("Have the fictional catalog cards been checked?");
  const row = document.querySelector<HTMLElement>('[data-report-key="dialogue:T1:turn-1:reply"]')!;
  expect(said(row)).toBe("From Coordinator to You · Reply");
  const disclosure = row.querySelector("[data-disclosure-body]")!;
  // With no report yet, it is the newest thing written to the task, so it stands open; a press folds and unfolds it.
  expect(disclosure.getAttribute("data-open")).toBe("true");
  fireEvent.click(row.querySelector("button[aria-expanded]")!);
  expect(disclosure.getAttribute("data-open")).toBe("false");
  fireEvent.click(row.querySelector("button[aria-expanded]")!);
  expect(disclosure.getAttribute("data-open")).toBe("true");
  expect(within(row).getByRole("heading", { name: "Check results" })).toBeTruthy();
  expect(within(row).getByText("Sample card").tagName).toBe("STRONG");
});

test("report disclosures share one height and arrow transition on the base motion step", () => {
  // The Coordinator's answer to a question, quoting the user: the newest words written, so it stands open.
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([{ id: "Lmotion", kind: "answer", by: "main",
    title: "Motion report", summary: "An expanding body" }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const row = document.querySelector('[data-report-key="log:T1:Lmotion"]')!;
  const body = row.querySelector<HTMLElement>("[data-disclosure-body]")!;
  const button = row.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  const arrow = button.querySelector("[data-icon='down']")!;
  expect(body.className).toContain("transition-[height]");
  expect(body.className).toContain("duration-(--motion-base)");
  expect(arrow.getAttribute("class")).toContain("duration-(--motion-base)");
  // The newest thing you wrote stands open while no report has come; fold it to see it open again.
  fireEvent.click(button);
  expect(body.getAttribute("data-open")).toBe("false");
  expect(body.hasAttribute("inert")).toBe(true);
  fireEvent.click(button);
  expect(body.getAttribute("data-open")).toBe("true");
  expect(body.hasAttribute("inert")).toBe(false);
  expect(arrow.getAttribute("class")).toContain("rotate-180");
});

test("jumping to an older report scrolls after the open card has finished shrinking", () => {
  const data = screenData(tree({ tasks: [dto()], placements: [idle()], history: { T1: historyFixture([
    { id: "Lnew", kind: "review", at: "2026-10-10T11:00:00Z", state: "waiting", title: "Newest report", summary: "A long body" },
    { id: "Lold", kind: "comment", at: "2026-10-10T10:00:00Z", title: "Older report", summary: "Older body" }]) } }));
  useTimeView.getState().pick("", null);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  const scroll = vi.fn();
  jump.to = scroll;
  try {
    render(<TestWorkspace data={data}><div data-reader-content><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></div></TestWorkspace>);
    expect(document.querySelector('[data-report-key="log:T1:Lnew"] button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("true");
    act(() => useTimeView.getState().pick("T1", "log:T1:Lold"));
    act(() => vi.advanceTimersByTime(199));
    expect(scroll).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(scroll).toHaveBeenCalledOnce();
  } finally {
    jump.to = () => {};
    frame.mockRestore();
    vi.useRealTimers();
    useTimeView.getState().pick("", null);
  }
});

test("a new report that is the user's turn, arriving while the column is read below its top and History is still reading, is brought to its heading", async () => {
  const asked = { id: "Lask", kind: "question" as const, open: false, at: "2026-10-10T10:00:00Z", title: "Which font?", summary: "A or B" };
  const reported = { id: "Lreport", kind: "review" as const, at: "2026-10-10T11:00:00Z", state: "waiting" as const, title: "Done", summary: "A long body" };
  const feed = (events: Parameters<typeof historyFixture>[0], ball: ReturnType<typeof userBall> | null) => {
    const data = screenData(tree({ tasks: [taskFixture({ state: ball ? "waiting" : "doing", ball })], placements: [idle()], history: { T1: historyFixture(events) } }));
    return <TestWorkspace data={data}><div data-reader-content ref={area => { if (area) Object.defineProperty(area, "scrollTop", { value: 400, configurable: true }); }}>
      <ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></div></TestWorkspace>;
  };
  const scroll = vi.fn();
  jump.to = scroll;
  // History is read again and that read never ends: what the feed draws meanwhile is what it holds.
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
  try {
    const view = render(feed([asked], null));
    await waitFor(() => expect(document.querySelector('[data-report-key="log:T1:Lask"]')).not.toBeNull());
    act(() => { void queryClient.invalidateQueries({ queryKey: ["task-history"] }); });
    view.rerender(feed([reported, asked], userBall("review", "Lreport", at)));
    // The column goes to the start of the report's row: its heading, at the top of what is read.
    await waitFor(() => expect(scroll).toHaveBeenCalledWith(document.querySelector('li[data-report-key="log:T1:Lreport"]'), "start"));
  } finally {
    jump.to = () => {};
    fetcher.mockRestore();
  }
});

test("a collapsed report thumbnail uses the same image path rule as the description", () => {
  expect(firstReportMedia("![Image](my image.png)")).toBe("my image.png");
  expect(firstReportMedia("```\n![Hidden](missing.png)\n```\n![Image](my image.png)")).toBe("my image.png");
  expect(firstReportMedia("`![Hidden](missing.png)` ![Image](my image.png)")).toBe("my image.png");
  expect(firstReportMedia("# ![Heading image](heading.png)\n| ![Table image](table.png) |")).toBe("heading.png");
});

test("a child's end of work in its parent's History is a marked card with its own task ID", () => {
  const child = historyFixture([{ id: "L2", kind: "report", taskId: "T2", fromChild: true, at: "2026-10-10T13:00:00Z",
    state: "done", title: "New child report", summary: "![Check point](image.png)" }])[0]!;
  expect(reportEvent(child, () => null)).toEqual(expect.objectContaining({ key: "log:T2:L2", kind: "report", sourceTaskId: "T2",
    mark: { kind: "report", tone: "done" } }));
});

test("a child's urgent report says Urgent beside whose it is, as its parent's column draws it; a child's review does not", async () => {
  await inEnglish();
  const data = screenData(tree({ tasks: [dto({ title: "Parent" }), dto({ id: "T2", parentId: "T1", title: "Child" })], history: { T1: historyFixture([
    { id: "L3", kind: "urgent", taskId: "T2", fromChild: true, at: "2026-10-10T13:00:00Z", title: "Production is down", summary: "Please check now" },
    { id: "L2", kind: "review", taskId: "T2", fromChild: true, at: "2026-10-10T12:00:00Z", state: "waiting", title: "Please review" }]) } }));
  const follow = vi.fn();
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={follow} /></TestWorkspace>);
  const urgent = document.querySelector<HTMLElement>('[data-report-key="log:T2:L3"]')!;
  expect(urgent.querySelector("[data-row-kind]")?.textContent).toBe("Urgent");
  expect(urgent.textContent).toContain("Production is down");
  const whose = urgent.querySelector<HTMLElement>("article [data-disclosure-body] button")!;
  expect(whose.textContent).toContain("Subtask");
  fireEvent.click(whose);
  expect(follow).toHaveBeenCalledWith("T2");
  expect(document.querySelector('[data-report-key="log:T2:L2"]')).not.toBeNull();
  expect(document.querySelector('[data-report-key="log:T2:L2"] [data-urgent]')).toBeNull();
});

test("a child's report image resolves against the child's Task and opens the modal", async () => {
  const child = dto({ id: "T2", parentId: "T1", state: "waiting", files: [{ name: "child image.png", size: 8, revision: "rev1", at }] });
  const data = screenData(tree({ tasks: [dto(), child], placements: [idle("P2", "T2")], history: { T1: historyFixture([{ id: "L2",
    kind: "review", taskId: "T2", fromChild: true, state: "waiting", title: "Child report", summary: "![Child image](child image.png)" }]) } }));
  useViewStore.setState({ ...useViewStore.getInitialState() });
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const image = await waitFor(() => screen.getByRole("img", { name: "Child image" }));
  expect(image.getAttribute("src")).toContain("T2");
  fireEvent.click(image.closest("button")!);
  expect(screen.getByRole("dialog", { name: "Child image" })).toBeTruthy();
});

test("the report column gallery includes child images in visible order", async () => {
  const parent = dto({ files: [
    { name: "parent.png", size: 8, revision: "p", at },
    { name: "parent.png", size: 8, revision: "later-duplicate", at },
    { name: "plain.txt", size: 8, revision: "text", at },
  ] });
  const child = dto({ id: "T2", parentId: "T1", state: "done", files: [{ name: "child.png", size: 8, revision: "c", at }] });
  // The parent's History: its own comment, and its child's end of work (a child's comment is read in the child's own).
  const data = screenData(tree({ tasks: [parent, child], placements: [idle("P1", "T1"), idle("P2", "T2")], history: { T1: historyFixture([
    { id: "Lc", kind: "report", taskId: "T2", fromChild: true, at: "2026-10-10T13:00:00Z", state: "done", title: "Child report", summary: "![Child image](child.png)" },
    { id: "Lp", kind: "comment", at: "2026-10-10T12:00:00Z", title: "Parent report", summary: "![Parent image](parent.png) ![Missing](missing.png) ![Text](plain.txt)" }]) } }));
  useViewStore.setState({ ...useViewStore.getInitialState() });
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const childRow = document.querySelector<HTMLElement>('[data-report-key="log:T2:Lc"]')!;
  expect(childRow).toBeTruthy();
  const disclosure = childRow.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  if (disclosure.getAttribute("aria-expanded") === "false") fireEvent.click(disclosure);
  const childImage = await waitFor(() => within(childRow).getByRole("button", { name: "Child image" }));
  fireEvent.click(childImage);
  expect(screen.getByText("1 of 2")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "Child image" }).querySelector("[data-image-slider-large]")?.getAttribute("src")).toContain("T2");
  fireEvent.click(screen.getByRole("button", { name: /Next image/ }));
  expect(screen.getByText("2 of 2")).toBeTruthy();
  const parentSrc = screen.getByRole("dialog", { name: "Parent image" }).querySelector("[data-image-slider-large]")?.getAttribute("src");
  expect(parentSrc).toContain("T1");
  // Duplicate names still select the first revision; missing and non-media files add no gallery entries.
  expect(parentSrc).toContain("&v=p");
  expect(parentSrc).not.toContain("later-duplicate");
});

test("the oldest of 51 reports remains in the report column", async () => {
  const logs = Array.from({ length: 51 }, (_, at) => logEntry({ id: `L${at + 1}`, kind: "reported",
    at: new Date(Date.UTC(2026, 9, 1, 0, at)).toISOString(), title: at === 0 ? "Oldest report" : `Report ${at + 1}`,
    actor: { kind: "placement", placementId: "P1" } }));
  const data = screenData(tree({ tasks: [dto({ log: logs })],
    history: { T1: historyFixture(logs.map(log => ({ id: log.id, kind: "comment" as const, at: log.at, title: log.title! })).reverse()) } }));
  // The opened view holds only its newest records; the column is History's.
  const task = { ...data.tasks[0]!, logs: logs.slice(-50) };
  render(<TestWorkspace data={data}><ReportFeed task={task} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  // The rows below the first screen are drawn right after it.
  expect(await screen.findByText(/Oldest report/)).toBeTruthy();
  expect(document.querySelectorAll("[data-report-key]")).toHaveLength(51);
  expect(screen.queryByRole("button", { name: /All records/i })).toBeNull();
});


test("each instruction opens its complete Markdown in the report column without a duplicate request section", async () => {
  await inEnglish();
  // Opening a row remembers it as the shown event; later tests start with nothing open.
  onTestFinished(() => useViewStore.setState(useViewStore.getInitialState()));
  // A message from the chat box is often one long paragraph, so its first line is all of it.
  const paragraph = "Here is a fictional catalog idea." + "Could each imaginary plant have a picture?".repeat(8);
  // History's rows of the instructions sent to T1's responsible (a send-back among them) and of a dialogue about T1.
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([
    { id: "D1", kind: "dialogue", at: "2026-09-24T13:00:00Z", title: "Observations on the sample catalog", summary: "Details" },
    { id: "Q5", kind: "request", at: "2026-09-24T12:30:00Z", by: "human", title: paragraph, summary: paragraph },
    { id: "Q3", kind: "request", at: "2026-09-24T11:00:00Z", by: "human", title: "Sent back", summary: "# Sent back\n\n**Full send-back text**" },
    { id: "Q2", kind: "request", at: "2026-09-24T10:00:00Z", by: "human", title: "Later instruction", summary: "# Later instruction\n\n**Full later text**" },
    { id: "Q1", kind: "request", by: "human", title: "First instruction", summary: "# First instruction\n\n**Full first text**" }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const long = document.querySelector('[data-report-key="request:Q5"]')! as HTMLElement;
  const longHead = long.querySelector("[data-row-words]")!;
  expect(longHead.textContent).toBe(paragraph);
  expect(longHead.className).toContain("line-clamp-1");
  fireEvent.click(long.querySelector("button[aria-expanded]")!);
  // The first line is the body's: open, it is said once. Its words fold away as the body opens, hidden from reading.
  expect(long.querySelector("[data-row-words]:not([aria-hidden=true])")).toBeNull();
  await waitFor(() => expect(long.querySelector("[data-row-words]")).toBeNull());
  expect(said(long)).toBe("From You to Owner · Request");
  expect(within(long).getByText(paragraph)).toBeTruthy();
  for (const [id, line, text] of [["Q1", "First instruction", "Full first text"], ["Q2", "Later instruction", "Full later text"],
    ["Q3", "Sent back", "Full send-back text"]] as const) {
    const row = document.querySelector(`[data-report-key="request:${id}"]`)! as HTMLElement;
    const head = row.querySelector("[data-row-words]")!;
    expect(row.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
    // Closed, an instruction is one line, since a message from the chat box is often a single long paragraph.
    expect(head.textContent).toBe(line);
    expect(head.className).toContain("line-clamp-1");
    fireEvent.click(row.querySelector("button[aria-expanded]")!);
    expect(row.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    expect(within(row).getByText(text).tagName).toBe("STRONG");
    // Open, the body says it once: the row names only who sent it, its words hidden from reading as they fold away.
    expect(row.querySelector("[data-row-words]:not([aria-hidden=true])")).toBeNull();
    await waitFor(() => expect(row.querySelector("[data-row-words]")).toBeNull());
    expect(said(row)).toBe("From You to Owner · Request");
  }
  // The dialogue is the newest thing written and no report has come, so it stands open; folded, it is one quiet line.
  const dialogue = document.querySelector<HTMLElement>('[data-report-key="dialogue:T1:D1:reply"]')!;
  expect(dialogue.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(dialogue.querySelector("button[aria-expanded]")!);
  expect(dialogue.querySelector("[data-row-words]")?.className).toContain("line-clamp-1");
  expect(document.querySelector("[data-report-start]")).toBeNull();
  expect(document.querySelector("[data-all-records]")).toBeNull();
});

test("the same report in a row is one row that counts them and reads the older on opening; another body keeps its row", async () => {
  await inEnglish();
  onTestFinished(() => useViewStore.setState(useViewStore.getInitialState()));
  const repeat = (id: string, minute: number, summary: string) => ({ id, kind: "comment" as const, at: `2026-09-24T09:0${minute}:00Z`, state: "doing" as const, title: "Progress so far", summary });
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([
    repeat("L4", 4, "Same body"), repeat("L3", 3, "Same body"), repeat("L2", 2, "Same body"), repeat("L1", 1, "Another body")]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect([...document.querySelectorAll("[data-report-key]")].map(row => row.getAttribute("data-report-key"))).toEqual(["log:T1:L4", "log:T1:L1"]);
  const row = document.querySelector<HTMLElement>('[data-report-key="log:T1:L4"]')!;
  expect(row.querySelector("[data-row-times]")?.textContent).toBe("×3");
  fireEvent.click(within(row).getByRole("button", { name: "Show 2 earlier" }));
  expect([...row.querySelectorAll("[data-folded-report]")].map(each => each.getAttribute("data-folded-report"))).toEqual(["log:T1:L3", "log:T1:L2"]);
  expect(within(row).getAllByText("Same body")).toHaveLength(3);
  const other = document.querySelector<HTMLElement>('[data-report-key="log:T1:L1"]')!;
  expect(other.querySelector("[data-row-words]")?.textContent).toBe("Same title as above, different content");
  fireEvent.click(other.querySelector("button[aria-expanded]")!);
  expect(within(other).getByText("Progress so far")).toBeTruthy();
  expect(within(other).getByText("Another body")).toBeTruthy();
  // Every word of a row darkens on the same hover: its time, whose it is, what it says, the way it opens. Opening
  // another row leaves this one open, so it is folded first.
  fireEvent.click(row.querySelector("button[aria-expanded]")!);
  for (const part of ["[data-rail-time]", "[data-row-name]", "[data-row-words]"])
    expect(document.querySelector<HTMLElement>(`[data-report-key="log:T1:L4"] ${part}`)?.className ?? "group-hover/row:text-ink").toContain("group-hover/row:text-ink");
});

test("the same words to someone else or with another note keep a row each, each opening its own note", async () => {
  await inEnglish();
  const asked = (id: string, minute: number, extra: object) => ({ id, kind: "request" as const, at: `2026-09-24T09:0${minute}:00Z`, by: "human" as const, title: "Fix the colour", summary: "Fix the colour", ...extra });
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([
    asked("Q3", 3, { note: { title: "Make it red", description: "Red, please" } }), asked("Q2", 2, { note: { title: "Make it blue", description: "Blue, please" } }),
    asked("Q1", 1, { recipient: { role: "member", profileKey: "codex" } }), asked("Q0", 0, { recipient: { role: "owner", profileKey: "claude" } })]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect([...document.querySelectorAll("[data-report-key]")].map(row => row.getAttribute("data-report-key"))).toEqual(["request:Q3", "request:Q2", "request:Q1", "request:Q0"]);
  expect(said(document.querySelector('[data-report-key="request:Q1"]'))).toBe("From You to Member · Request");
  const older = document.querySelector<HTMLElement>('[data-report-key="request:Q2"]')!;
  fireEvent.click(older.querySelector("button[aria-expanded]")!);
  expect(within(older).getByText("Blue, please")).toBeTruthy();
});

test("a send-back with no body keeps its one-line title when it is the shown event", async () => {
  await inEnglish();
  onTestFinished(() => useViewStore.setState(useViewStore.getInitialState()));
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([{ id: "Lback", kind: "request",
    at: "2026-09-24T12:00:00Z", by: "human", title: "Restore the sample caption" }]) } }));
  useViewStore.getState().setEvent("request:Lback");
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  // Every row opens: the shown event opens it, its title once in its head and who sent it at the top of what opens.
  const row = document.querySelector<HTMLElement>('[data-report-key="request:Lback"]')!;
  expect(row.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
  expect([...row.querySelectorAll("[data-row-words]")].map(each => each.textContent)).toEqual(["Restore the sample caption"]);
  expect(row.querySelector("[data-row-parties]")?.textContent).toContain("You");
});

/**
 * Who sent a row, as recorded (you on the screen, or the Coordinator through the command), with its first line:
 * instructions and send-backs, the Coordinator's confirmation and answer, and a dialogue with it.
 */
function senderRows() {
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([
    { id: "L9", kind: "answer", at: "2026-09-24T16:00:00Z", by: "main", title: "1-Option1" },
    { id: "D8", kind: "dialogue", at: "2026-09-24T15:00:00Z", title: "Review results for the fictional catalog" },
    { id: "L6", kind: "confirm", at: "2026-09-24T13:00:00Z", by: "main", state: "done" },
    { id: "L5", kind: "request", at: "2026-09-24T12:30:00Z", by: "main", title: "Restore the sample caption", summary: "Restore the sample caption" },
    { id: "Q4", kind: "request", at: "2026-09-24T12:00:00Z", by: "main", title: "Finish the sample illustration", summary: "Finish the sample illustration\n\nReason" },
    { id: "Q3", kind: "request", at: "2026-09-24T11:00:00Z", by: "main", title: "Include the sample card", summary: "Include the sample card" },
    { id: "Q2", kind: "request", at: "2026-09-24T10:00:00Z", by: "human", title: "Fix the mark position", summary: "\n## Fix the mark position\n\nReason" },
    { id: "Q1", kind: "request", at: "2026-09-24T09:00:00Z", by: "human", title: "First instruction", summary: "# First instruction\n\nBody" }]) } }));
  const view = render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const words = Object.fromEntries([...document.querySelectorAll("[data-report-key]")]
    .map(row => [row.getAttribute("data-report-key"), `${said(row)} ${row.querySelector("[data-row-words]")?.textContent ?? ""}`]));
  // The rows themselves start the column; no "no reports yet" note stands above them.
  const note = document.querySelector("[data-report-feed]")!.firstElementChild?.tagName;
  const floor = document.querySelectorAll("[data-task-row], [data-files-row]").length;
  view.unmount();
  expect(note).toBe("OL");
  // The column ends with its oldest instruction: the task itself is Context, under the title.
  expect(floor).toBe(0);
  return words;
}

test("review instructions use the same row label as other instructions, with their sender named", async () => {
  await inEnglish();
  expect(senderRows()).toEqual({
    "request:Q1": "From You to Owner · Request First instruction",
    "request:Q2": "From You to Owner · Request Fix the mark position",
    "request:Q3": "From Coordinator to Owner · Request Include the sample card",
    "request:Q4": "From Coordinator to Owner · Request Finish the sample illustration",
    // The newest instruction stands open: its body says its words.
    "request:L5": "From Coordinator to Owner · Request ",
    "log:T1:L6": "From Coordinator to Owner · Review Set to Done",
    "dialogue:T1:D8": "From You to Coordinator · Message Review results for the fictional catalog",
    "log:T1:L9": "From Coordinator to Owner · Answer Option1",
  });

});

test("your words to the Coordinator open like any row whose words are its body, and read whole", async () => {
  await inEnglish();
  onTestFinished(() => useViewStore.setState(useViewStore.getInitialState()));
  const words = "Can the failure notice be read aloud?\nIt should also cover the card company's reason.";
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([
    { id: "D9", kind: "dialogue", at: "2026-09-24T15:00:00Z", title: words },
    { id: "Q1", kind: "request", at: "2026-09-24T09:00:00Z", by: "human", title: "First instruction", summary: "# First instruction\n\nBody" }]) } }));
  const view = render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  try {
    const row = document.querySelector('[data-report-key="dialogue:T1:D9"]')!;
    const head = row.querySelector<HTMLButtonElement>("article > div > button[aria-expanded]")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector("[data-row-words]")?.className).toContain("line-clamp-1");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(row.querySelector("[data-disclosure-body]")?.textContent).toContain("It should also cover the card company's reason.");
  } finally { view.unmount(); }
});

test("your words and the Coordinator's reply open each on their own, each its own address", async () => {
  await inEnglish();
  onTestFinished(() => useViewStore.setState(useViewStore.getInitialState()));
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([
    { id: "D9", kind: "dialogue", at: "2026-09-24T15:00:00Z", title: "Is the notice done?\nAnd the reason?", summary: "Yes, both." },
    { id: "Q1", kind: "request", at: "2026-09-24T09:00:00Z", by: "human", title: "First instruction", summary: "# First instruction\n\nBody" }]) } }));
  const view = render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  try {
    const head = (key: string) => document.querySelector<HTMLButtonElement>(`[data-report-key="${key}"] article > div > button[aria-expanded]`)!;
    const reply = head("dialogue:T1:D9:reply"), words = head("dialogue:T1:D9");
    const replyBefore = reply.getAttribute("aria-expanded");
    fireEvent.click(words);
    expect(words.getAttribute("aria-expanded")).toBe("true");
    expect(reply.getAttribute("aria-expanded")).toBe(replyBefore);
    expect(useViewStore.getState().event).toBe("dialogue:T1:D9");
    // The reply stands open until a report comes: pressed, it closes; pressed again, it opens and is the address.
    if (reply.getAttribute("aria-expanded") === "true") fireEvent.click(reply);
    fireEvent.click(reply);
    expect(reply.getAttribute("aria-expanded")).toBe("true");
    expect(useViewStore.getState().event).toBe("dialogue:T1:D9:reply");
    expect(words.getAttribute("aria-expanded")).toBe("true");
  } finally { view.unmount(); }
});

test("Context holds the task's facts and body; the column does not end with them, even with no other row", async () => {
  await inEnglish();
  const data = screenData(tree({ tasks: [dto()] }));
  const task = { ...data.tasks[0]!, values: valuesView({ goal: "Illustrate the sample catalog", policy: ["Keep the sample numbering stable"], notes: "User note\nSecond line" }) };
  const view = render(<TestWorkspace data={data}><ReportFeed task={task} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelectorAll("[data-report-feed] li")).toHaveLength(0);
  expect(screen.queryByText("User note")).toBeNull();
  view.unmount();
  render(<TestWorkspace data={data}><ContextPage task={task} onFollow={() => {}} /></TestWorkspace>);
  // The context is the text the server renders from the values, in the schema's order, drawn as Markdown; shipped headings read in the screen's language.
  expect(screen.getByRole("heading", { name: "Goal" })).toBeTruthy();
  expect(screen.getByText("Illustrate the sample catalog")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Policy" })).toBeTruthy();
  expect(screen.getByText("Keep the sample numbering stable")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Notes" })).toBeTruthy();
  expect(screen.getByText(/User note/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
});

test("until a report comes, the newest thing you or the Coordinator wrote stands open; the owner's report then takes its place", async () => {
  await inEnglish();
  onTestFinished(() => useViewStore.setState(useViewStore.getInitialState()));
  const runs = [run("R9", { state: "failed", reason: "exit", startedAt: "2026-09-24T11:15:00Z", endedAt: "2026-09-24T11:20:00Z" })];
  // Newer rows that are not words to read do not take the place: a dialogue of the user's words alone, a hold, a failed Run.
  const written = historyFixture([
    { id: "R9", kind: "error", at: "2026-09-24T11:20:00Z", title: "exit" },
    { id: "Lheld", kind: "changed", at: "2026-09-24T11:10:00Z", state: "held", by: "main", title: "On hold", summary: "Review later" },
    { id: "D3", kind: "dialogue", at: "2026-09-24T11:00:00Z", title: "Reviewed" },
    { id: "Q2", kind: "request", at: "2026-09-24T10:00:00Z", by: "main", title: "Next instruction", summary: "Next instruction\n\nDetails" },
    { id: "Q1", kind: "request", at: "2026-09-24T09:00:00Z", by: "human", title: "First instruction", summary: "First instruction" }]);
  const feed = (events: typeof written) => {
    const data = screenData(tree({ tasks: [dto({ body: "- ゴール: Illustrate the sample catalog" })], placements: [idle()], runs, history: { T1: events } }));
    return <TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>;
  };
  const expanded = (key: string) => document.querySelector(`[data-report-key="${key}"] button[aria-expanded]`)?.getAttribute("aria-expanded");
  const view = render(feed(written));
  expect(screen.queryByText("No reports yet")).toBeNull();
  expect(document.querySelector('[data-report-key="log:T1:Lheld"]')).not.toBeNull();
  expect(document.querySelector('[data-report-key="dialogue:T1:D3"]')).not.toBeNull();
  expect(document.querySelector('[data-report-key="run:R9:finished"]')).not.toBeNull();
  expect([expanded("request:Q2"), expanded("request:Q1")]).toEqual(["true", "false"]);
  // A row you opened stays as you left it; the untouched one folds when the owner's report comes in.
  fireEvent.click(document.querySelector('[data-report-key="request:Q1"] button[aria-expanded]')!);
  // The press also named Q1 as the URL's event; drop it, so only the press keeps Q1 open.
  act(() => useViewStore.getState().setEvent(null));
  view.rerender(feed([...historyFixture([{ id: "Lreport", kind: "comment", at: "2026-09-24T12:00:00Z", state: "doing",
    title: "Investigated", summary: "Result" }]), ...written]));
  expect([expanded("log:T1:Lreport"), expanded("request:Q2"), expanded("request:Q1")]).toEqual(["true", "false", "true"]);
});

test("no facts stand beside the column: they are on the Context page", async () => {
  await inEnglish();
  const data = screenData(tree({ tasks: [dto({ body: "- ゴール: Illustrate the sample catalog\n- 方針: Keep the sample numbering stable\n\n## 本文\nUser note" })] }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect(screen.queryByRole("heading", { name: "Approach" })).toBeNull();
  expect(screen.queryByText("Keep the sample numbering stable")).toBeNull();
});

test("a task without a goal still has its text on the Context page", async () => {
  await inEnglish();
  const data = screenData(tree({ tasks: [dto({ body: "Note only" })] }));
  render(<TestWorkspace data={data}><ContextPage task={data.tasks[0]!} onFollow={() => {}} /></TestWorkspace>);
  expect(screen.getByRole("heading", { name: "Notes" })).toBeTruthy();
  expect(screen.getByText("Note only")).toBeTruthy();
});

test("the failed run's row opens close for that run only", () => {
  const data = screenData(tree({ runs: [run("R1", { state: "needs_review", reason: "manager_lost", endedAt: at })],
    history: { T1: historyFixture([{ id: "R1", kind: "error", title: "manager_lost" }]) } }));
  useDialogStore.setState({ dialog: null });
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const row = document.querySelector('[data-report-key="run:R1:finished"]')! as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /Close|Close/ }));
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: "run", runId: "R1" });
});

const workingPlacement = (id: string) => ({ id, taskId: "T1", agentId: `A${id}`, profileKey: "codex", responsible: id === "P1",
  active: true, revision: 1, startedAt: at, endedAt: null, headRunId: id === "P1" ? "R1" : `R${id.slice(1)}`,
  runtime: { displayState: "running" as const, reason: null, sourceRunIds: [], runningCount: 1, queuedCount: 0,
    since: at, lastOutputAt: at, activityKind: null, toolName: null } });
const note = (text: string) => ({ at, kind: "tool_start" as const, toolName: "Bash", doing: null, note: { at, text }, context: null, steps: [] });

test("the working row heads the report column with the responsible person's time, words and model, the others one count", async () => {
  await inEnglish();
  const long = "Fixed the parser so a long note is read in full when the row is opened. ".repeat(4).trim();
  const data = screenData(tree({ placements: [workingPlacement("P1"), workingPlacement("P2"), workingPlacement("P3")], runs: [
    run("R9", { state: "succeeded", usage: { run: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 200 }, includesEarlier: false } }),
    run("R1", { state: "running", endedAt: null, modelId: "opus", effort: "high", activity: note(long) }),
    run("R2", { placementId: "P2", state: "running", endedAt: null, modelId: "gpt-6.1-sol", effort: "high", activity: note("member words") }),
    run("R3", { placementId: "P3", state: "running", endedAt: null })] }));
  useViewStore.getState().openTask("T1", { reader: true });
  useDialogStore.setState({ dialog: null });
  render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
  const row = document.querySelector<HTMLElement>("[data-working-row]")!;
  // The top of the column, above every report; the input's line no longer repeats it.
  expect(row.parentElement!.firstElementChild).toBe(row);
  expect(document.querySelector("[data-task-action-slot]")?.textContent ?? "").not.toContain(long.slice(0, 20));
  // Closed: the lead alone, their words in two lines with their model and the others' count under them.
  const people = () => [...row.querySelectorAll<HTMLElement>("[data-working-person]")];
  expect(people().map(person => person.dataset.workingPerson)).toEqual(["P1"]);
  const words = people()[0]!.querySelector<HTMLElement>("[data-working-note]")!;
  expect(words.textContent).toBe(long);
  expect(words.className).toContain("line-clamp-2");
  // Said in the colours of any History row not opened, its time as quiet as the rest of its head.
  expect(words.className).toContain("text-row-words");
  expect(row.querySelector("[data-rail-time]")?.className).toContain("text-soft");
  expect(people()[0]!.querySelector("[data-working-model]")?.textContent).toBe("opus(high)");
  expect(row.querySelector("[data-working-others]")?.textContent).toBe("+2 more");
  // Under the words, one work line says what the lead is at; tokens and stop are left to other places.
  expect(people()[0]!.querySelectorAll("[data-work-line]")).toHaveLength(1);
  expect(row.textContent).not.toMatch(/tokens|1\.2k/);
  expect(within(row).queryByRole("button", { name: /Stop/ })).toBeNull();
  const toggle = within(row).getByRole("button");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  // Open: the words whole, and each other person's words and model; the count is no longer needed.
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(words.className).not.toContain("line-clamp-2");
  // Opened, it stands out as an opened record does.
  expect(words.className).toContain("text-ink");
  expect(words.className).not.toContain("text-row-words");
  expect(people().map(person => person.dataset.workingPerson)).toEqual(["P1", "P2", "P3"]);
  expect(people()[1]!.textContent).toContain("member words");
  expect(people()[1]!.querySelector("[data-working-model]")?.textContent).toBe("gpt-6.1-sol(high)");
  expect(row.querySelector("[data-working-others]")).toBeNull();
  fireEvent.keyDown(toggle, { key: "Enter" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});

test("the working row keeps a selection of its words, opens on Space, and counts the others by person", async () => {
  await inEnglish();
  const data = screenData(tree({ placements: [workingPlacement("P1"), workingPlacement("P2")], runs: [
    run("R1", { state: "running", endedAt: null, activity: note("lead words") }),
    // Two moving Runs of one member are one person.
    run("R2", { placementId: "P2", state: "running", endedAt: null }),
    run("R3", { placementId: "P2", state: "queued", endedAt: null })] }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const row = document.querySelector<HTMLElement>("[data-working-row]")!;
  expect(row.querySelector("[data-working-others]")?.textContent).toBe("+1 more");
  const toggle = within(row).getByRole("button");
  const words = row.querySelector<HTMLElement>("[data-working-note]")!;
  const range = document.createRange();
  range.selectNodeContents(words);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  window.getSelection()!.removeAllRanges();
  fireEvent.keyDown(toggle, { key: " " });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

const placedOn = (id: string, taskId: string) => ({ ...workingPlacement(id), taskId, responsible: true, headRunId: null });
const minutesAgo = (minutes: number) => new Date(Date.parse(at) - minutes * 60_000).toISOString();

test("the working row goes on with the Tasks below at work, children before grandchildren, folded or not", async () => {
  await inEnglish();
  const followed: string[] = [];
  // A grandchild started last; at one depth the latest started comes first.
  const data = screenData(tree({ tasks: [dto(), dto({ id: "T2", parentId: "T1", title: "Child two" }), dto({ id: "T3", parentId: "T2", title: "Grandchild three" }),
    dto({ id: "T4", parentId: "T1", title: "Child four" })],
  placements: [workingPlacement("P1"), placedOn("P2", "T2"), placedOn("P3", "T3"), placedOn("P4", "T4")], runs: [
    run("R1", { state: "running", endedAt: null, activity: note("lead words") }),
    run("R2", { taskId: "T2", placementId: "P2", state: "running", endedAt: null, startedAt: minutesAgo(30) }),
    run("R3", { taskId: "T3", placementId: "P3", state: "running", endedAt: null, startedAt: minutesAgo(5) }),
    run("R4", { taskId: "T4", placementId: "P4", state: "running", endedAt: null, startedAt: minutesAgo(20), modelId: "opus", effort: "high" })] }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks.find(task => task.id === "T1")!} people={data.people} onFollow={id => followed.push(id)} /></TestWorkspace>);
  const row = document.querySelector<HTMLElement>("[data-working-row]")!;
  const lines = () => [...row.querySelectorAll<HTMLElement>("[data-child-work]")].map(line => line.dataset.childWork);
  // This Task's own people first, then the first Task below; the rest behind one toggle.
  expect(row.querySelector("[data-working-person]")).not.toBeNull();
  expect(lines()).toEqual(["T4"]);
  const more = row.querySelector<HTMLElement>("[data-working-more]")!;
  expect(more.textContent).toBe("2 more below");
  fireEvent.click(more);
  expect(lines()).toEqual(["T4", "T2", "T3"]);
  expect(row.querySelector('[data-child-work="T3"]')!.textContent).toContain("Nested subtask");
  expect(row.querySelector('[data-child-work="T4"] [data-child-work-model]')?.textContent).toBe("opus(high)");
  fireEvent.click(row.querySelector<HTMLElement>('[data-child-work="T2"]')!);
  await waitFor(() => expect(followed).toEqual(["T2"]));
});

test("opened, only the responsible person's steps are read and listed; everyone else's stay on their latest one's line", async () => {
  await inEnglish();
  const steps = (who: string) => [1, 2].map(n => ({ id: `${who}${n}`, at, tool: "Bash", kind: "command" as const, text: `${who} step ${n}`,
    more: 0, about: null, state: n === 2 ? "running" as const : "done" as const, result: null }));
  const asked: string[] = [];
  runSteps.of = async run => { asked.push(run); return listedSteps(steps("lead")); };
  const data = screenData(tree({ placements: [workingPlacement("P1"), workingPlacement("P2")], runs: [
    run("R1", { state: "running", endedAt: null, activity: { ...note("lead words"), steps: steps("lead"), stepsStarted: 2 } }),
    run("R2", { placementId: "P2", state: "running", endedAt: null, activity: { ...note("member words"), steps: steps("member"), stepsStarted: 2 } })] }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const lead = document.querySelector('[data-working-person="P1"]')!;
  expect(lead.querySelector("[data-work-line]")?.textContent).toContain("lead step 2");
  expect(asked).toEqual([]);
  fireEvent.click(document.querySelector<HTMLElement>("[data-working-here]")!);
  await waitFor(() => expect(lead.querySelector("[data-run-steps=open]")?.textContent).toContain("lead step 1"));
  expect(lead.querySelector("[data-work-line]")?.textContent).toContain("2 steps so far");
  expect(asked).toEqual(["R1"]);
  const member = document.querySelector('[data-working-person="P2"]')!;
  expect(member.querySelector("[data-run-steps]")).toBeNull();
  expect(member.querySelector("[data-work-line]")?.textContent).toContain("member step 2");
  expect(member.textContent).not.toContain("member step 1");
});

test("an opened list stays while the latest steps the activity carries are none, as long as the Run has taken steps", async () => {
  await inEnglish();
  runSteps.of = async () => listedSteps([{ id: "a", tool: "Bash", kind: "command", text: "pnpm test", state: "running" }]);
  const activity = (steps: number) => ({ ...note("lead words"), stepEvents: 1, stepsStarted: 1, steps: steps ? [{ id: "a", at, tool: "Bash", kind: "command" as const,
    text: "pnpm test", more: 0, about: null, state: "running" as const, result: null }] : [] });
  const data = (steps: number) => screenData(tree({ placements: [workingPlacement("P1")], runs: [
    run("R1", { state: "running", endedAt: null, activity: activity(steps) })] }));
  const first = data(1);
  const { rerender } = render(<TestWorkspace data={first}><ReportFeed task={first.tasks[0]!} people={first.people} onFollow={() => {}} /></TestWorkspace>);
  fireEvent.click(document.querySelector<HTMLElement>("[data-working-here]")!);
  await waitFor(() => expect(document.querySelector("[data-run-steps=open]")?.textContent).toContain("pnpm test"));
  // An unreadable line left the activity's latest steps empty; the Run's steps are still there to read.
  const after = data(0);
  rerender(<TestWorkspace data={after}><ReportFeed task={after.tasks[0]!} people={after.people} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelector("[data-run-steps=open]")?.textContent).toContain("pnpm test");
});

test("a working person who has run nothing yet says on the work line what they last did", async () => {
  await inEnglish();
  const data = screenData(tree({ placements: [workingPlacement("P1")], runs: [
    run("R1", { state: "running", endedAt: null, activity: { at, kind: "tool_start" as const, toolName: "Bash", doing: null, note: null, context: null, steps: [] } })] }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelector("[data-working-note]")).toBeNull();
  expect(document.querySelector("[data-work-line]")?.textContent).toContain("Bash");
});

test("a step taken after the screen's clock last ticked is still said, and no words leave no empty band", async () => {
  await inEnglish();
  const step = (activity: object | null) => screenData(tree({ placements: [workingPlacement("P1")],
    runs: [run("R1", { state: "running", endedAt: null, activity: activity as never })] }));
  const soon = { at: new Date(Date.now() + 20_000).toISOString(), kind: "tool_start" as const, toolName: "Bash", doing: null, note: null, context: null, steps: [] };
  const data = step(soon);
  const { unmount } = render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelector("[data-work-line]")?.textContent).toContain("Bash");
  unmount();
  const quiet = step(null);
  render(<TestWorkspace data={quiet}><ReportFeed task={quiet.tasks[0]!} people={quiet.people} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelector("[data-working-person]")).toBeTruthy();
  expect(document.querySelector("[data-working-note]")).toBeNull();
});

test("Context says no token count, however many a task's Runs used", async () => {
  await inEnglish();
  const data = screenData(tree({ placements: [workingPlacement("P1")], runs: [
    run("R9", { state: "succeeded", usage: { run: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 200 }, includesEarlier: false } }),
    run("R1", { state: "running", endedAt: null })] }));
  render(<TestWorkspace data={data}><TaskAbout task={data.tasks[0]!} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelector("[data-task-about]")?.textContent).not.toMatch(/token|1\.2k/i);
});

test("no working row while nothing runs", () => {
  const data = screenData(tree({ placements: [workingPlacement("P1")], runs: [run("R1", { state: "succeeded" }), run("R2", { state: "queued", startedAt: null, endedAt: null })] }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelector("[data-working-row]")).toBeNull();
});

test("an opened report aligns its description under its complete title and keeps a spaced image when closed", async () => {
  const task = dto({ files: [{ name: "my image.png", size: 8, revision: "rev1", at }] });
  const data = screenData(tree({ tasks: [task], placements: [idle()], history: { T1: historyFixture([{ id: "L2", kind: "comment",
    at: "2026-10-10T13:00:00Z", state: "doing",
    title: "A deliberately long first line. It remains the full authored headline even after the first sentence.",
    summary: "The body starts under the headline.\n\n![Image](my image.png)" }]) } }));
  useViewStore.setState(useViewStore.getInitialState());
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const headline = await screen.findByText(/A deliberately long first line/);
  const button = headline.closest("button")!;
  expect(headline.textContent).toContain("even after the first sentence");
  expect(button.className).toContain("focus-visible:outline-2");
  expect(button.closest("article")?.contains(screen.getByText("The body starts under the headline."))).toBe(true);
  fireEvent.click(button);
  expect(button.closest("article")?.querySelector("[data-disclosure-body]")?.getAttribute("inert")).toBe("");
  expect(button.querySelector("img")?.getAttribute("src")).toContain("my%20image.png");
});

test("a title-only report is shown once and remains plain text", () => {
  const report = "A full report in one line. It continues after the first sentence without an invented headline.";
  const data = screenData(tree({ tasks: [dto()], placements: [idle()],
    history: { T1: historyFixture([{ id: "L3", kind: "comment", state: "doing", title: report }]) } }));
  useViewStore.setState(useViewStore.getInitialState());
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  // Nothing under its words but who wrote it, which is what it opens to: though the newest report, it does not stand open. A row's weight says only what is yours to do.
  const words = screen.getByText(report);
  expect(words.className).toContain("font-normal");
  expect(words.closest("button")?.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getAllByText(report)).toHaveLength(1);
});

test("a Run keeps each decision and folds its earlier progress, without borrowing a nearby Run", () => {
  const events = historyFixture([
    { id: "A", kind: "comment", at: "2026-10-10T10:01:00Z", title: "Preparing", runId: "R1", author: { kind: "owner", profileKey: "codex" } },
    { id: "B", kind: "question", at: "2026-10-10T10:02:00Z", title: "Choose", runId: "R1", author: { kind: "owner", profileKey: "codex" } },
    { id: "C", kind: "comment", at: "2026-10-10T10:02:01Z", title: "Another Run", runId: "R2", author: { kind: "owner", profileKey: "codex" } },
  ]);
  const display = reportDisplay(events.map(event => reportEvent(event, () => null)));
  expect(display.rows.map(row => row.key)).toEqual(["log:T1:C", "log:T1:B"]);
  expect(display.targets.get("log:T1:A")).toBe("log:T1:B");
  expect(display.targets.get("log:T1:C")).toBe("log:T1:C");
});

test("an open question stands pinned by History's open, whoever's turn it is; only the one the user's turn waits on takes its colour", () => {
  const [older, newer, closed] = historyFixture([
    { id: "Q1", kind: "question", title: "Which one?", at: "2026-10-10T10:00:00Z" },
    { id: "Q2", kind: "question", title: "One more", at: "2026-10-10T11:00:00Z" },
    { id: "Q0", kind: "question", open: false, title: "Previous question", at: "2026-10-10T09:00:00Z" }]);
  // The ball names Q2: Q1 is open too, and stays pinned with its own choices, in the quiet colour.
  const turn = () => "Q2";
  expect(reportEvent(older!, turn)).toMatchObject({ pinned: true, question: "Q1", mark: { tone: "quiet" } });
  expect(reportEvent(newer!, turn)).toMatchObject({ pinned: true, question: "Q2", mark: { tone: "turn" } });
  // A closed question is not pinned and offers no choices, even while a ball not yet read again still names it.
  const shut = reportEvent(closed!, () => "Q0");
  expect(shut.pinned).toBeUndefined(); expect(shut.question).toBeUndefined();
});

test("the choices drawn are those of the question the record is, by its ID; a question asked of the parent offers none", () => {
  const data = screenData(tree({ tasks: [taskFixture({ state: "doing", ball: userBall("question", "Q1", at, { questionId: "Q1" }) })],
    questions: [questionFixture({ id: "Q1", decide: [decideItem("Storage location", [["OptionA", "Local"], ["OptionB", "Shared"]])] }),
      questionFixture({ id: "Q2", decide: [decideItem("Color", [["OptionC", "Blue"], ["OptionD", "Red"]])] }),
      questionFixture({ id: "Q3", destination: { kind: "task", taskId: "T2" }, decide: [decideItem("Approach", [["OptionE", "Hurry"]])] })] }));
  const shown = (question: string) => {
    const { unmount } = render(<TestWorkspace data={data}><WaitingReportActions task={data.tasks[0]!} question={question} onFollow={() => {}} /></TestWorkspace>);
    const names = [...document.querySelectorAll("[data-waiting-report-actions] [role=group] button")].map(button => button.textContent);
    unmount();
    return names;
  };
  // Each question's own choices, then Other.
  expect(shown("Q2")).toEqual(["OptionC", "OptionD", "Other"]);
  expect(shown("Q1")).toEqual(["OptionA", "OptionB", "Other"]);
  expect(shown("Q3")).toEqual([]);
  expect(document.querySelector("[data-waiting-report-actions]")).toBeNull();
});

// Each question ends with Other (or is answered by writing); Recommended sits on its own button with why under it.
test("each question ends with Other, or Write an answer when it has no choices; no Stop unless it offers one; Recommended sits in its button, with why under its choice", () => {
  const data = screenData(tree({ tasks: [taskFixture({ state: "doing", ball: userBall("question", "Q1", at, { questionId: "Q1" }) })],
    questions: [questionFixture({ id: "Q1", decide: [decideItem("Storage location", [["OptionA", "Local"], ["OptionB", "Shared", "Everyone reads it"]],
      { decide_note: "Both keep a copy" }), decideItem("Anything else")] })] }));
  render(<TestWorkspace data={data}><WaitingReportActions task={data.tasks[0]!} question="Q1" onFollow={() => {}} /></TestWorkspace>);
  const names = (n: string) => [...document.querySelectorAll(`[data-question="${n}"] [role=group] button`)].map(button => button.textContent);
  expect(names("1")).toEqual(["OptionA", "OptionBRecommended", "Other"]);
  expect(names("2")).toEqual(["Write an answer"]);
  expect(document.querySelector('[data-question="2"]')?.hasAttribute("data-written")).toBe(true);
  expect(document.querySelector("[data-recommended]")?.closest("button")?.textContent).toContain("OptionB");
  // Why it is recommended reads once, under its own choice (the structure's reason, not a line of the note).
  const why = [...document.querySelectorAll<HTMLElement>("[data-recommended-why]")];
  expect(why.map(each => each.textContent)).toEqual(["Everyone reads it"]);
  expect(within(why[0]!.parentElement!).getByRole("button").textContent).toBe("OptionBRecommended");
  // The note reads as written, after the choices.
  const note = within(document.querySelector<HTMLElement>('[data-question="1"]')!).getByText("Both keep a copy");
  expect(note.compareDocumentPosition(document.querySelector('[data-question="1"] [role=group]')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  expect(document.querySelector("[data-waiting-report-actions]")?.textContent).not.toMatch(/Stop|中止/);
});

test("a question that says what stopping means offers Stop after its choices, answered `<n>-stop`; Other is answered `<n>-other`", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(snapshotJson({
    id: "report-stop", nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false, cancelled: [], turns: [],
  })));
  onTestFinished(() => { fetcher.mockRestore(); setConversationState(useConversation.getInitialState()); });
  const data = screenData(tree({ tasks: [taskFixture({ state: "doing", ball: userBall("question", "Q1", at, { questionId: "Q1" }) })],
    questions: [questionFixture({ id: "Q1", decide: [decideItem("Storage location", [["OptionA", "Local"]], { decide_stop: "Nothing is stored and the task ends" }),
      decideItem("Color", [["Blue"]])] })] }));
  render(<TestWorkspace data={data}><WaitingReportActions task={data.tasks[0]!} question="Q1" onFollow={() => {}} /></TestWorkspace>);
  const group = (n: string) => document.querySelector<HTMLElement>(`[data-question="${n}"] [role=group]`)!;
  const names = (n: string) => within(group(n)).getAllByRole("button").map(button => button.textContent);
  // Stop stands between the question's own choices and Other, only where the question offers it.
  expect(names("1")).toEqual(["OptionA", "Stop", "Other"]);
  expect(names("2")).toEqual(["Blue", "Other"]);
  const stop = within(group("1")).getByRole("button", { name: /^Stop/ });
  // It is marked as stopping the task, and what stopping means here reads under it.
  expect(stop.querySelector('[aria-label="Stops the task if chosen"]')).toBeTruthy();
  expect(stop.parentElement!.textContent).toContain("Nothing is stored and the task ends");
  expect(document.querySelector("[data-recommended]")).toBeNull();
  const answers = () => {
    const entry = Object.values(useDraftStore.getState().entries).find(each => each.values.doc?.includes("answerLabel"));
    return entry ? answersIn(documentSchema.parse(JSON.parse(entry.values.doc!)), "T1") : [];
  };
  fireEvent.click(stop);
  await waitFor(() => expect(answers()).toEqual([{ question: "Q1", task: "T1", n: "1", name: "Stop", answer: "1-stop" }]));
  expect(stop.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(group("2")).getByRole("button", { name: "Other" }));
  await waitFor(() => expect(answers().map(answer => answer.answer)).toEqual(["1-stop", "2-other"]));
});

test("a question's choice, read from what was fixed when it was asked, goes into the instruction composer naming that question", async () => {
  // Choosing also opens the real composer, whose focus handoff reads its conversation.
  // Supply that boundary; a relative URL cannot reach a server in jsdom.
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(snapshotJson({
    id: "report-choice", nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false, cancelled: [], turns: [],
  })));
  onTestFinished(() => { fetcher.mockRestore(); setConversationState(useConversation.getInitialState()); });
  // T1 asks the user L2; its values say something else now, but the choices are those fixed when it asked.
  const asking = taskFixture({ state: "doing", values: { notes: "## 問い\n### 1 Rewritten question\n#### OptionX\nAnother option" },
    log: [logEntry({ id: "L2", kind: "asked", askedTo: null, title: "Choose an option", description: "Which one?", actor: { kind: "placement", placementId: "P1" } })],
    ball: userBall("question", "L2", at, { questionId: "L2" }) });
  const data = screenData(tree({ tasks: [asking], questions: [questionFixture({ id: "L2", title: "Choose an option",
    decide: [decideItem("Which one?", [["OptionA", "Proceed"], ["OptionB", "Restore"]])] })] }));
  render(<TestWorkspace data={data}><WaitingReportActions task={data.tasks[0]!} question="L2" onFollow={() => {}} /></TestWorkspace>);
  expect(screen.queryByRole("button", { name: "OptionX" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "OptionA" }));
  const drafted = () => Object.values(useDraftStore.getState().entries).find(entry => entry.values.doc?.includes("1-OptionA"));
  await waitFor(() => expect(drafted()).toBeTruthy());
  expect(answersIn(documentSchema.parse(JSON.parse(drafted()!.values.doc!)), "T1"))
    .toEqual([{ question: "L2", task: "T1", n: "1", name: "OptionA", answer: "1-OptionA" }]);
  await waitFor(() => expect(useConversation.getState().conversation?.id).toBe("report-choice"));
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]![0]).toBe("/api/coordinator");
});

// Two open questions of one Task both have a first question with OptionA; choosing one is not choosing the other.
test("the same choice of two open questions of a Task is chosen, shown chosen and kept apart by the question it answers", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(snapshotJson({
    id: "two-questions", nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false, cancelled: [], turns: [],
  })));
  onTestFinished(() => { fetcher.mockRestore(); setConversationState(useConversation.getInitialState()); });
  const data = screenData(tree({ tasks: [taskFixture({ state: "doing", ball: userBall("question", "Q2", at, { questionId: "Q2" }) })],
    questions: [questionFixture({ id: "Q1", decide: [decideItem("Storage location", [["OptionA", "Local"], ["OptionB", "Shared"]])] }),
      questionFixture({ id: "Q2", decide: [decideItem("Color", [["OptionA", "Blue"], ["OptionB", "Red"]])] })] }));
  render(<TestWorkspace data={data}>{["Q1", "Q2"].map(question => <div key={question} data-for={question}>
    <WaitingReportActions task={data.tasks[0]!} question={question} onFollow={() => {}} /></div>)}</TestWorkspace>);
  const choice = (question: string) => document.querySelector<HTMLButtonElement>(`[data-for="${question}"] [role=group] button`)!;
  const answers = () => {
    const entry = Object.values(useDraftStore.getState().entries).find(each => each.values.doc?.includes("1-OptionA"));
    return entry ? answersIn(documentSchema.parse(JSON.parse(entry.values.doc!)), "T1").map(answer => answer.question) : [];
  };
  fireEvent.click(choice("Q1"));
  await waitFor(() => expect(answers()).toEqual(["Q1"]));
  expect(choice("Q1").getAttribute("aria-pressed")).toBe("true");
  expect(choice("Q2").getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(choice("Q2"));
  await waitFor(() => expect(answers()).toEqual(["Q1", "Q2"]));
  expect(choice("Q1").getAttribute("aria-pressed")).toBe("true");
  expect(choice("Q2").getAttribute("aria-pressed")).toBe("true");
});

test("a waiting report with an estimate uses its saved title, description and log ID once", () => {
  const saved = logEntry({ id: "Lestimate", kind: "reported", toState: "waiting",
    title: "Ready for review", description: "The work and checks are complete.", estimateMinutes: 1,
    actor: { kind: "placement", placementId: "P1" } });
  const task = dto({ state: "waiting", log: [saved] });
  const placement = { id: "P1", taskId: "T1", agentId: "A1", profileKey: "codex", responsible: true,
    active: true, revision: 1, startedAt: at, endedAt: null, headRunId: "R1", runtime: {
      displayState: "idle" as const, reason: null, sourceRunIds: [], runningCount: 0, queuedCount: 0,
      since: null, lastOutputAt: null, activityKind: null, toolName: null } };
  const data = screenData(tree({ tasks: [task], placements: [placement],
    balls: { T1: userBall("review", saved.id, saved.at, { aboutRunId: "R1" }) }, runs: [run("R1")],
    history: { T1: historyFixture([{ id: "Lestimate", kind: "review", at: saved.at, state: "waiting", title: "Ready for review",
      summary: "The work and checks are complete." }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const report = document.querySelector('[data-report-key="log:T1:Lestimate"]')!;
  expect(report).toBeTruthy();
  expect(report.textContent).toContain("Ready for review");
  expect(report.textContent).toContain("The work and checks are complete.");
  // A review with no questions is discussed in the coordinator; its report has no choice buttons.
  expect(report.querySelector("[data-waiting-report-actions]")).toBeNull();
  // The turn it waits on is the report itself: no row is made up for it.
  expect(document.querySelectorAll("[data-report-key]")).toHaveLength(1);
});

test("an unavailable responsible seat asks to check both placement and launch settings", async () => {
  await inEnglish();
  render(<TurnReason turn={reasonedTurn(userBall("blocked", "B1", at, { code: "responsible_missing" }))!} />);
  const text = screen.getByText(/Could not start the request to the owner/).textContent ?? "";
  expect(text).toContain("owner assignment");
  expect(text).toContain("launch profile");
  expect(text).toContain("resend the instruction");
});

test("the title and its tabs stay on every pane: History, Context and Files, the one shown marked; each opens as a step Back comes back from", async () => {
  await inEnglish();
  const title = "The task's own title";
  const data = screenData(tree({ tasks: [dto({ title, files: [{ name: "a.png", size: 8, revision: "rev1", at }, { name: "b.md", size: 8, revision: "rev2", at }] })] }));
  useViewStore.setState(useViewStore.getInitialState());
  useViewStore.getState().openTask("T1", { reader: true });
  render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
  const header = document.querySelector<HTMLElement>(".reader-header")!;
  expect(within(header).queryByRole("button", { name: /Context|Files/ })).toBeNull();
  const content = document.querySelector<HTMLElement>("[data-reader-content]")!;
  // The reports end with no floor of their own.
  expect(content.querySelectorAll("[data-task-row], [data-files-row]")).toHaveLength(0);
  const entries = await waitFor(() => {
    const found = [...content.querySelectorAll<HTMLElement>("[data-head-title] [data-reader-entries] button")];
    expect(found.map(button => button.textContent)).toEqual(["History", "Context", "Files2"]);
    return found;
  });
  expect(entries[0]!.getAttribute("aria-current")).toBe("page");
  fireEvent.click(entries[1]!);
  expect(useViewStore.getState().reader.pane).toBe("about");
  await waitFor(() => expect(document.querySelector("[data-task-about]")).not.toBeNull());
  // The head writes no title on a page either.
  expect(header.textContent).not.toContain(title);
  fireEvent.click(within(header).getByRole("button", { name: "Back" }));
  expect(useViewStore.getState().reader.pane).toBe("task");
  fireEvent.click(await waitFor(() => content.querySelector<HTMLElement>('[data-reader-entry="files"]')!));
  expect(useViewStore.getState().reader.pane).toBe("files");
  // The title and the tabs stay, the files marked; History goes back to the reports.
  expect(content.querySelector("[data-head-title] h2")!.textContent).toBe(title);
  expect(content.querySelector('[data-reader-entry="files"]')!.getAttribute("aria-current")).toBe("page");
  expect(header.textContent).not.toContain(title);
  fireEvent.click(content.querySelector<HTMLElement>('[data-reader-entry="task"]')!);
  expect(useViewStore.getState().reader.pane).toBe("task");
});

test("the reading column owns the title; the working row shows progress without a stop control", async () => {
  await inEnglish();
  const task = dto({ title: "A task to check that a long title spanning several lines scrolls together with its body" });
  const placement = { id: "P1", taskId: "T1", agentId: "A1", profileKey: "codex", responsible: true,
    active: true, revision: 1, startedAt: at, endedAt: null, headRunId: "R1",
    runtime: { displayState: "running" as const, reason: null, sourceRunIds: ["R1"], runningCount: 1, queuedCount: 0,
      since: at, lastOutputAt: at, activityKind: null, toolName: null } };
  const data = screenData(tree({ tasks: [task], placements: [placement], runs: [run("R1", { state: "running", endedAt: null })] }));
  useViewStore.setState(useViewStore.getInitialState());
  useViewStore.getState().openTask("T1", { reader: true });
  render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
  const header = document.querySelector<HTMLElement>(".reader-header")!;
  const content = document.querySelector<HTMLElement>("[data-reader-content]")!;
  expect(within(content).getByText(task.title)).toBeTruthy();
  expect(header.textContent).not.toContain(task.title);
  expect(within(header).queryByRole("button", { name: "Context" })).toBeNull();
  const row = content.querySelector<HTMLElement>("[data-working-row]")!;
  fireEvent.click(within(row).getByRole("button"));
  expect(within(row).queryByRole("button", { name: "Stop…" })).toBeNull();
  // Nor anywhere else on the reader (its corner of moves shows only while a review is awaited).
  expect(within(header).queryByRole("button", { name: "Stop…" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop…" })).toBeNull();
});

test("Context starts with the task's facts, without a heading that repeats the entry's name", async () => {
  await inEnglish();
  const data = screenData(tree({ tasks: [dto()] }));
  render(<TestWorkspace data={data}><TaskAbout task={{ ...data.tasks[0]!, values: valuesView({ goal: "Illustrate the sample catalog" }) }} onFollow={() => {}} /></TestWorkspace>);
  expect(screen.queryByRole("heading", { name: "Context" })).toBeNull();
  expect(document.querySelector("[data-task-context]")?.textContent).toMatch(/^GoalIllustrate the sample catalog/);
});

test("Context opens with when the task was created and last changed, not who asked for it", async () => {
  await inEnglish();
  const data = screenData(tree({ tasks: [dto({ userRequested: true })], requestedByUser: { T1: { at: "2026-09-24T09:00:00Z" } } }));
  const task = data.tasks[0]!;
  const { unmount } = render(<TestWorkspace data={data}><TaskAbout task={{ ...task, createdAt: "2026-09-24T09:00:00Z", updatedAt: "2026-09-25T10:30:00Z" }} onFollow={() => {}} /></TestWorkspace>);
  const dates = document.querySelector("[data-task-dates]")!;
  expect(document.querySelector("[data-task-about]")?.firstElementChild).toBe(dates);
  expect(dates.textContent).toMatch(/^Created .*\d\d:\d\d · Updated .*\d\d:\d\d$/);
  expect(document.querySelector("[data-task-created]")?.getAttribute("datetime")).toBe("2026-09-24T09:00:00Z");
  expect(document.querySelector("[data-task-updated]")?.getAttribute("datetime")).toBe("2026-09-25T10:30:00Z");
  expect(document.querySelector("[data-task-about]")?.textContent).not.toContain("Your request");
  unmount();
  render(<TestWorkspace data={data}><TaskAbout task={{ ...task, createdAt: "2026-09-24T09:00:00Z", updatedAt: "2026-09-24T09:00:00Z" }} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelector("[data-task-dates]")?.textContent).toMatch(/^Created .*\d\d:\d\d$/);
  expect(document.querySelector("[data-task-updated]")).toBeNull();
});

test("Context does not list a parent's children: the task tree does", async () => {
  await inEnglish();
  const data = screenData(tree({ tasks: [dto({ userRequested: true }), dto({ id: "T2", parentId: "T1", title: "A child" })],
    children: { T1: { live: 1, finished: 0, states: { todo: 1, doing: 0, error: 0, waiting: 0, held: 0, done: 0, stopped: 0 }, runningBelow: 0, below: 1 } } }));
  render(<TestWorkspace data={data}><TaskAbout task={data.tasks.find(task => task.id === "T1")!} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelector("[data-task-about]")?.textContent).not.toContain("A child");
  expect(document.querySelector("[data-task-about]")?.textContent).not.toContain("Children");
});

test("Context says one time while the two would read the same, and no line without a time; the empty note keeps its gap", async () => {
  await inEnglish();
  const data = screenData(tree({}));
  const task = data.tasks[0]!;
  const about = (dates: Partial<typeof task>) => render(<TestWorkspace data={data}><TaskAbout task={{ ...task, values: { ...task.values, values: {}, context: "" }, ...dates }} onFollow={() => {}} /></TestWorkspace>);
  const sameMinute = about({ createdAt: "2026-09-24T09:00:01Z", updatedAt: "2026-09-24T09:00:40Z" });
  expect(document.querySelector("[data-task-dates]")?.textContent).toMatch(/^Created .*\d\d:\d\d$/);
  expect(document.querySelector("[data-task-updated]")).toBeNull();
  expect(screen.getByText("No body yet.").closest("[data-message]")!.className).toContain("mt-type-section");
  sameMinute.unmount();
  const onlyLatest = about({ createdAt: null, updatedAt: "2026-09-24T09:00:40Z" });
  expect(document.querySelector("[data-task-dates]")?.textContent).toMatch(/^Updated .*\d\d:\d\d$/);
  onlyLatest.unmount();
  about({ createdAt: null, updatedAt: "" });
  expect(document.querySelector("[data-task-dates]")).toBeNull();
});

test("the column draws only History's records: the user's turn on the task or on a child below adds no row of its own", () => {
  // T1 stopped at its automatic limit; its child T2 asks the user a question. Neither has a record in T1's History yet.
  const data = screenData(tree({ tasks: [
    taskFixture({ state: "doing", ball: userBall("limit", "W1", at, { count: 3 }) }),
    taskFixture({ id: "T2", parentId: "T1", state: "doing", ball: userBall("question", "L9", at, { questionId: "L9" }) })] }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks.find(task => task.id === "T1")!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelectorAll("[data-report-key]")).toHaveLength(0);
  // Nobody runs here or below, so the working row is not drawn either: the column is empty.
  expect(document.querySelectorAll("[data-report-feed] li")).toHaveLength(0);
});

/** A log entry as a test writes it, with its ID and time; History's event of it carries both. */
type LogInput = NonNullable<Parameters<typeof logEntry>[0]> & { id: string; at: string };
type EventInput = Parameters<typeof historyFixture>[0][number];
/**
 * A task's own records from created to `end` (each with its event in History), with a responsible P1 who reported
 * for review at 11:00.
 */
function finishing(state: "done" | "doing" | "stopped", end: { record: LogInput; event?: Omit<EventInput, "id" | "at"> }[]) {
  const owner = { kind: "placement" as const, placementId: "P1" };
  const task = dto({ state, log: [
    logEntry({ id: "L1", kind: "created", at: "2026-10-10T10:00:00Z", toState: "todo" }),
    logEntry({ id: "L2", kind: "reported", at: "2026-10-10T11:00:00Z", actor: owner, fromState: "doing", toState: "waiting",
      title: "Please review" }),
    ...end.map(each => logEntry(each.record)),
  ] });
  const events = historyFixture([...end.flatMap(({ record, event }) => event ? [{ ...event, id: record.id, at: record.at }] : []).reverse(),
    { id: "L2", kind: "review", at: "2026-10-10T11:00:00Z", state: "waiting", title: "Please review" }]);
  return screenData(tree({ tasks: [task], placements: [idle()], balls: {}, history: { T1: events } }));
}
/** The done check (the list's state icon) on the strip and on the feed's rail, by event key. */
function doneChecks(data: ReturnType<typeof finishing>) {
  const history = projectTimeHistory(timeHistoryBase(data.tasks[0]!, data.people, recordNotes(data.people, (data.tasks[0]!).id)), Date.parse("2026-10-10T13:00:00Z"));
  const strip = laneMarks(history).filter(mark => compactMark(mark.event)?.kind === "approve" && compactMark(mark.event)?.tone === "done")
    .map(mark => mark.event.key);
  const view = render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const rail = [...document.querySelectorAll("[data-report-key]")].filter(row => row.querySelector("[data-icon='done']"))
    .map(row => row.getAttribute("data-report-key"));
  const words = Object.fromEntries([...document.querySelectorAll("[data-report-key]")].map(row => [row.getAttribute("data-report-key"), row.textContent]));
  view.unmount();
  return { strip, rail, words, last: laneMarks(history).at(-1)?.event.key };
}
/** The user's confirmation: History's confirm, setting done. */
const approve = { record: { id: "L3", kind: "review_approved" as const, at: "2026-10-10T11:30:00Z", fromState: "waiting" as const, toState: "done" as const },
  event: { kind: "confirm" as const, state: "done" as const, by: "human" as const } };

test("an approved task ends its line and its feed's Approved with the same done check", async () => {
  await inEnglish();
  const checks = doneChecks(finishing("done", [approve]));
  expect(checks.strip).toEqual(["log:T1:L3"]);
  expect(checks.last).toBe("log:T1:L3");
  expect(checks.rail).toEqual(["log:T1:L3"]);
  expect(checks.words["log:T1:L3"]).toContain("Set to Done");
});

test("a task finished by hand without a review gets the same check, on a row that says so", async () => {
  await inEnglish();
  const checks = doneChecks(finishing("done", [{ record: { id: "L3", kind: "reported", at: "2026-10-10T11:30:00Z", fromState: "waiting", toState: "done" },
    event: { kind: "report", state: "done", by: "human" } }]));
  expect(checks.strip).toEqual(["log:T1:L3"]);
  expect(checks.rail).toEqual(["log:T1:L3"]);
  expect(checks.words["log:T1:L3"]).toContain("Set to Done");
});

test("a finished task sent back to work keeps its Approved row but not the check; finishing again checks only the new one", () => {
  // The Request it accepted is History's row; a reopening without one adds none.
  const reopen = { record: { id: "L4", kind: "request_accepted" as const, at: "2026-10-10T12:00:00Z", fromState: "done" as const, toState: "doing" as const } };
  const reopened = doneChecks(finishing("doing", [approve, reopen]));
  expect(reopened.strip).toEqual([]);
  expect(reopened.rail).toEqual([]);
  expect(reopened.words["log:T1:L3"]).toBeTruthy();
  const again = doneChecks(finishing("done", [approve, reopen,
    { record: { id: "L5", kind: "review_approved", at: "2026-10-10T12:30:00Z", fromState: "doing", toState: "done" },
      event: { kind: "confirm", state: "done", by: "human" } }]));
  expect(again.strip).toEqual(["log:T1:L5"]);
  expect(again.rail).toEqual(["log:T1:L5"]);
});

test("a stopped or sent-back task draws no done check", () => {
  expect(doneChecks(finishing("stopped", [{ record: { id: "L3", kind: "reported", at: "2026-10-10T11:30:00Z", fromState: "waiting", toState: "stopped" },
    event: { kind: "report", state: "stopped", by: "human" } }]))).toMatchObject({ strip: [], rail: [] });
  expect(doneChecks(finishing("doing", [{ record: { id: "L3", kind: "review_sent_back", at: "2026-10-10T11:30:00Z", fromState: "waiting", toState: "doing" },
    event: { kind: "request", state: null, by: "human" } }]))).toMatchObject({ strip: [], rail: [] });
});


test("an answer whose question is not loaded opens its complete fixed text as Markdown", async () => {
  await inEnglish();
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([
    { id: "Acomplete", kind: "answer", by: "human", answers: "Qnotloaded", title: "Choose A", summary: "Short summary",
      answerText: "## Full answer\n\n**Keep all of these words.**" }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const row = document.querySelector('[data-report-key="log:T1:Acomplete"]')!;
  expect(within(row as HTMLElement).getByText("Keep all of these words.").tagName).toBe("STRONG");
  expect(row.textContent).not.toContain("Short summary");
});

test('a thin child row names its child 子 closed, by its ID and title in the tag\'s label, and by its ID open', async () => {
  await inEnglish();
  const data = screenData(tree({ tasks: [dto(), dto({ id: 'T2', parentId: 'T1', title: 'The child' })], history: { T1: historyFixture([
    { id: 'Lthin', kind: 'changed', taskId: 'T2', fromChild: true, by: 'human', title: 'Renamed child' },
  ]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const row = document.querySelector('[data-report-key="log:T2:Lthin"]')!;
  const closed = row.querySelector<HTMLElement>('[data-row-ends] [data-row-end="child"]')!;
  expect(closed.querySelector('[data-row-task]')).toBeNull();
  expect(closed.querySelector('[data-row-party]')?.textContent).toBe("Subtask");
  expect(closed.title).toBe('T2 The child');
  expect(row.querySelector('[data-row-ends]')?.textContent).not.toContain('The child');
  expect(row.querySelector('[data-row-said]')?.textContent).toContain('The child');
  fireEvent.click(row.querySelector('button[aria-expanded]')!);
  const tag = row.querySelector<HTMLElement>('[data-row-parties] [data-row-open][data-task-reference="T2"]')!;
  expect(tag.textContent).toContain('T2');
  expect(tag.textContent).not.toContain('The child');
  expect(tag.getAttribute('aria-label')).toContain('The child');
});

test("a timeline over several days heads each day but today with a divider, its rows saying their clock alone; when the day turns, it heads the day just past", async () => {
  const was = i18n.language;
  await i18n.changeLanguage("ja");
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  onTestFinished(async () => { vi.useRealTimers(); await i18n.changeLanguage(was); });
  // Local times, so the reader's calendar day holds in any time zone.
  const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
  vi.setSystemTime(new Date(2026, 9, 27, 3, 0));
  const events = historyFixture([
    { id: "L4", kind: "comment", at: local(27, 2, 1), title: "Today's" },
    { id: "L3", kind: "comment", at: local(26, 23, 24), title: "Yesterday's late" },
    { id: "L2", kind: "comment", at: local(26, 0, 19), title: "Yesterday's early" },
    { id: "L1", kind: "comment", at: local(25, 9, 5), title: "The day before" },
  ]);
  const base = screenData(tree({ tasks: [dto()] }));
  const key = resources.history(base.info.root, "T1").queryKey;
  const data = { ...base, seed: () => { base.seed(); queryClient.setQueryData(key, { pages: [{ events, nextBefore: null }], pageParams: [null] }); } };
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const days = () => [...document.querySelectorAll("[data-day]")].map(day => ({
    head: day.querySelector("[data-day-head]")?.textContent ?? null,
    rows: [...day.querySelectorAll("[data-report-key] [data-rail-time]")].map(time => time.textContent),
  }));
  expect(days()).toEqual([
    { head: null, rows: ["02:01"] },
    { head: "昨日 10/26（月）", rows: ["23:24", "00:19"] },
    { head: "10/25（日）", rows: ["09:05"] },
  ]);
  // A divider is the list motion's item placed by its day, and stays sticky inside its own day's rows.
  const head = document.querySelector("[data-day-head]")!;
  expect(head.hasAttribute("data-motion-sticky")).toBe(true);
  expect(head.parentElement!.hasAttribute("data-day")).toBe(true);
  // Past midnight, the shared clock's next tick heads the day just past and names the days anew; its rows keep their clock.
  act(() => { vi.setSystemTime(new Date(2026, 9, 28, 0, 0, 10)); vi.advanceTimersByTime(30_000); });
  expect(days()).toEqual([
    { head: "昨日 10/27（火）", rows: ["02:01"] },
    { head: "10/26（月）", rows: ["23:24", "00:19"] },
    { head: "10/25（日）", rows: ["09:05"] },
  ]);
});

test("a timeline of today only draws no day divider", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => { vi.useRealTimers(); });
  vi.setSystemTime(new Date(2026, 9, 27, 23, 0));
  const events = historyFixture([
    { id: "L2", kind: "comment", at: new Date(2026, 9, 27, 22, 10).toISOString(), title: "Late" },
    { id: "L1", kind: "comment", at: new Date(2026, 9, 27, 0, 5).toISOString(), title: "Early" },
  ]);
  const base = screenData(tree({ tasks: [dto()] }));
  const key = resources.history(base.info.root, "T1").queryKey;
  const data = { ...base, seed: () => { base.seed(); queryClient.setQueryData(key, { pages: [{ events, nextBefore: null }], pageParams: [null] }); } };
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelectorAll("[data-report-key] [data-rail-time]")).toHaveLength(2);
  expect(document.querySelector("[data-day-head]")).toBeNull();
});

test("a time stands under its day: the clock alone on that day, else with its own day's name from today, the year only when it differs", async () => {
  const { dayClock, dayHeading } = await import("../src/domain/day-clock");
  const t = i18n.getFixedT("ja", "people");
  const now = new Date(2026, 9, 27, 3, 0).getTime();
  const local = (year: number, month: number, day: number, hour = 2, minute = 1) => new Date(year, month - 1, day, hour, minute).getTime();
  // Under today, as the lists say it.
  expect([local(2026, 10, 27), local(2026, 10, 26), local(2026, 10, 28), local(2026, 10, 25), local(2025, 12, 31)].map(at => dayClock(at, now, t, "ja")))
    .toEqual(["02:01", "昨日 02:01", "明日 02:01", "10/25 02:01", "2025/12/31 02:01"]);
  // Under yesterday's divider: its own day is the clock alone, today's says so.
  const yesterday = local(2026, 10, 26, 0, 0);
  expect([local(2026, 10, 26, 23, 28), local(2026, 10, 27), local(2026, 10, 25)].map(at => dayClock(at, now, t, "ja", yesterday)))
    .toEqual(["23:28", "今日 02:01", "10/25 02:01"]);
  expect(dayHeading(local(2025, 12, 31), now, t, "ja")).toEqual({ name: null, date: "2025/12/31（水）" });
  expect(dayHeading(local(2026, 10, 26), now, i18n.getFixedT("en", "people"), "en")).toEqual({ name: "Yesterday", date: "Mon 10/26" });
});

test("in English a time alone starts with a capital, while inside a sentence its day word stays lowercase", async () => {
  const { dayClock, dayClockLabel } = await import("../src/domain/day-clock");
  const en = i18n.getFixedT("en", "people");
  const now = new Date(2026, 9, 27, 3, 0).getTime();
  const tomorrow = new Date(2026, 9, 28, 1, 20).getTime();
  expect(dayClockLabel(tomorrow, now, en, "en")).toBe("Tomorrow 01:20");
  expect(dayClock(tomorrow, now, en, "en")).toBe("tomorrow 01:20");
  expect(en("finish.end", { time: dayClock(tomorrow, now, en, "en") })).toBe("Expected report tomorrow 01:20");
  expect(dayClockLabel(tomorrow, now, i18n.getFixedT("ja", "people"), "ja")).toBe("明日 01:20");
  // After a "·" the time is a label too, never "answered at yesterday 16:51".
  const reader = i18n.getFixedT("en", "reader"), yesterday = new Date(2026, 9, 26, 16, 51).getTime();
  expect(reader("reportFeed.row.end.answered", { who: "You", at: dayClockLabel(yesterday, now, en, "en") })).toBe("You answered · Yesterday 16:51");
  expect(reader("reportFeed.row.end.confirmed", { who: "You", at: dayClockLabel(yesterday, now, en, "en") })).toBe("You reviewed · Yesterday 16:51");
  expect(reader("reportFeed.row.cause", { title: "Draft", at: dayClockLabel(yesterday, now, en, "en") })).toBe("Received “Draft” · Yesterday 16:51");
});

test("a rail mark's colour says what its record did, never which way it went, and guesses none", () => {
  const tone = (report: Partial<Parameters<typeof reportTone>[0]>) => reportTone({ kind: "comment", mark: null, ...report });
  expect(tone({ kind: "error" })).toBe("error");
  expect(tone({ kind: "report", set: "done" })).toBe("done");
  expect(tone({ kind: "confirm", set: "done" })).toBe("done");
  expect(tone({ finish: true })).toBe("done");
  expect(tone({ kind: "question", mark: { kind: "report", tone: "turn" }, set: "waiting" })).toBe("turn");
  expect(tone({ kind: "request" })).toBe("working");
  expect(tone({ kind: "answer" })).toBe("working");
  expect(tone({ kind: "changed", set: "doing" })).toBe("working");
  // What changed nothing, or whose effect the server does not say, keeps the row's grey: a working card mark is not enough.
  expect(tone({ kind: "comment", mark: { kind: "report", tone: "working" } })).toBe("quiet");
  expect(tone({ kind: "question", mark: { kind: "report", tone: "quiet" }, set: "waiting" })).toBe("quiet");
  expect(tone({ kind: "report", set: "stopped" })).toBe("quiet");
  expect(tone({ kind: "changed", set: "held" })).toBe("quiet");
  expect(tone({ kind: "run_end" })).toBe("quiet");
  expect(tone({ kind: "dialogue" })).toBe("quiet");
  // What happened to a conversation has its own colour, on its mark and on the line beside it alike.
  expect(tone({ kind: "conversation" })).toBe("conversation");
});

test("a compaction's row shows its fill before and after with what it cut, and a fresh start says why; opened, each says what set it off and what it does", async () => {
  await inEnglish();
  const owner = { kind: "owner", profileKey: "claude", modelId: "opus", effort: "high" } as const;
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([
    { id: "R1@2026-11-26T00:00:00.000Z", kind: "conversation", author: owner, conversation: { change: "compacted", beforeTokens: 610_000, afterTokens: 140_000, windowTokens: 1_000_000, trigger: "agent" } },
    { id: "R2:new", kind: "conversation", author: owner, conversation: { change: "new", because: "handoff", report: "Filters reviewed" } }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const kinds = await waitFor(() => {
    const named = [...document.querySelectorAll<HTMLElement>("[data-row-kind]")].map(kind => kind.textContent);
    expect(named).toHaveLength(2);
    return named;
  });
  expect(kinds.sort()).toEqual(["Compacted", "Fresh start"]);
  const fill = document.querySelector<HTMLElement>("[data-compaction-fill]")!;
  expect(fill.textContent).toBe("Context61%14%· 470K tokens cut");
  const words = [...document.querySelectorAll<HTMLElement>("[data-row-words]")].map(row => row.textContent);
  expect(words).toContain("The owner gave the conversation a fresh start after “Filters reviewed”");
  // Opened, a compaction says what set it off; a fresh start says what it carries over, with the study behind it.
  for (const button of document.querySelectorAll<HTMLElement>("button[aria-expanded]")) fireEvent.click(button);
  const details = await waitFor(() => {
    const shown = [...document.querySelectorAll<HTMLElement>("[data-conversation-detail]")];
    expect(shown).toHaveLength(2);
    return shown.map(detail => detail.textContent ?? "");
  });
  expect(details.some(text => text.includes("the AI compacted it by itself"))).toBe(true);
  expect(details.some(text => text.includes("starts from the task's records"))).toBe(true);
  expect(document.querySelector<HTMLAnchorElement>('[data-conversation-detail] a')!.href).toBe("https://arxiv.org/abs/2505.06120");
});

test("a compaction whose agent gave only the figure after still shows it, and says the one before did not come", async () => {
  await inEnglish();
  const owner = { kind: "owner", profileKey: "codex", modelId: "gpt-6.2-sol", effort: "high" } as const;
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([
    { id: "R1@2026-11-26T00:00:00.000Z", kind: "conversation", author: owner, conversation: { change: "compacted", beforeTokens: null, afterTokens: 66_500, windowTokens: 475_000, trigger: "asked" } }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const fill = await waitFor(() => document.querySelector<HTMLElement>("[data-compaction-fill]")!);
  expect(fill.textContent).toBe("Context after14%");
  fireEvent.click(document.querySelector<HTMLElement>("button[aria-expanded]")!);
  const detail = await waitFor(() => document.querySelector<HTMLElement>("[data-conversation-detail]")!);
  expect(detail.textContent).toContain("Compacted before the next instruction, as requested.");
  expect(detail.textContent).toContain("The AI did not say the context before.");
});

test("the context meter lists the task's conversation changes newest first, with what compactions cut", async () => {
  await inEnglish();
  const { ContextMeter } = await import("../src/features/people/ContextMeter");
  const changes = [
    { at: "2026-11-26T00:00:00.000Z", change: "new", because: "handoff" },
    { at: "2026-11-26T01:00:00.000Z", change: "compacted", beforeTokens: 610_000, afterTokens: 140_000, windowTokens: 1_000_000 },
    { at: "2026-11-26T02:00:00.000Z", change: "compacted", beforeTokens: 500_000, afterTokens: 100_000, windowTokens: 1_000_000 },
  ] as const;
  render(<ContextMeter press conversations={{ anew: 1, compacted: 23, cutTokens: 9_870_000, changes: [...changes] }}
    context={{ usedTokens: 140_000, windowTokens: 1_000_000, windowFrom: "reported", compacted: false, observedAt: "2026-11-26T00:00:00.000Z" }} />);
  fireEvent.click(document.querySelector<HTMLElement>("[data-context-meter]")!);
  const list = await waitFor(() => document.querySelector<HTMLElement>("[data-conversation-list]")!);
  // The total is the task's whole, from the server, and what the list leaves out is said.
  expect(list.querySelector("[data-conversation-cut]")!.textContent).toBe("Tokens cut by compaction (total)9.9M tokens");
  expect(list.querySelector("[data-conversation-more]")!.textContent).toBe("21 more in History");
  const rows = [...list.querySelectorAll<HTMLElement>("[data-conversation-change]")];
  expect(rows.map(row => row.dataset.conversationChange)).toEqual(["compacted", "compacted", "new"]);
  expect(rows[0]!.textContent).toContain("50%");
  expect(rows[0]!.textContent).toContain("10%");
  expect(rows[0]!.textContent).toContain("−400K");
  expect(rows[2]!.textContent).toContain("owner's break");
  // What a compaction and a new conversation are is a press on the ? away.
  fireEvent.click(list.querySelector<HTMLElement>('[aria-label="About compactions and fresh starts"]')!);
  await waitFor(() => expect(document.querySelector("[data-conversation-help]")!.textContent).toContain("the conversation starts again from the task's records (what its Context tab shows)"));
});

test("a stop the AI stack carried on goes to the AI that took over, closed and open alike", async () => {
  await inEnglish();
  const data = screenData(tree({ tasks: [dto()], history: { T1: historyFixture([{ id: "R1", kind: "error", title: "exit",
    cause: "session_limit", carriedOn: true, author: { kind: "owner", profileKey: "claude", modelId: "opus", effort: "high" },
    recipient: { role: "owner", profileKey: "codex", modelId: "gpt-6.2-sol", effort: "high" } }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const row = await waitFor(() => document.querySelector<HTMLElement>('[data-row-words]')!.closest<HTMLElement>("li")!);
  expect(row.querySelector("[data-row-ends]")?.textContent).toContain("gpt-6.2-sol");
  fireEvent.click(row.querySelector<HTMLElement>("button[aria-expanded]")!);
  const parties = await waitFor(() => row.querySelector<HTMLElement>("[data-row-parties]")!);
  expect(parties.textContent).toContain("gpt-6.2-sol");
  expect(parties.textContent).not.toContain("You");
});
