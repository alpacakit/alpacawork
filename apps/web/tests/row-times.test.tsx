import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { i18n } from "@alpacawork/i18n";
import { useConnection } from "../src/data/connection";
import { OFFLINE_SHOWN_AFTER_MS } from "../src/data/reach";
import { TimeTree } from "../src/features/tree/TimeTree";
import { useViewStore } from "../src/state/view-store";
import { TestWorkspace, dto, homeFixture, logEntry, narrowScreen, decideItem, questionFixture, run, taskFixture, tree, userBall } from "./fixtures";
import { canonical, created, fixture, iso, minute, now, report, served, setupTimeView } from "./time-view-fixture";

setupTimeView();

const row = (id: string) => document.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
const clock = (at: number) => new Date(at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });

test("a phone's expected report has a flag and a clock, with a suffix only for not-before or overdue, or ? while pending", async () => {
  await i18n.changeLanguage("ja");
  const phone = narrowScreen(true);
  try {
    const tasks = [
      dto({ id: "T1", state: "doing", log: [created(now - 30 * minute), report("L2", now - 20 * minute, "doing", 60)] }),
      dto({ id: "T2", state: "doing" }), // Its unfinished child has an estimate, another has none.
      dto({ id: "T21", parentId: "T2", state: "doing", log: [created(now - 30 * minute), report("L2", now - 20 * minute, "doing", 60)] }),
      dto({ id: "T22", parentId: "T2", state: "doing" }),
      dto({ id: "T3", state: "doing", log: [created(now - 100 * minute), report("L2", now - 90 * minute, "doing", 30)] }),
      dto({ id: "T4", state: "doing", log: [created(now - 30 * minute), report("L2", now - 20 * minute, "doing", 60),
        report("L3", now - 2 * minute, "waiting"),
        logEntry({ id: "L4", kind: "review_sent_back", at: iso(now - minute), title: "New instruction", fromState: "waiting", toState: "doing" })] }),
      dto({ id: "T5", state: "doing" }), // No estimate: no report time.
      taskFixture({ id: "T6", state: "waiting", log: [created(now - 30 * minute), report("L2", now - 20 * minute, "doing", 60),
        report("L3", now - 10 * minute, "waiting")], ball: userBall("review", "L3", iso(now - 10 * minute), { aboutRunId: "R1" }) }),
    ];
    // Each Working task has a Run going on it, so it is at work and its estimate counts.
    const runs = ["T1", "T21", "T22", "T3", "T4", "T5"].map(taskId => run(`R${taskId.slice(1)}`, { taskId, placementId: `P${taskId.slice(1)}`,
      state: "running", startedAt: iso(now - 10 * minute), endedAt: null }));
    render(<TestWorkspace data={served(tree({ tasks, runs, home: homeFixture([
      ...["T1", "T2", "T3", "T4", "T5"].map(taskId => ({ taskId, section: "doing" as const })),
      { taskId: "T6", section: "review" },
    ]) }))}><TimeTree /></TestWorkspace>);
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-group-more="doing"] button')!);
    for (const [id, kind, text] of [
      ["T1", "estimate", clock(now + 40 * minute)],
      ["T2", "subtree", `${clock(now + 40 * minute)}〜`],
      ["T3", "over", `${clock(now - 60 * minute)} 超過`],
      ["T4", "pending", "？"],
    ] as const) {
      const time = row(id).querySelector<HTMLElement>("[data-row-report]")!;
      expect(time.dataset.rowReport).toBe(kind);
      expect(time.textContent).toBe(text);
      expect(time.querySelector('[data-icon="flag"]')).not.toBeNull();
      expect(time.classList.contains("text-muted")).toBe(kind !== "over");
      expect(time.classList.contains("text-ink")).toBe(kind === "over");
      expect(time.classList.contains("text-working")).toBe(false);
    }
    expect(row("T5").querySelector("[data-row-report]")).toBeNull();
    expect(row("T6").querySelector("[data-row-report]")).toBeNull();
  } finally { phone.restore(); }
});

