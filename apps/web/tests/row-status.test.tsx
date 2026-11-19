import { projectRowFacts } from '../../backend/src/receiver/row-facts';
import { expect, test } from "vitest";
import { shortLength } from "../src/domain/row-status";
import type { Ball } from "@alpacawork/contract";
import { dto, logEntry, decideItem, questionFixture, screenData, taskFixture, tree, userBall, run, type TaskFixture } from "./fixtures";

type Display = "running" | "attention" | "idle" | "unknown";
const placement = (id: string, taskId: string, displayState: Display, extra: { since?: string; lastOutputAt?: string; queued?: number; responsible?: boolean } = {}) => ({
  id, taskId, agentId: `A-${id}`, profileKey: "codex", responsible: extra.responsible ?? true,
  active: true, revision: 1, startedAt: "2026-10-16T09:00:00Z", endedAt: null, headRunId: null,
  runtime: { displayState, reason: null, sourceRunIds: [], runningCount: displayState === "running" ? 1 : 0, queuedCount: extra.queued ?? 0,
    since: extra.since ?? null, lastOutputAt: extra.lastOutputAt ?? null, activityKind: null, toolName: null } });
/** T1 waiting since its report at 10:00, on the turn the server gives it (none unless given). */
const waiting = (ball: Ball | null = null) => taskFixture({ state: "waiting", ball,
  log: [logEntry(), logEntry({ id: "L2", kind: "reported", at: "2026-10-16T10:00:00Z", toState: "waiting" })] });
/**
 * The row facts of a task of the tree, with the server's count of the tasks running under it (counts.children's
 * runningBelow, which the row reads and does not work out).
 */
const of = (tasks: (ReturnType<typeof dto> | TaskFixture)[], placements: ReturnType<typeof placement>[] = [],
  projected: Partial<Parameters<typeof tree>[0]> = {}) => {
  const data = screenData(tree({ tasks, placements, ...projected }));
  return (id = "T1", runningBelow = 0) => {
    const task = data.people.tasks.get(id)!;
    const { kind, ...status } = projectRowFacts(task, [...data.people.placements.values()], projected.runs ?? [], runningBelow, runningBelow, 0);
    return { status, kind };
  };
};

test("a running task says when its oldest running Run started, whoever runs", () => {
  const facts = of([dto({ state: "doing" })], [
    placement("P1", "T1", "running", { since: "2026-10-16T11:00:00Z", lastOutputAt: "2026-10-16T11:10:00Z" }),
    placement("P2", "T1", "running", { since: "2026-10-16T11:30:00Z", lastOutputAt: "2026-10-16T11:40:00Z", responsible: false }),
  ], {runs:[
    run('R1',{placementId:'P1',state:'running',startedAt:'2026-10-16T11:00:00Z',activity:{at:'2026-10-16T11:10:00Z',kind:'output',toolName:null,doing:null,note:null}}),
    run('R2',{placementId:'P2',state:'running',startedAt:'2026-10-16T11:30:00Z',activity:{at:'2026-10-16T11:40:00Z',kind:'output',toolName:null,doing:null,note:null}}),
  ]})().status;
  expect(facts).toEqual({ status: { kind: "running", since: Date.parse("2026-10-16T11:00:00Z") },
    childrenRunning: 0, runningRuns: 0, warning: null });
});

test("a task at work that does not run says why: queued, unclear or still, and nothing of its own for children at work", () => {
  expect(of([dto({ state: "doing" })], [placement("P1", "T1", "idle", { queued: 1 })])().status.status).toEqual({ kind: "queued" });
  expect(of([dto({ state: "doing" })], [placement("P1", "T1", "attention")])().status.status).toBeNull();
  expect(of([dto({ state: "doing" })], [placement("P1", "T1", "unknown")])().status.status).toEqual({ kind: "unclear" });
  expect(of([dto({ state: "doing" })], [placement("P1", "T1", "idle")])().status.status).toBeNull();
  const parent = of([dto({ state: "doing" }), dto({ id: "T2", parentId: "T1", state: "doing" }), dto({ id: "T3", parentId: "T2", state: "doing" })],
    [placement("P2", "T2", "running"), placement("P3", "T3", "running")])("T1", 2);
  expect(parent.status).toEqual({ status: null, childrenRunning: 2, runningRuns: 0, warning: null });
});

