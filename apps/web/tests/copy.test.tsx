import { afterEach, beforeAll, expect, onTestFinished, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { controlRequestSchema } from "@alpacawork/contract/control";
import { Toaster } from "../src/components/ui/toaster";
import { reportCopy, taskCopy } from "../src/lib/clipboard";
import { ContextPage, ReportFeed } from "../src/features/reader/ReportFeed";
import { useViewStore } from "../src/state/view-store";
import { at, dto, historyFixture, logEntry, screenData, TestWorkspace, tree } from "./fixtures";

beforeAll(() => startI18n());
afterEach(cleanup);

function clipboard(denied = false) {
  const writeText = denied ? vi.fn().mockRejectedValue(new Error("Denied")) : vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

async function inEnglish() {
  const was = i18n.language;
  await i18n.changeLanguage("en");
  onTestFinished(async () => { await i18n.changeLanguage(was); });
}

const owner = { id: "P1", taskId: "T1", agentId: "A1", profileKey: "codex", responsible: true,
  active: true, revision: 1, startedAt: at, endedAt: null, headRunId: null,
  runtime: { displayState: "idle" as const, reason: null, sourceRunIds: [], runningCount: 0, queuedCount: 0,
    since: null, lastOutputAt: null, activityKind: null, toolName: null } };

test("a task is copied as its id, one space, and its title; a report as its title, a blank line, and its Markdown", () => {
  expect(taskCopy({ id: "T11", title: "Build the Working column using option A (fold to one line; use ⌄ for each agent's time, tokens and stop)" }))
    .toBe("T11 Build the Working column using option A (fold to one line; use ⌄ for each agent's time, tokens and stop)");
  expect(reportCopy("Please review", "- ゴール: **Bold**\n\n![Image](files/a.png)\n"))
    .toBe("Please review\n\n- ゴール: **Bold**\n\n![Image](files/a.png)");
  expect(reportCopy("Title only", null)).toBe("Title only");
  expect(reportCopy("", "Body only")).toBe("Body only");
});

test("an opened report copies its title and Markdown body; a closed one shows no copy", async () => {
  const writeText = clipboard();
  const task = dto({ log: [
    logEntry({ id: "L1", kind: "reported", at: "2026-10-10T12:00:00Z", toState: "doing", actor: { kind: "placement", placementId: "P1" },
      title: "Older report", description: "Older body" }),
    logEntry({ id: "L2", kind: "reported", at: "2026-10-10T13:00:00Z", toState: "waiting",
      actor: { kind: "placement", placementId: "P1" }, title: "Please review", description: "- 結論: **Done**\n\n![Image](a.png)" })] });
  // History as the server sends it, newest first: the report that asked for a review, then the earlier report.
  const data = screenData(tree({ tasks: [task], placements: [owner], history: { T1: historyFixture([
    { id: "L2", kind: "review", at: "2026-10-10T13:00:00Z", state: "waiting", title: "Please review", summary: "- 結論: **Done**\n\n![Image](a.png)" },
    { id: "L1", kind: "comment", at: "2026-10-10T12:00:00Z", state: "doing", title: "Older report", summary: "Older body" },
  ]) } }));
  useViewStore.setState(useViewStore.getInitialState());
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const opened = document.querySelector<HTMLElement>(`[data-report-key="log:T1:L2"]`)!;
  const closed = document.querySelector<HTMLElement>(`[data-report-key="log:T1:L1"]`)!;
  expect(within(closed).queryByRole("button", { name: "Copy" })).toBeNull();
  fireEvent.click(within(opened).getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("Please review\n\n- 結論: **Done**\n\n![Image](a.png)"));
  fireEvent.click(within(closed).getByRole("button", { expanded: false }));
  fireEvent.click(within(closed).getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Older report\n\nOlder body"));
});

test("an opened instruction copies the instruction as written, and Context copies the task with its body", async () => {
  await inEnglish();
  const writeText = clipboard();
  const request = controlRequestSchema.parse({ id: "Q1", taskId: "T1", placementId: "P1", runId: "R1", aboutRunId: null, recipientRole: "owner",
    purpose: "instruction", author: { kind: "human" }, mode: "new", body: "# Instruction\n\n**Full text**", submittedAt: at, deliveryState: "queued" });
  const data = screenData(tree({ tasks: [dto({ title: "Widen the view", body: "- ゴール: Wide\n\n## 本文\nNote",
    log: [logEntry({ id: "Q1", kind: "request_accepted" })] })], requests: [request],
    history: { T1: historyFixture([{ id: "Q1", kind: "request", by: "human", title: "# Instruction", summary: request.body }]) } }));
  useViewStore.setState(useViewStore.getInitialState());
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  // With no report yet, the instruction is the newest thing you wrote and stands open.
  const instruction = document.querySelector<HTMLElement>('[data-report-key="request:Q1"]')!;
  fireEvent.click(within(instruction).getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Instruction\n\n**Full text**"));
  cleanup();
  // Context, the task's own page, copies the task with its body.
  render(<TestWorkspace data={data}><ContextPage task={data.tasks[0]!} onFollow={() => {}} /></TestWorkspace>);
  const copy = screen.getByRole("button", { name: "Copy" });
  fireEvent.click(copy);
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`T1 Widen the view\n\n${data.tasks[0]!.values.context}`));
  // It says it worked in place: ✓ on the mark and in its name, no toast.
  await waitFor(() => expect(copy.querySelector('[data-icon="check"]')).toBeTruthy());
  expect(copy.getAttribute("aria-label")).toBe(i18n.t("ui:copied"));
  expect(screen.queryByText(i18n.t("ui:copied"))).toBeNull();
});

test("a copy the browser refuses keeps its mark and says what to do instead", async () => {
  await inEnglish();
  const writeText = clipboard(true);
  const data = screenData(tree({ tasks: [dto({ title: "Task one", body: "Note" })] }));
  useViewStore.setState(useViewStore.getInitialState());
  render(<><Toaster /><TestWorkspace data={data}><ContextPage task={data.tasks[0]!} onFollow={() => {}} /></TestWorkspace></>);
  const copy = screen.getByRole("button", { name: "Copy" });
  fireEvent.click(copy);
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  expect(await screen.findByText(i18n.t("ui:copyFailed"))).toBeTruthy();
  expect(copy.querySelector('[data-icon="copy"]')).toBeTruthy();
});

for (const description of [null, 'A summary kept for history readers']) test(`request note ${description ? 'with summary' : 'title only'} stays separate from its delivered body and copies`, async () => {
  await inEnglish(); const writeText = clipboard();
  const body = 'Body delivered to the agent\n\nBody detail';
  const note = { title: 'Independent history title', description };
  const event = { id: 'noted', kind: 'request' as const, taskId: 'T1', fromChild: false, at,
    state: null, by: 'human' as const, title: 'Body delivered to the agent', summary: body, note };
  const data = screenData(tree({ tasks: [dto()], history: { T1: [event] } }));
  useViewStore.setState({ event: 'request:noted' });
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const row = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-report-key="request:noted"]'); expect(found).not.toBeNull(); return found!;
  });
  expect(row.querySelector('[data-row-words]')?.textContent).toContain(note.title);
  if (description) {
    expect(within(row).getByText(description).textContent).toBe(description);
    const sent = within(row).getByRole('button', { name: 'Body sent to the agent' });
    expect(sent.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(within(row).getAllByRole('button', { name: 'Copy' })[0]!);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(reportCopy(note.title, description)));
    fireEvent.click(sent);
  }
  const copies = within(row).getAllByRole('button', { name: 'Copy' });
  fireEvent.click(copies.at(-1)!);
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(body));
  expect(row.querySelector('[data-row-words]')?.textContent).toContain(note.title);
});