test.each([false, true])("only a running Run's minutes use the working colour, on a phone: %s", (narrow) => {
  const phone = narrowScreen(narrow);
  try {
    const data = fixture();
    render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
    const running = row("T2").querySelector<HTMLElement>("[data-row-status]")!;
    const waiting = row("T1").querySelector<HTMLElement>("[data-row-status]")!;
    expect(running.textContent).toBe("20m");
    expect(running.classList.contains("text-working")).toBe(true);
    expect(running.classList.contains("text-muted")).toBe(false);
    expect(waiting).toBeNull(); // The home projection puts this row in review.
    // A subscription still opening (a reload, a pull to refresh) keeps counting: nothing failed yet.
    const before = useConnection.getState();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => useConnection.setState({ offline: true, state: "connecting", failures: 0 }));
      act(() => vi.advanceTimersByTime(OFFLINE_SHOWN_AFTER_MS * 3));
      expect(row("T2").querySelector<HTMLElement>("[data-row-status]")!.textContent).toBe("20m");
      // A failed try, once it lasts, stops the time at the last receipt, in grey: no row says offline (the bar does).
      act(() => useConnection.setState({ state: "reconnecting", failures: 1, lastReceivedAt: now - 5 * minute }));
      act(() => vi.advanceTimersByTime(OFFLINE_SHOWN_AFTER_MS - 1));
      expect(row("T2").querySelector<HTMLElement>("[data-row-status]")!.classList.contains("text-working")).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      const offline = row("T2").querySelector<HTMLElement>("[data-row-status]")!;
      expect(offline.textContent).toBe("15m");
      expect(offline.classList.contains("text-muted")).toBe(true);
      expect(offline.classList.contains("text-working")).toBe(false);
      // Drawn again while out of reach (a section folded and opened), the row says the same at once.
      const { container } = render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
      const again = container.querySelector<HTMLElement>('[data-row="T2"] [data-row-status]')!;
      expect(again.textContent).toBe("15m");
      expect(again.classList.contains("text-muted")).toBe(true);
      // Nothing received yet: it only says it runs.
      act(() => useConnection.setState({ lastReceivedAt: undefined }));
      expect(row("T2").querySelector<HTMLElement>("[data-row-status]")!.textContent).toBe("Running");
    } finally {
      vi.useRealTimers();
      act(() => useConnection.setState({ offline: before.offline, state: before.state, failures: before.failures, lastReceivedAt: before.lastReceivedAt }));
    }
  } finally { phone.restore(); }
});

test("a stopped turn says its elapsed time, and a running Run with no start time stays muted", () => {
  const placement = { ...canonical.placements[0]!, taskId: "T2",
    runtime: { ...canonical.placements[0]!.runtime, displayState: "running" as const, since: null } };
  const data = served(tree({ tasks: [taskFixture({ id: "T1", state: "doing", ball:userBall("limit","Llimit",iso(now-3*minute),{count:1}) }), dto({ id: "T2", state: "doing" })],
    // T1 is listed for a stop its parent cannot mend while its state is still Working: it says it is not running.
    placements: [placement], home: homeFixture([{ taskId: "T1", section: "error" }, { taskId: "T2", section: "doing" }]) }));
  data.info.counts.home.root!.error = 1;
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const still = row("T1").querySelector<HTMLElement>("[data-row-status]")!;
  const running = row("T2").querySelector<HTMLElement>("[data-row-status]")!;
  expect(still.textContent).toBe("3m");
  expect(still.classList.contains("text-muted")).toBe(true);
  expect(still.classList.contains("text-working")).toBe(false);
  expect(running.textContent).toBe("Running");
  expect(running.classList.contains("text-muted")).toBe(true);
  expect(running.classList.contains("text-working")).toBe(false);
});