test("a waiting task says how long it waits, with children still at work under it", () => {
  const facts = of([waiting(), dto({ id: "T2", parentId: "T1", state: "doing" })], [placement("P2", "T2", "running")])("T1", 1);
  expect(facts.status).toEqual({ status: { kind: "since", at: Date.parse("2026-10-16T10:00:00Z") }, childrenRunning: 1, runningRuns: 0, warning: null });
});

test("only current needs_review or unreadable execution warns, including running and held rows", () => {
 for (const state of ["doing", "held", "error", "waiting"] as const) {
  for (const [reason, warning] of [["manager_lost","manager_lost"],["conversation_busy","conversation_busy"],[null,"output"]] as const) {
   const reviewing=run("R1",{placementId:"P1",state:"needs_review",reason});
   const facts=of([dto({state})],[placement("P1","T1","attention")],{runs:[reviewing]})().status;
   expect(facts.warning).toBe(warning);
   const together=of([dto({state})],[placement("P1","T1","attention"),placement("P2","T1","running",{responsible:false})],{runs:[reviewing]})().status;
   expect(together.status?.kind).toBe("running"); expect(together.warning).toBe(warning);
  }
  for (const reason of ["exit","conversation_busy"] as const) {
   const failed=run("R1",{placementId:"P1",state:"failed",reason});
   expect(of([dto({state})],[placement("P1","T1","attention")],{runs:[failed]})().status.warning).toBeNull();
  }
  expect(of([dto({state})],[placement("P1","T1","unknown")])().status.warning).toBe("unknown");
 }
});

test("a row's kind is the turn's: a question with or without its words, a review, another reason; or why its run stopped", () => {
  const turn = (reason: "question" | "review" | "limit") => userBall(reason, "L2", "2026-10-16T10:00:00Z",
    reason === "question" ? { questionId: "L3" } : reason === "review" ? { aboutRunId: "R1" } : { count: 1 });
  const asked = [questionFixture({ id: "L3", taskId: "T1", title: "Which one?", decide: [decideItem("Which one?", [["Yes", "Answer"]])] })];
  expect(of([waiting(turn("question"))], [], { questions: asked })().kind).toEqual({ kind: "question" });
  expect(of([waiting(turn("question"))])().kind).toEqual({ kind: "question" });
  expect(of([waiting(turn("review"))])().kind).toEqual({ kind: "review" });
  expect(of([waiting(turn("limit"))])().kind).toEqual({ kind: "followup", turn: turn("limit") });
  // A question asked of the parent (Consulting parent) is not the reader's.
  expect(of([taskFixture({ state: "doing", ball: { holder: "parent", reason: "question" } })], [], { questions: asked })().kind).toBeNull();
  expect(of([dto({ state: "error" })])().kind).toEqual({ kind: "stopped", failure: "unknown" });
  expect(of([dto({ state: "doing" })], [placement("P1", "T1", "running")])().kind).toBeNull();
});

test("a length is said in minutes, then whole hours, then whole days", () => {
  const minute = 60_000;
  expect(shortLength(10_000)).toEqual({ unit: "minutes", count: 1 });
  expect(shortLength(59 * minute)).toEqual({ unit: "minutes", count: 59 });
  expect(shortLength(150 * minute)).toEqual({ unit: "hours", count: 2 });
  expect(shortLength(24 * 60 * minute)).toEqual({ unit: "days", count: 1 });
});

test("a Working row whose own Run does not run stands for the work below it: running while a child runs, else queued", async () => {
  const { rowSection, representedWork } = await import("../src/domain/row-status");
  const task = screenData(tree({ tasks: [dto({ state: "doing" })] })).tasks[0]!;
  expect(rowSection(task)).toBeNull();
  task.rowFacts.status = null;
  // Only a home row in Working stands for work below.
  expect(representedWork(task)).toBeNull();
  task.homeRow = { taskId: task.id, section: "doing", summary: { done: 0, total: 1 } };
  expect(rowSection(task)).toBe("doing");
  task.rowFacts.childrenRunning = 1;
  expect(representedWork(task)).toBe("running");
  task.rowFacts.childrenRunning = 0;
  expect(representedWork(task)).toBe("queued");
  // Work below that only waits in a queue never counts as running.
  task.rowFacts.status = null;
  expect(representedWork(task)).toBe("queued");
  task.rowFacts.status = null;
  // Its own Run says itself.
  for (const kind of ["running", "queued", "unclear"] as const) {
    task.rowFacts.status = kind === "running" ? { kind, since: null } : { kind };
    expect(representedWork(task)).toBeNull();
  }
  task.rowFacts.status = null;
  for (const section of ["error", "review", "awaited", "held", "todo", "done"] as const) {
    task.homeRow = { ...task.homeRow, section };
    expect(representedWork(task)).toBeNull();
  }
});