test.each([
  { narrow: true, selector: "[data-row-report]", heading: "Report estimate", explanation: `20 of 60 min worked. Expected report ${clock(now + 40 * minute)}` },
  { narrow: true, selector: "[data-row-status]", heading: "Total agent working time", explanation: "With tasks below20 minThis task only20 min" },
  { narrow: false, selector: "[data-row-status]", heading: "Total agent working time", explanation: "With tasks below20 minThis task only20 min" },
])("pressing $selector opens its meaning without opening the task, on a phone: $narrow", ({ narrow, selector, heading, explanation }) => {
  const phone = narrowScreen(narrow);
  try {
    render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
    const press = row("T2").querySelector<HTMLElement>("[data-read]")!;
    const time = row("T2").querySelector<HTMLElement>(selector)!;
    expect(time.tagName).toBe("BUTTON");
    expect(press.contains(time)).toBe(false);
    expect(document.querySelector("[data-time-tip]")).toBeNull();
    const selected = useViewStore.getState().selected;
    const reader = useViewStore.getState().reader;
    fireEvent.click(time);
    const tip = document.querySelector("[data-time-tip]")!;
    expect(tip).toBeTruthy();
    expect(tip.querySelector("p")?.textContent).toBe(heading);
    expect(tip.lastElementChild?.textContent).toBe(explanation);
    expect(useViewStore.getState().selected).toBe(selected);
    expect(useViewStore.getState().reader).toEqual(reader);
    fireEvent.keyDown(tip, { key: "Escape" });
    expect(document.querySelector("[data-time-tip]")).toBeNull();
    fireEvent.click(press);
    expect(useViewStore.getState()).toMatchObject({ selected: "T2", reader: { pane: "task", open: true } });
  } finally { phone.restore(); }
});

test("a running row says how long agents worked on it and under it, and its press splits the task's own part", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(now));
  await i18n.changeLanguage("ja");
  const phone = narrowScreen(true);
  try {
    const hour = 60 * minute;
    const tasks = [dto({ id: "T1", state: "doing", userRequested: true }), dto({ id: "T11", parentId: "T1", state: "doing" }),
      dto({ id: "T111", parentId: "T11", state: "done" })];
    const placements = [{ ...canonical.placements[0]!, id: "P1", taskId: "T1",
      runtime: { ...canonical.placements[0]!.runtime, sourceRunIds: ["R3"], since: iso(now - 10 * minute) } }];
    const runs = [
      // The responsible's ended Run, a worker's Run that ran beside it (both count) and the one running now.
      run("R1", { taskId: "T1", placementId: "P1", state: "succeeded", startedAt: iso(now - 3 * hour), endedAt: iso(now - 2 * hour) }),
      run("R2", { taskId: "T1", placementId: "P2", state: "succeeded", startedAt: iso(now - 3 * hour), endedAt: iso(now - 150 * minute) }),
      run("R3", { taskId: "T1", placementId: "P1", state: "running", startedAt: iso(now - 10 * minute), endedAt: null }),
      // The tasks under it, a grandchild too; a joined Run never started and adds nothing.
      run("R4", { taskId: "T11", placementId: "P3", state: "succeeded", startedAt: iso(now - 2 * hour), endedAt: iso(now - hour) }),
      run("R5", { taskId: "T111", placementId: "P4", state: "succeeded", startedAt: iso(now - hour), endedAt: iso(now - 30 * minute) }),
      run("R6", { taskId: "T11", placementId: "P3", state: "joined", startedAt: null, endedAt: null }),
    ];
    const completed = { runs: 2, runMs: 90 * minute, tokens: null, tokensUnknown: 2 };
    render(<TestWorkspace data={served(tree({ tasks, placements, runs, usage: { T1: { usage: completed, usageBelow: completed } },
      home: homeFixture([{ taskId: "T1", section: "doing" }]) }))}>
      <TimeTree /></TestWorkspace>);
    const time = row("T1").querySelector<HTMLElement>("[data-row-status]")!;
    // 60 + 30 + 10 own, 60 + 30 under it: 3 hours 10 minutes, said in whole hours.
    expect(time.textContent).toBe("3時間");
    expect(time.classList.contains("text-working")).toBe(true);
    fireEvent.click(time);
    const tip = document.querySelector("[data-time-tip]")!;
    expect(tip.querySelector("p")?.textContent).toBe("エージェントが動いた時間の合計");
    expect(tip.querySelector('[data-work-time="subtree"]')?.textContent).toBe("配下のタスクも含めて3時間10分");
    expect(tip.querySelector('[data-work-time="own"]')?.textContent).toBe("このタスクだけ1時間40分");
    expect(time.getAttribute("aria-label")).toBe("エージェントが動いた時間の合計: 配下のタスクも含めて 3時間10分、このタスクだけ 1時間40分");
    fireEvent.keyDown(tip, { key: "Escape" });
    // The running Run's time follows the clock.
    act(() => { vi.advanceTimersByTime(60 * minute); });
    expect(time.textContent).toBe("4時間");
    // Past an hour the minutes take two digits, so the two lines' figures stand under each other.
    act(() => { vi.advanceTimersByTime(53 * minute); });
    fireEvent.click(time);
    expect(document.querySelector('[data-time-tip] [data-work-time="subtree"]')?.textContent).toBe("配下のタスクも含めて5時間03分");
    expect(document.querySelector('[data-time-tip] [data-work-time="own"]')?.textContent).toBe("このタスクだけ3時間33分");
  } finally { phone.restore(); await i18n.changeLanguage("en"); }
});