test("a row says when its work is expected to report only where it waits on its own work: not in Awaiting review or Idle", async () => {
  const { saysExpectation, saysFinish } = await import("../src/domain/row-status");
  const task = screenData(tree({ tasks: [dto({ state: "doing" })] })).tasks[0]!;
  // A task drawn outside the home list (a dated Done row) says its end words.
  expect(saysFinish(task)).toBe(true);
  for (const [section, says] of [["doing", true], ["review", false], ["awaited", false]] as const) {
    task.homeRow = { taskId: task.id, section, summary: { done: 0, total: 9 } };
    expect(saysFinish(task)).toBe(says);
    expect(saysExpectation(task)).toBe(says);
  }
});

test('the error record selects this failure, not an older failure or a worker with a later Run number', () => {
  for (const [state, reason, expected] of [['succeeded', null, 'no_report'], ['cancelled', 'stopped', 'stopped'], ['failed', 'timeout', 'timeout']] as const) {
    const task = dto({state:'error', log:[logEntry(),logEntry({id:'Lerror',kind:'linked',toState:'error',runId:'R2'})]});
    const runs = [run('R1',{state:'failed',reason:'exit'}),run('R2',{state,reason}),
      run('R3',{placementId:'Pworker',state:'needs_review',reason:'manager_lost'})];
    expect(projectRowFacts({...task,stateLog:task.log,ball:null,question:''},[],runs,0,0,0).kind).toEqual({kind:'stopped',failure:expected});
  }
});

test('a question remains the row meaning after error; a stopped user turn clocks its cause rather than the latest state edge', () => {
  const at='2026-10-16T10:00:00Z';
  const task=dto({state:'doing',log:[logEntry(),logEntry({id:'Lnew',kind:'reported',toState:'doing',at:'2026-10-16T11:00:00Z'})]});
  const turn=userBall('limit','Lreturn',at,{count:1});
  expect(projectRowFacts({...task,stateLog:task.log,ball:turn,question:''},[],[],0,0,0).status).toEqual({kind:'since',at:Date.parse(at)});
  const error=dto({state:'error'});
  expect(projectRowFacts({...error,stateLog:error.log,ball:userBall('question','Lasked',at,{questionId:'Lasked',failure:{key:'Lerror',at}}),question:'Choose'},[],[],0,0,0).kind).toEqual({kind:'question'});
});

test('old failed attention cannot hide the working clock of the own Run, including an error-section turn', () => {
  const task=dto({state:'doing'}), own=placement('P1','T1','attention');
  own.runtime.runningCount=1;
  const facts=projectRowFacts({...task,stateLog:task.log,question:'',ball:userBall('limit','Llimit','2026-10-16T10:00:00Z',{count:1})},[own],
    [run('R1',{state:'failed',reason:'exit'}),run('R2',{state:'running',startedAt:'2026-10-16T11:00:00Z'})],0,0,1);
  expect(facts.status).toEqual({kind:'running',since:Date.parse('2026-10-16T11:00:00Z')});
  expect(facts.warning).toBeNull();
});

test('an error keeps its own cause and clock when an older worker return hits a wake limit', () => {
  const errorAt='2026-10-16T11:00:00Z', returnAt='2026-10-16T10:30:00Z';
  const task=dto({state:'error',log:[logEntry(),logEntry({id:'Lerror',kind:'linked',toState:'error',at:errorAt,runId:'R2'})]});
  const row=projectRowFacts({...task,stateLog:task.log,ball:userBall('limit','Lreturn',returnAt,{count:1}),question:''},[],
    [run('R1',{placementId:'Pworker',state:'failed',reason:'timeout'}),run('R2',{state:'succeeded',reason:null})],0,0,0);
  expect(row.kind).toEqual({kind:'stopped',failure:'no_report'});
  expect(row.status).toEqual({kind:'since',at:Date.parse(errorAt)});
});