test.each([false,true])('a Working parent whose own Run does not run uses descendant work time and estimate, phone=%s', async narrow => {
  await i18n.changeLanguage('ja');
  const phone=narrowScreen(narrow);
  try {
    const parent=dto({id:'T1',state:'doing'}), child=dto({id:'T2',parentId:'T1',state:'doing',log:[created(now-30*minute),report('L2',now-20*minute,'doing',60)]});
    const data=served(tree({tasks:[parent,child],runs:[run('R909',{taskId:'T2',placementId:'P909',state:'running',startedAt:iso(now-20*minute),endedAt:null})],
      usage:{T1:{usage:{runs:1,runMs:5*minute,tokens:null,tokensUnknown:1},usageBelow:{runs:1,runMs:7*minute,tokens:null,tokensUnknown:1},runsBelow: [["R909", now-20*minute]]}},
      children:{T1:{live:1,finished:0,states:{todo:0,doing:1,error:0,waiting:0,held:0,done:0,stopped:0},runningBelow:1,below:1}},
      home:homeFixture([{taskId:'T1',section:'doing'}])}));
    render(<TestWorkspace data={data}><TimeTree/></TestWorkspace>);
    const parentRow=row('T1');
    expect(parentRow.querySelector('[data-row-status]')?.textContent).toBe('32分');
    expect(parentRow.querySelector('[data-row-status]')?.className).toContain('text-working');
    if(narrow) expect(parentRow.querySelector('[data-row-report] [data-icon="flag"]')).toBeTruthy();
  } finally {phone.restore();}
});

test.each([false, true])('a queued child keeps its grouped parent working, with queued words before any work time exists (phone=%s)', async narrow => {
  await i18n.changeLanguage('ja');
  const phone = narrowScreen(narrow);
  try {
    const tasks = [dto({ id: 'T1', state: 'doing' }), dto({ id: 'T2', parentId: 'T1', state: 'doing',
      log: [created(now - 30 * minute), report('Lqueued', now - 20 * minute, 'doing', 60)] })];
    const placement = { ...canonical.placements[0]!, id: 'P2', taskId: 'T2',
      runtime: { ...canonical.placements[0]!.runtime, displayState: 'idle' as const, runningCount: 0, queuedCount: 1,
        sourceRunIds: ['R22'], since: null, lastOutputAt: null } };
    const data = served(tree({ tasks, placements: [placement],
      runs: [run('R22', { taskId: 'T2', placementId: 'P2', state: 'queued', startedAt: null, endedAt: null })],
      home: homeFixture([{ taskId: 'T1', section: 'doing' }]) }));
    expect(data.tasks.find(t => t.id === 'T1')!.rowFacts.status?.kind).toBeUndefined();
    expect(data.tasks.find(t => t.id === 'T2')!.rowFacts.status?.kind).toBe('queued');
    render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
    const parent = row('T1'), time = parent.querySelector<HTMLElement>('[data-row-status]')!;
    expect(time.dataset.rowStatus).toBe('queued');
    expect(time.textContent).toBe(i18n.t('tree:status.queued'));
    expect(time.classList.contains('text-ink')).toBe(true);
    expect(parent.textContent).not.toContain('動いていない');
    expect(parent.querySelector('[data-row-note]')).toBeNull();
    if (narrow) expect(parent.querySelector('[data-row-report] [data-icon="flag"]')).toBeTruthy();
  } finally { phone.restore(); }
});

test.each([false, true])('a grouped parent with elapsed work uses that time while its child is queued (phone=%s)', async narrow => {
  await i18n.changeLanguage('ja');
  const phone = narrowScreen(narrow);
  try {
    const data = served(tree({ tasks: [dto({id:'T1',state:'doing'}),dto({id:'T2',parentId:'T1',state:'doing'})],
      usage: { T1: { usage: {runs:1,runMs:5*minute,tokens:null,tokensUnknown:1}, usageBelow:{runs:1,runMs:7*minute,tokens:null,tokensUnknown:1} } },
      home:homeFixture([{taskId:'T1',section:'doing'}]) }));
    expect(data.tasks.find(t=>t.id==='T1')!.rowFacts.status?.kind).toBeUndefined();
    render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
    expect(row('T1').querySelector('[data-row-status]')?.textContent).toBe('12分');
    expect(row('T1').textContent).not.toContain('動いていない');
  } finally { phone.restore(); }
});

test.each([false, true])('a Working row with no Run of its own or below running says queued, and represented work never hides unclear (phone=%s)', async narrow => {
  await i18n.changeLanguage('en');
  const phone = narrowScreen(narrow);
  try {
    const unknown = { ...canonical.placements[0]!, taskId: 'T2',
      runtime: { ...canonical.placements[0]!.runtime, displayState: 'unknown' as const, since: null, runningCount: 0, queuedCount: 0 } };
    const data = served(tree({ tasks: [dto({id:'T1',state:'doing'}),dto({id:'T2',state:'doing'}),dto({id:'T3',state:'doing'})],
      placements: [unknown], home:homeFixture(['T1','T2','T3'].map(taskId => ({taskId,section:'doing' as const}))) }));
    // Work below never takes precedence over an unknown own execution state.
    data.tasks.find(t=>t.id==='T3')!.rowFacts = {...data.tasks.find(t=>t.id==='T3')!.rowFacts, status:{kind:'unclear'}, childrenRunning:1};
    render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
    for (const [id, kind] of [['T1','queued'],['T2','unclear'],['T3','unclear']] as const) {
      const status = row(id).querySelector<HTMLElement>('[data-row-status]')!;
      expect(status.dataset.rowStatus).toBe(kind);
      expect(status.textContent).toBe(i18n.t(`tree:status.${kind}`));
      expect(status.classList.contains('text-ink')).toBe(true);
    }
  } finally { phone.restore(); }
});

const runningRow=(section:'doing'|'review'|'awaited',count:number)=>served(tree({tasks:[dto({id:'T1',state:section==='review'?'waiting':'doing'})],
  runningRuns:{T1:count},home:homeFixture([{taskId:'T1',section}])}));

test.each([false,true])('a Working row says how many agents run, in grey beside its time, and in words to a reader, phone=%s',async narrow=>{
  await i18n.changeLanguage('ja');
  const phone=narrowScreen(narrow);
  try {
    render(<TestWorkspace data={runningRow('doing',2)}><TimeTree/></TestWorkspace>);
    const mark=row('T1').querySelector<HTMLElement>('[data-row-running-runs]')!;
    expect(mark.dataset.rowRunningRuns).toBe('2');
    // The working colour is the time's alone on the row.
    expect(mark.className).toContain('text-muted');
    expect(mark.querySelector('[aria-hidden="true"]')?.textContent).toBe('2');
    expect(mark.querySelector('.sr-only')?.textContent).toBe('稼働中のエージェント 2（配下を含む）');
    expect(mark.nextElementSibling?.getAttribute('data-row-status')).toBeTruthy();
  } finally {phone.restore();}
});

test.each([['doing',0],['review',2],['awaited',2]] as const)('a row in %s with %i running says no count',async(section,count)=>{
  const phone=narrowScreen(false);
  try {
    render(<TestWorkspace data={runningRow(section,count)}><TimeTree/></TestWorkspace>);
    expect(document.querySelector('[data-row-running-runs]')).toBeNull();
  } finally {phone.restore();}
});

test.each([false, true])('no row counts the children at work under it; each keeps what else it says (phone=%s)', async narrow => {
  const phone = narrowScreen(narrow);
  try {
    const at = (id: string, taskId: string, displayState: 'running' | 'attention') => ({ ...canonical.placements[0]!, id, taskId,
      runtime: { ...canonical.placements[0]!.runtime, displayState, since: iso(now - 5 * minute), lastOutputAt: iso(now) } });
    const tasks = [dto({ id: 'T1', state: 'doing' }), dto({ id: 'T2', state: 'doing' }), taskFixture({ id: 'T3', state: 'todo' }),
      taskFixture({ id: 'T4', state: 'doing', ball: userBall('limit', 'L2', iso(now - minute), { count: 1 }) })];
    const placements = [at('P1', 'T1', 'running'), at('P2', 'T2', 'attention')];
    for (const parent of ['T1', 'T2', 'T3', 'T4']) {
      tasks.push(dto({ id: `${parent}1`, parentId: parent, state: 'doing' }));
      placements.push(at(`P${parent}1`, `${parent}1`, 'running'));
    }
    const running = { live: 1, finished: 0, states: { todo: 0, doing: 1, error: 0, waiting: 0, held: 0, done: 0, stopped: 0 }, runningBelow: 1, below: 1 };
    const data = served(tree({ tasks, placements, children: { T1: running, T2: running, T3: running, T4: running },
      home: homeFixture([{ taskId: 'T1', section: 'doing' }, { taskId: 'T2', section: 'doing' },
      { taskId: 'T3', section: 'todo' }, { taskId: 'T4', section: 'error' }]) }));
    for (const language of ['ja', 'en']) {
      await i18n.changeLanguage(language);
      const { unmount } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
      for (const id of ['T1', 'T2', 'T3', 'T4']) {
        expect(row(id).querySelector('[data-row-note]')).toBeNull();
        expect(row(id).textContent).not.toMatch(/子 ?\d+件|\bchild(ren)? working/);
      }
      expect(row('T1').querySelector<HTMLElement>('[data-row-status]')!.dataset.rowStatus).toBe('running');
      expect(row('T2').querySelector<HTMLElement>('[data-row-status]')!.dataset.rowStatus).toBe('running');
      expect(row('T3').querySelector('[data-row-status]')).toBeNull();
      expect(row('T4').querySelector<HTMLElement>('[data-row-status]')?.dataset.rowStatus).toBe('since');
      if (narrow) expect(row('T4').querySelector<HTMLElement>('[data-row-kind]')!.dataset.rowKind).toBe('followup');
      unmount();
    }
  } finally { phone.restore(); }
});

test.each([false,true])('represented running work with no clock says Running, including mixed queued work (phone=%s)', async narrow => {
  await i18n.changeLanguage('en');
  const phone=narrowScreen(narrow);
  try {
    const placement={...canonical.placements[0]!,taskId:'T2',
      runtime:{...canonical.placements[0]!.runtime,displayState:'running' as const,since:null}};
    const data=served(tree({tasks:[dto({id:'T1',state:'doing'}),dto({id:'T2',parentId:'T1',state:'doing'})],placements:[placement],
      children:{T1:{live:1,finished:0,states:{todo:0,doing:1,error:0,waiting:0,held:0,done:0,stopped:0},runningBelow:1,below:1}},
      home:homeFixture([{taskId:'T1',section:'doing'}])}));
    expect(data.tasks.find(t=>t.id==='T1')!.rowFacts.status).toBeNull();
    render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
    const status=row('T1').querySelector<HTMLElement>('[data-row-status]')!;
    expect(status.dataset.rowStatus).toBe('running');
    expect(status.textContent).toBe(i18n.t('tree:status.running'));
    expect(status.classList.contains('text-muted')).toBe(true);
    expect(row('T1').querySelector('[data-row-note]')).toBeNull();
  } finally { phone.restore(); }
});

test.each([false, true])('stopped rows state the cause before progress and elapsed time; failed questions keep their question mark (phone=%s)', async narrow => {
  const phone=narrowScreen(narrow);
  try {
    const at=iso(now-180*minute), errorAt=iso(now-minute);
    const tasks=[taskFixture({id:'T1',state:'doing',ball:userBall('limit','Lreturn',at,{count:1}),log:[created(now-300*minute)]}),
      taskFixture({id:'T2',state:'error',ball:userBall('question','Lask',at,{questionId:'Lask',failure:{key:'Lfail',at:errorAt}}),
        log:[created(now-300*minute),logEntry({id:'Lfail',kind:'linked',at:errorAt,toState:'error',runId:'R2'})]})];
    const data=served(tree({tasks,questions:[questionFixture({id:'Lask',taskId:'T2',title:'Choose',decide:[decideItem('Choose')],askedAt:at})],
      children:{T1:{live:1,finished:0,states:{todo:0,doing:1,error:0,waiting:0,held:0,done:0,stopped:0},runningBelow:0,below:1}},
      home:homeFixture([{taskId:'T1',section:'error',summary:{done:0,total:1}},{taskId:'T2',section:'review'}])}));
    for(const language of ['ja','en']) {
      await i18n.changeLanguage(language);
      const {unmount}=render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
      const stopped=row('T1'), asked=row('T2');
      expect(stopped.querySelector('[data-row-kind]')?.textContent).toBe(i18n.t('tree:status.turn.limit'));
      expect(stopped.querySelector('[data-row-status]')?.textContent).toBe(i18n.t('tree:status.length.hours',{count:3}));
      const line=stopped.querySelector(narrow?'[data-row-meta]':'[data-row-end]')!;
      expect(line.textContent).not.toContain('動いていない');
      if(!narrow) {
        expect(stopped.querySelector('[data-row-progress]')?.textContent).toBe(i18n.t('tree:status.children',{progress:'0/1'}));
        expect(line.firstElementChild?.getAttribute('data-row-kind')).toBe('followup');
      }
      expect(asked.querySelector('[data-icon="question"]')?.classList.contains('text-turn')).toBe(true);
      expect(asked.querySelector('[data-icon="error"]')).toBeNull();
      expect(asked.querySelector('[data-row-status]')).toBeNull();
      expect(asked.querySelector('[data-row-kind]')?.textContent ?? null).toBe(narrow?i18n.t('ui:turn.question'):null);
      expect(document.querySelector('[data-section="error"] h2')?.textContent).toContain(i18n.t('tree:home.error'));
      fireEvent.click(stopped.querySelector('[data-row-status]')!);
      const tip=document.querySelector('[data-time-tip]')!;
      expect(tip.textContent).toContain(i18n.t('tree:status.long.reason',{length:i18n.t('tree:status.length.hours',{count:3})}));
      fireEvent.keyDown(tip,{key:'Escape'});
      unmount();
    }
  }finally{phone.restore();}
});
