import { planRead, completeReadDemand } from '../src/data/read-demand';
import { setConversationState } from './conversation-fixture';
import { liveRead, receiveFullIndex } from '../src/data/resources';
import { captureReadProof, recordReadProof } from '../src/data/read-model';
import { useConnection } from '../src/data/connection';
import { taskActionsOf, TASK_POLICY } from '@alpacawork/contract/task-policy';
import { hasOpenUserQuestion } from '@alpacawork/raw/questions';
import { projectRowFacts } from '../../backend/src/receiver/row-facts';
import { useLayoutEffect, useState, type ReactNode } from "react";
import { act, fireEvent } from "@testing-library/react";
import { useConversation } from "@/features/coordinator/coordinator";
import { QueryClientProvider } from "@tanstack/react-query";
import { onTestFinished, vi } from "vitest";
import { adapterCatalog, joinBusy, runSpan, timeMarkAt, standingRecord, DEFAULT_FIELDS, DEFAULT_LIMITS, DEFAULT_SCHEMA, isSystemField, eventOf, fieldCatalog, historyEventSchema, homeRowSchema, placeHome, questionSchema, userTurn,
  renderContext, type Ball, type TaskValues } from "@alpacawork/contract";
import { projectedIndexSchema, controlRunSchema, controlTaskSchema, controlTreeSchema,
  timelineNoteOf, taskLogSchema, taskRowFields, taskRowSchema, taskProjectedSearchSchema, taskProjectedViewSchema, viewReportLog,
  type ProjectedIndexDTO, type ControlRunDTO, type ControlTaskDTO, type ControlTaskHeadDTO, type ControlTreeDTO, type TaskHistoryDTO, type TaskRowDTO,
  type TaskProjectedViewDTO, type RequiredPvDTO } from "@alpacawork/contract/control";
import { byTaskNumber, movedAt } from "@alpacawork/contract/moved";
import { taskDetail } from "../src/data/queries";
import { createWorkspaceStore, publishWorkspace, WorkspaceContext } from "../src/data/workspace-store";
import type { Task } from "../src/data/types";
import { queryClient } from "../src/data/query-client";
import { mapWorkspace, type ReadBaselines } from "../src/data/map";
import { resources } from "../src/data/resources";
import { taskBaseline } from "../src/data/notice-model";
import { indexPeople, type PeopleIndex } from "../src/domain/people";

/**
 * The screen's data as the server sends it: a whole control tree, as the server reads it (the control contract fixture), and
 * what the server projects of it. `dto` is one task, `taskFixture` one with its ball and project, `tree` a whole tree
 * with the projection a test gives (`homeFixture`, `questionFixture`, `historyFixture`), `run` one run record.
 * `indexOf` makes contract-shaped index rows and `viewsOf` the opened views; `screenData` maps them as Workspace does
 * and puts opened views, History pages and closed pages in the query cache. The fixture derives no ball, home row,
 * project, question or History event: a test states what the server sends, and checks that the screen draws it.
 */
export const at = "2026-09-24T09:00:00Z";
/**
 * The fixture's project Task, in every tree unless a test gives its own row with this ID. A task written without a
 * parent (or with a null one) is right under it: the top level, as the server has it.
 */
export const PROJECT_TASK = "P100";
type TaskLog = ControlTaskDTO["log"][number];
type HomeRowDTO = ProjectedIndexDTO["home"][number];
type HistoryEvent = TaskHistoryDTO["events"][number];
type QuestionDTO = NonNullable<TaskProjectedViewDTO["questions"]>[number];
/**
 * A log entry, by default a creation; a creation and a change of the mark say whether the user asked (by default not).
 * A question asks its title unless the test says what (`decide`): the screen draws choices from the view's question
 * (questionFixture), never from this record.
 */
export const logEntry = (overrides: Partial<TaskLog> = {}): TaskLog => {
  const kind = overrides.kind ?? "created";
  return taskLogSchema.parse({
    id: "L1", kind, at, title: null, description: null, actor: { kind: "human" }, fromState: null, toState: null,
    ...(kind === "created" || kind === "user_request_changed" ? { userRequested: false } : {}),
    ...(kind === "asked" ? { decide: [{ decide_question: overrides.title ?? "Question" }] } : {}), ...overrides,
  });
};
/** A task's parent: a task with none is right under the fixture's project; a project Task with none is a top one. */
const parentOf = (task: Partial<Pick<ControlTaskDTO, "kind" | "parentId">>) =>
  task.parentId ?? (task.kind === "project" ? null : PROJECT_TASK);
/** The Task as a write answers with it: everything but its History. */
export const headOf = ({ log: _history, ...head }: ControlTaskDTO): ControlTaskHeadDTO => head;
/** A task, or with `kind: "project"` a project Task (a top one unless it names its parent project). */
/** A fixture's own shorthand: `body`, the text of the Task's `notes` value (empty: no values). */
type TaskOverrides = Partial<ControlTaskDTO> & { body?: string };
/** A fixture's body as values: a project's own words are its policy (project_policy), a task's its notes. */
const bodyValues = (body: string, kind?: string) => body.trim() ? { [kind === "project" ? "project_policy" : "notes"]: body.trim() } : {};
export const dto = ({ body, ...overrides }: TaskOverrides = {}): ControlTaskDTO => controlTaskSchema.parse({
  ...(overrides.kind === "project" ? { settings: { color: "#39659b" } } : {}),
  path: `tasks/${overrides.id ?? "T1"}`, kind: "task", userRequested: false,
  lifecycle: "active", title: "Task one", state: "doing", baseState: overrides.baseState ?? (overrides.state === "held" ? "doing" : overrides.state ?? "doing"), hold: overrides.hold ?? overrides.state === "held", version: 1,
  allowedActions: taskActionsOf({ baseState: overrides.baseState ?? (overrides.state === "held" ? "doing" : overrides.state ?? "doing"), hold: overrides.hold ?? overrides.state === "held", userRequested: overrides.userRequested ?? false,
    openUserQuestion: hasOpenUserQuestion(overrides.log ?? []) }), policyVersion: TASK_POLICY.version,
  hash: "a".repeat(64), values: bodyValues(body ?? "Body", overrides.kind), log: [logEntry({ userRequested: overrides.userRequested ?? false })], ...overrides,
  id: overrides.id ?? "T1", parentId: parentOf(overrides),
});
/** A project Task: it holds no work of its own, so it waits on no one (`todo`). */
export const project = (overrides: TaskOverrides = {}): ControlTaskDTO =>
  dto({ id: PROJECT_TASK, title: "default", state: "todo", ...overrides, kind: "project" });
/** A task with what the server projects of it onto its row: the ball it waits on (none unless given) and its project. */
export type TaskFixture = { task: ControlTaskDTO; ball?: Ball; projectId?: string };
export function taskFixture({ ball, projectId, ...task }: Partial<ControlTaskDTO> & { ball?: Ball | null; projectId?: string } = {}): TaskFixture {
  return { task: task.kind === "project" ? project(task) : dto(task), ...(ball ? { ball } : {}), ...(projectId ? { projectId } : {}) };
}
/** The user's turn as the server sends it: `key` and `at` tell it from another turn; only its reason's detail is given. */
export const userBall = (reason: Extract<Ball, { holder: "user" }>["reason"], key: string, at: string,
  details: Partial<Pick<Extract<Ball, { holder: "user" }>, "questionId" | "aboutRunId" | "count" | "code" | "failure">> = {}): Ball =>
  ({ holder: "user", reason, at, key, questionId: null, aboutRunId: null, count: null, code: null, failure: null, ...details });
/**
 * The home list as the server sends it, in its order (index-feed's homeRows): a row has no children unless given. The index lists its rows not finished; its Done rows are the top level's finished page.
 */
export const homeFixture = (rows: (Pick<HomeRowDTO, "taskId" | "section"> & Partial<HomeRowDTO>)[]): HomeRowDTO[] =>
  rows.map((row) => homeRowSchema.parse({ summary: { done: 0, total: 0 }, ...row }));
/**
 * One question of a `decide` value as its asking record fixes it: what to decide and its choices, each its name, its
 * description and, on the recommended one, why. `more` adds its note (`decide_note`) and what stopping means (`decide_stop`).
 */
export const decideItem = (question: string, choices: readonly (readonly [name: string, detail?: string, recommended?: string])[] = [],
  more: { decide_note?: string; decide_stop?: string } = {}) => ({
  decide_question: question,
  ...(choices.length ? { decide_choices: choices.map(([name, detail, recommended]) => ({ decide_choice: name,
    ...(detail === undefined ? {} : { decide_choice_detail: detail }), ...(recommended === undefined ? {} : { decide_choice_recommended: recommended }) })) } : {}),
  ...more,
});
/**
 * An open question as its Task's view sends it: the asking log's ID and what it asks as fixed when it was asked (the
 * screen draws its choices from it), T1's and asked of the user unless given. Its `asked` log entry and ball are the test's.
 */
export const questionFixture = (question: Pick<QuestionDTO, "id" | "decide"> & Partial<QuestionDTO>): QuestionDTO =>
  questionSchema.parse({ taskId: "T1", destination: { kind: "user" }, applicable: true, title: "Question", summary: "Which one?",
    askedAt: at, state: "open", ...question });
/** A History page's events as the server sends them, newest first: each T1's own record unless given, a question open. */
export const historyFixture = (events: (Pick<HistoryEvent, "id" | "kind"> & Partial<HistoryEvent>)[]): HistoryEvent[] =>
  events.map((event) => historyEventSchema.parse({ taskId: "T1", fromChild: false, at,
    ...(event.kind === "question" || event.kind === "review" ? { open: true } : {}), state: null, by: null, title: "", summary: "", ...event }));
/**
 * A test's shorthand for stating that each of `entries` (a task's full log entries) is its own History
 * event as the server sends it (contract eventOf): `only`, just those entries'. An asked entry is open unless the test
 * gives its closure (`closed` here).
 */
export function recordHistory(taskId: string, entries: readonly (Pick<TaskLog, "id" | "kind" | "at" | "fromState" | "toState" | "urgentReason" | "actor" | "title" | "description"> & { closed?: unknown })[],
  { only, closed = [], fromChild = false }: { only?: readonly string[]; closed?: readonly string[]; fromChild?: boolean } = {}): HistoryEvent[] {
  return entries.flatMap((log) => {
    const kind = eventOf(log);
    if (!kind || only && !only.includes(log.id)) return [];
    return [historyEventSchema.parse({ id: log.id, kind, taskId, fromChild, at: log.at,
      ...(kind === "question" || kind === "review" ? { open: !log.closed && !closed.includes(log.id) } : {}), state: log.toState,
      by: log.actor.kind === "placement" ? null : log.actor.kind, title: log.title ?? "", summary: log.description ?? "" })];
  });
}
/**
 * The server's answer to the time view's reads (GET /api/task/timeline), for the tree a test made, put in the cache as
 * each read is made (so the screen reads it at once): each Task it asks for (listed or below a folded one) with its
 * notes, the History events the test stated (`history`). It answers until the test ends.
 */
export const fixtureHistory = new WeakMap<PeopleIndex, Record<string, HistoryEvent[]>>();
/** The projection every fixture answer names: the fixture index's generation, before any change. */
export const served0 = { generation: "a", sourcePv: 0 } as { generation: string; sourcePv: ProjectedIndexDTO["sourcePv"] };
type AxisFixture = Pick<ControlTreeDTO, "tasks" | "runs"> & { history?: Record<string, HistoryEvent[]>; balls?: ControlTreeDTO["balls"] };
/** The listed rows above a Task, as the server counts a Run under them. */
function lanesAbove(value: AxisFixture, listed: string[], id: string) {
  const above: string[] = [];
  for (let parent = value.tasks.find(task => task.id === id)?.parentId; parent; parent = value.tasks.find(task => task.id === parent)?.parentId)
    if (listed.includes(parent)) above.push(parent);
  return above;
}
function timelineIds(value: AxisFixture, listed: string[], folded: string[]) {
  const below = (id: string): boolean => { const parent = value.tasks.find(task => task.id === id)?.parentId; return !!parent && (folded.includes(parent) || below(parent)); };
  return value.tasks.map(task => task.id).filter(id => listed.includes(id) || below(id));
}
/** The same complete chronology answer for cached component fixtures and mock HTTP callers. */
export function timelineAnswer(value: AxisFixture, listed: string[], folded: string[]) {
  const events = timelineIds(value, listed, folded).flatMap(id => (value.history?.[id] ?? [])
    .map(event => ({ kind: "note" as const, taskId: id, event: timelineNoteOf(event) })));
  const belowRuns: Record<string, [string, number, number][]> = {};
  for (const run of value.runs) {
    const span = runSpan(run, null);
    if (span && span.to !== null) for (const lane of lanesAbove(value, listed, run.taskId)) (belowRuns[lane] ??= []).push([run.id, span.from, span.to]);
  }
  return { rows: [], runs: [], belowRuns, events, anchors: {}, placements: [], nextAfter: null, ...served0 };
}
export function timelineAxisAnswer(value: AxisFixture, listed: string[], folded: string[]) {
  const ids = timelineIds(value, listed, folded);
  const spans: [number, number | null][] = [];
  const starts: number[] = [];
  for (const task of value.tasks.filter(task => ids.includes(task.id))) {
    const logs = new Map(task.log.map(log => [log.id, log]));
    const standing = standingRecord({ state: task.state, stateLog: task.log, ball: value.balls?.[task.id] ?? null });
    for (const log of task.log) starts.push(Date.parse(log.causeAt ?? log.at));
    for (const event of value.history?.[task.id] ?? recordHistory(task.id, task.log)) {
      const at = Date.parse(timeMarkAt(event, logs));
      if (standing(event.id)) spans.push([at, at]);
    }
  }
  for (const run of value.runs.filter(run => ids.includes(run.taskId) || lanesAbove(value, listed, run.taskId).length)) {
    const span = runSpan(run, null);
    if (span) spans.push([span.from, span.to]);
  }
  return { busy: joinBusy(spans), earliest: starts.length ? Math.min(...starts) : null, ...served0 };
}

const servedTimelines = new WeakSet<Served>();
export function serveTimeline(value: Served) {
  if (servedTimelines.has(value)) return;
  servedTimelines.add(value);
  const stop = queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (event.type !== "added" || key[0] !== "task-timeline" || key[1] !== value.root) return;
    const split = (ids: unknown) => String(ids).split(",").filter(Boolean);
    const axis = key[2] === "axis";
    const listed = split(key[axis ? 4 : 3]), folded = split(key[axis ? 5 : 4]);
    if (axis) {
      queryClient.setQueryData(key, timelineAxisAnswer(value, listed, folded));
      return;
    }
    queryClient.setQueryData(key, { pages: [timelineAnswer(value, listed, folded)], pageParams: [null] });
    const index = queryClient.getQueryData<ProjectedIndexDTO>(['index']);
    if (index) recordReadProof(event.query, captureReadProof(index, key));
  });
  onTestFinished(() => { stop(); servedTimelines.delete(value); });
}
/** What the server projects of a tree and sends with it, as a test states it: the fixture derives none of it. */
export type Projection = {
  /** The project a task's row names, where the test gave one (taskFixture); see owningProject. */
  projectIds: Record<string, string>;
  /** The home list (homeFixture). */
  home: HomeRowDTO[];
  /** Open questions with what they ask, oldest first (questionFixture): each in its Task's view, the first's title on its row. */
  questions: QuestionDTO[];
  /** Each Task's own human questions and reviews as projected by the server, keyed by that Task. */
  userQuestions: Record<string, TaskProjectedViewDTO['userQuestions']>;
  userReviews: Record<string, TaskProjectedViewDTO['userReviews']>;
  /** Each task's first History page, newest first (historyFixture); a task without one has an empty page. */
  history: Record<string, HistoryEvent[]>;
  /** The server's count of each task's children (counts.children); a task not given has none. */
  children: ProjectedIndexDTO["counts"]["children"];
  /** Own and descendant cost as the server sends it; the fixture derives neither totals nor running starts. */
  usage: Record<string, Pick<TaskRowDTO, "usage" | "usageBelow"> & Partial<Pick<TaskRowDTO, "runsBelow">>>;
  /** The server's count of Runs running on a Task and below it; the row only says it. */
  runningRuns: Record<string, number>;
};
export type FixtureTree = ControlTreeDTO & Projection;
/** A tree the fixture answers from: one `tree` made, or a bare control tree, of which nothing is projected. */
type Served = ControlTreeDTO & Partial<Projection>;
export const tree = (overrides: Omit<Partial<FixtureTree>, "tasks"> & { tasks?: (ControlTaskDTO | TaskFixture)[] } = {}): FixtureTree => {
  const { projectIds = {}, home = [], questions = [], userQuestions = {}, userReviews = {}, history = {}, children = {}, usage = {}, runningRuns = {}, tasks: given = [dto()], ...read } = overrides;
  const fixtures = given.map((item): TaskFixture => "task" in item ? item : { task: item });
  const listed = fixtures.map(({ task }) => ({ ...task, parentId: parentOf(task) }));
  const tasks = listed.some(task => task.id === PROJECT_TASK) ? listed : [...listed, project()];
  return { ...controlTreeSchema.parse({
    root: "/fixture",
    attachmentBytes: 50 * 1024 * 1024, profiles: [{ key: "claude", choices: [], without: {} }, { key: "codex", choices: [], without: {} }],
    // The app's default fields and schema, as no project has its own; each task's values are its own.
    fieldCatalog: [...DEFAULT_FIELDS],
    projectSchemas: Object.fromEntries(tasks.filter(task => task.kind === "project")
      .map(task => [task.id, { fields: [...DEFAULT_SCHEMA], from: null }])),
    taskValues: Object.fromEntries(tasks.map(task => [task.id, task.values])),
    working: [], historyFacts: { answerTexts: {}, placementRoles: {}, runRoles: {}, deliveries: [], coordinatorRuns: {} }, dialogues: [], requestedByUser: {}, errors: [], writable: true, ...read,
    tasks, placements: read.placements ?? [], runs: read.runs ?? [], requests: read.requests ?? [], replies: read.replies ?? {},
    balls: { ...read.balls, ...Object.fromEntries(fixtures.flatMap(({ task, ball }) => ball ? [[task.id, ball]] : [])) },
  }), projectIds: { ...projectIds, ...Object.fromEntries(fixtures.flatMap(({ task, projectId }) => projectId ? [[task.id, projectId]] : [])) },
  home, questions, userQuestions, userReviews, history, children, usage, runningRuns };
};

/**
 * The project a task's row names: the one the test gave, else a project Task's own and the fixture's project for any
 * other task (a task in another project is given its project).
 */
const owningProject = (task: Pick<ControlTaskDTO, "id" | "kind">, value: Served) =>
  value.projectIds?.[task.id] ?? (task.kind === "project" ? task.id : PROJECT_TASK);
/** The open questions the test gave a task, oldest first. */
const questionsOf = (taskId: string, value: Served) => (value.questions ?? []).filter((question) => question.taskId === taskId);
/** The active project Tasks of `value`, each after the project it is in, as the index lists them (without numbers). */
function listedProjects(value: ControlTreeDTO) {
  const active = value.tasks.filter(task => task.kind === "project" && task.lifecycle === "active");
  const listed: { id: string; title: string; parentId: string | null; depth: number; color: string; cwd: string | null }[] = [];
  const list = (parentId: string | null, depth: number) => {
    for (const item of active.filter(each => (active.some(other => other.id === each.parentId) ? each.parentId : null) === parentId)
      .sort(byTaskNumber)) {
      listed.push({ id: item.id, title: item.title, parentId: item.parentId, depth, color: item.settings!.color, cwd: null });
      list(item.id, depth + 1);
    }
  };
  list(null, 0);
  return listed;
}
/** The listed projects whose subtree holds a task of `project`: the scopes it is counted and listed in. */
function scopesOf(id: string, listed: readonly { id: string; parentId: string | null }[]) {
  const scopes: string[] = [];
  for (let at: string | null = id; at !== null;) {
    const item = listed.find(each => each.id === at);
    if (!item) break;
    scopes.push(item.id);
    at = item.parentId;
  }
  return scopes;
}

/** The row the server makes of one task of `value`; operational facts use the server projection Owner. */
export function rowOf(task: ControlTaskDTO, value: Served = tree()): TaskRowDTO {
  task = controlTaskSchema.parse(task);
  const requests = value.requests.filter((request) => request.taskId === task.id);
  const fields = taskRowFields({ ...task, log: task.log.map(entry => entry.kind === "request_accepted" || entry.kind === "review_sent_back"
    ? { ...entry, startsEstimateRound: requests.some(request => request.id === entry.id)
      ? requests.some(request => request.id === entry.id && request.recipientRole === "owner") : true } : entry) });
  const ball = value.balls[task.id] ?? null;
  const question = questionsOf(task.id, value)[0]?.title ?? "";
  const rowFacts = projectRowFacts({ ...fields, ball, question }, value.placements,
    value.runs.filter(run => run.taskId === task.id), value.children?.[task.id]?.runningBelow ?? 0, value.children?.[task.id]?.runningBelow ?? 0, value.runningRuns?.[task.id] ?? 0);
  const tasks = [...value.tasks.filter(each => each.id !== task.id), task];
  // Its position, by the server's own rule: work is a queued, running or needs-review Run (screen-derive's homeWorking).
  const homeWorking = new Set(value.runs.filter(run => run.state === "queued" || run.state === "running" || run.state === "needs_review").map(run => run.taskId));
  const position = placeHome(tasks.map(each => ({ ...each, summary: { done: 0, total: 0 } })), value.balls, homeWorking)
    .find(each => each.taskId === task.id)?.position ?? null;
  const moved = movedAt(tasks.map(each =>
    ({ id: each.id, parentId: each.parentId, updatedAt: each.log.at(-1)?.at ?? null })), value.runs);
  return taskRowSchema.parse({ ...fields, ...value.usage?.[task.id], movedAt: moved.get(task.id) ?? 0, rowFacts: { ...rowFacts, position }, projectId: owningProject(task, value), startOrder: value.startOrder?.[task.id] ?? null, ball, notice: { ...fields.notice, turnKey: userTurn(ball)?.key ?? null },
    question: questionsOf(task.id, value)[0]?.title ?? "" });
}
/**
 * A fixture task's values: its body as the `notes` field, in the default schema, with the context they render as.
 */
const valuesOf = (task: ControlTaskDTO) => valuesView(task.values as TaskValues);
/** `field list` as the server answers it: the app's default fields, none changed. */
export const fieldList = () => ({ fields: DEFAULT_FIELDS.map(def => ({ ...def,
  system: isSystemField(def.id), default: true, stored: false,
  use: { projects: [], fields: DEFAULT_FIELDS.filter(each => each.members.includes(def.id)).map(each => each.id), defaultSchema: DEFAULT_SCHEMA.includes(def.id) } })) });
/** An opened task's values as the server sends them: in the default schema, with the context they render as. */
export const valuesView = (values: TaskValues) =>
  ({ values, fields: [...DEFAULT_SCHEMA], from: null, context: renderContext(DEFAULT_SCHEMA, values, fieldCatalog([])) });
const viewOf = (task: ControlTaskDTO, value: Served) => ({ task: { ...task,
  log: viewReportLog(task.log, new Set(value.placements.filter(item => item.taskId === task.id && item.responsible).map(item => item.id))) },
  // What activity files say reaches the screen through the list alone: a view carries none of it.
  placements: value.placements.filter(placement => placement.taskId === task.id)
    .map(({ runtime: { lastOutputAt: _o, activityKind: _k, toolName: _t, ...runtime }, ...placement }) => ({ ...placement, runtime })),
  runs: value.runs.filter(run => value.placements.some(placement => placement.taskId === task.id && placement.headRunId === run.id))
    .map(({ activity: _a, errorCause: _e, ...run }) => run),
  requestHeads: value.requests.filter((request) => request.taskId === task.id).map(({ body, ...request }) => ({
    ...request, headline: body.split("\n", 1)[0] ?? "", bodyBytes: Buffer.byteLength(body) })),
  values: valuesOf(task),
  reply: value.replies[task.id] ?? null, questions: questionsOf(task.id, value), userQuestions: value.userQuestions && task.id in value.userQuestions ? value.userQuestions[task.id] : [], requestedByUser: value.requestedByUser[task.id] ?? null,
  userReviews: value.userReviews && task.id in value.userReviews ? value.userReviews[task.id] : [] });
/** Each task's opened view as the projection answers it: its own row without the list's numbers, its ancestors' heads. */
export const viewsOf = (value: Served, sourcePv = 0): TaskProjectedViewDTO[] => value.tasks.map((task) => {
  const view = viewOf(task, value);
  const { movedAt: _m, usageBelow: _u, runsBelow: _r, rowFacts: _f, ...row } = rowOf(task, value);
  const ancestors = []; let parent = task.parentId;
  while (parent) {
    const found = value.tasks.find(item => item.id === parent) ?? (parent === PROJECT_TASK ? project() : undefined);
    if (!found) break;
    ancestors.unshift({ id: found.id, title: found.title, parentId: found.parentId, kind: found.kind, lifecycle: found.lifecycle });
    parent = found.parentId;
  }
  return taskProjectedViewSchema.parse({ ...view, generation: "a", sourcePv, row, ancestors });
});
export function indexOf(value: Served, rev = 1, requiredPv: Partial<RequiredPvDTO> = {}): ProjectedIndexDTO {
  const rows = value.tasks.map((task) => rowOf(task, value));
  const home = value.home ?? [];
  // Each scope's numbers are the given rows counted, so the screen adds none up: `root` is every project's, a listed
  // project's its subtree's, nested projects included. Its menu's orange is its Your turn rows, its blue the Tasks a Run
  // works on; its closed Tasks are its Done rows and its shelved Tasks.
  const listed = listedProjects(value);
  const projectIds = new Map(rows.map((row) => [row.id, row.projectId]));
  const scopes = ["root", ...listed.map(({ id }) => id)];
  const within = (scope: string, taskId: string) =>
    scope === "root" || scopesOf(projectIds.get(taskId) ?? PROJECT_TASK, listed).includes(scope);
  const listing = (scope: string, section: HomeRowDTO["section"]) =>
    home.filter((row) => row.section === section && within(scope, row.taskId)).length;
  const running = new Set(value.runs.filter(item => item.state === "running").map(item => item.taskId));
  const menu = (scope: string) => ({ turn: listing(scope, "review"),
    running: rows.filter(row => running.has(row.id) && within(scope, row.id)).length });
  return projectedIndexSchema.parse({ restoreId: "initial", generation: "a", rev, sourcePv: Math.max(0, ...Object.values(requiredPv).flatMap(Object.values)),
    requiredPv: { view: {}, history: {}, page: {}, timeline: {}, search: {}, ...requiredPv }, root: value.root, tasks: rows,
    placements: value.placements, runs: value.runs, home: home.filter((row) => row.section !== "done"),
    projectShelfVersion: "a".repeat(64),
    projects: listed.map(project => ({ ...project, counts: menu(project.id) })),
    profiles: value.profiles, attachmentBytes: value.attachmentBytes,
    errors: value.errors, writable: value.writable, staleIds: [],
    person: { settings: null, notices: null, coordinator: null }, presence: { state: 'away', until: null }, host: null, coordinatorWork: null, launchMemory: { agent: null, values: {} },
    counts: { children: value.children ?? {},
      closed: Object.fromEntries(scopes.map(scope => [scope, { finished: listing(scope, "done"), freshFinished: 0,
        shelved: rows.filter(row => row.lifecycle !== "active" && within(scope, row.id)).length }])),
      tasks: Object.fromEntries(scopes.map(scope => [scope, rows.filter(row => row.kind === "task" && within(scope, row.id)).length])),
      home: Object.fromEntries(scopes.map(scope => [scope, { doing: listing(scope, "doing"), error: listing(scope, "error"), review: listing(scope, "review"), awaited: listing(scope, "awaited"),
        held: listing(scope, "held"), todo: listing(scope, "todo") }])), all: menu("root") } });
}
export const searchAnswer = (ids: string[] = [], lines: Record<string, string> = {}, nextAfter: string | null = null, total = ids.length) =>
  taskProjectedSearchSchema.parse({ rows: ids.map(id => {
    const { stateLog, ball, question, ...row } = rowOf(dto({ id }));
    return { ...row, ...(ball ? { ball } : {}), ...(question ? { question } : {}),
      movedAt: Date.parse(at), stateMark: null, latestReport: null, childCounts: { live: 0, finished: 0 } };
  }), ancestors: [], lines, nextAfter, total, ...served0 });
export function seedSearch(root: string, text: string, ids: string[]) {
  queryClient.setQueryData(resources.taskSearch(root, text.toLowerCase(), null).queryKey,
    { pages: [searchAnswer(ids)], pageParams: [null] });
}
/** The opened views of every task, as if each had been read. */
export function seedViews(value: Served) {
  for (const view of viewsOf(value)) {
    // A changed view replaces the cached one, as the feed's delta has it read again.
    const key = resources.taskView(value.root, view.task.id).queryKey;
    if (JSON.stringify(queryClient.getQueryData(key)) !== JSON.stringify(view)) queryClient.setQueryData(key, view);
  }
}
/** Each task's first History page as the test gave it, supplied through the same Query key the reader requests. */
export function seedHistory(value: Served) {
  for (const task of value.tasks) {
    const page: TaskHistoryDTO = { events: value.history?.[task.id] ?? [], nextBefore: null };
    const key = resources.history(value.root, task.id).queryKey;
    const data = { pages: [page], pageParams: [null] };
    if (JSON.stringify(queryClient.getQueryData(key)) !== JSON.stringify(data)) queryClient.setQueryData(key, data);
  }
}
/** The read marks of `tasks` and of the fixture's project, which is never news. */
export const baselines = (tasks = [dto()]): ReadBaselines => ({
  checkpoint: { at: "2026-09-24T10:00:00Z", tasks: Object.fromEntries([project(), ...tasks].map((task) => [task.id, taskBaseline(rowOf(dto(task)))])) },
  reads: {}, firstSeen: new Map(),
});
export function screenData(value: Served = tree(), baseline = baselines(value.tasks)) {
  const index = indexOf(value);
  // Reads the server would answer, put in the cache now and again by TestWorkspace (a test may clear it in between).
  const seed = () => {
    const connection = useConnection.getState();
    const openingLive = connection.state === 'connecting' && !connection.fresh && !connection.offline;
    const heldIndex = queryClient.getQueryData<ProjectedIndexDTO>(['index']);
    const nextIndex = { ...(heldIndex?.root === index.root ? heldIndex : index), tasks: index.tasks, placements: index.placements, runs: index.runs, projects: index.projects, projectShelfVersion: index.projectShelfVersion, writable: index.writable };
    if (JSON.stringify(heldIndex) !== JSON.stringify(nextIndex)) queryClient.setQueryData(['index'], nextIndex);
    const live = liveRead(queryClient);
    if (!live || live.root !== nextIndex.root || live.generation !== nextIndex.generation) receiveFullIndex(queryClient, nextIndex);
    if (openingLive)
      useConnection.setState({ state: 'live', fresh: true, writable: index.writable, offline: false });
    const serverSettings = resources.serverSettings(value.root).queryKey;
    if (!queryClient.getQueryData(serverSettings)) queryClient.setQueryData(serverSettings, {
      hash: "a".repeat(64), limits: { ...DEFAULT_LIMITS }, agentsText: "agents: {}\n", agents: {}, catalog: adapterCatalog(),
    });
    seedViews(value);
    // The workspace's fields as `field list` answers them: the app's defaults, none changed.
    const fieldsKey = ["fields", value.root];
    if (!queryClient.getQueryData(fieldsKey)) queryClient.setQueryData(fieldsKey, fieldList());
    seedHistory(value);
    const pageRows = value.tasks.map((task) => {
      const { stateLog, ball, question, ...fields } = rowOf(task, value);
      const stateMark = [...stateLog].reverse().find(entry => entry.toState === task.state) ?? null;
      const latestReport = [...stateLog].reverse().find(entry => entry.kind === "reported") ?? null;
      return { ...fields, ...(ball ? { ball } : {}), ...(question ? { question } : {}),
        movedAt: Date.parse(task.log.at(-1)?.at ?? at), stateMark, latestReport, childCounts: { live: 0, finished: 0 } };
    });
    const page = (rows: typeof pageRows) => ({ pages: [{ rows, total: rows.length, nextAfter: null, ...served0 }], pageParams: [null] });
    // The top level's finished page is the home list's Done rows, in their order; the shelved page every shelved task.
    const finishedKey = resources.finished(value.root, null).queryKey;
    const finishedPage = page((value.home ?? []).flatMap(item => item.section === "done" ? pageRows.filter(row => row.id === item.taskId) : []));
    if (JSON.stringify(queryClient.getQueryData(finishedKey)) !== JSON.stringify(finishedPage)) queryClient.setQueryData(finishedKey, finishedPage);
    const shelvedKey = resources.shelved(value.root, null).queryKey;
    const shelvedPage = page(pageRows.filter(row => row.lifecycle !== "active"));
    if (JSON.stringify(queryClient.getQueryData(shelvedKey)) !== JSON.stringify(shelvedPage)) queryClient.setQueryData(shelvedKey, shelvedPage);
    // These are the actual server answers supplied by this fixture. Unrelated reads
    // (personal state, conversation, searches) retain their own acquisition evidence.
    const supplied = new Set([['index'], finishedKey, shelvedKey,
      ...viewsOf(value).map(view => resources.taskView(value.root, view.task.id).queryKey),
      ...value.tasks.map(task => resources.history(value.root, task.id).queryKey)].map(key => JSON.stringify(key)));
    for (const query of queryClient.getQueryCache().getAll())
      if (supplied.has(JSON.stringify(query.queryKey))) {
        recordReadProof(query, captureReadProof(queryClient.getQueryData<ProjectedIndexDTO>(['index']) ?? index, query.queryKey));
        // A screen fixture explicitly supplies a new server answer. This resets its simulated demand,
        // but deliberately creates no GetTicket/acquisition/storage qualification. Transport tests use real resources.
        completeReadDemand(query, planRead(query));
      }
  };
  seed();
  const mapped = mapWorkspace(index, baseline);
  // Each task with its opened view, so a test can hand one straight to a reader part.
  const views = new Map(viewsOf(value).map((view) => [view.task.id, view]));
  const opened = (task: Task) => taskDetail(task, views.get(task.id)!);
  const people = indexPeople(index);
  fixtureHistory.set(people, Object.fromEntries(value.tasks.map(task => [task.id, value.history?.[task.id] ?? recordHistory(task.id, task.log)])));
  return { ...mapped, tasks: mapped.tasks.map(opened),
    shelved: mapped.shelved.map((item) => ({ ...item, task: opened(item.task) })),
    people, seed, drawing: { root: value.root, restoredAt: null as number | null },
    info: { root: value.root, rev: index.rev, checkpointAt: baseline.checkpoint.at, writable: value.writable,
      errors: value.errors, staleIds: [] as string[], runs: value.runs, profiles: value.profiles, attachmentBytes: value.attachmentBytes, projects: index.projects,
      presence: index.presence, host: index.host, coordinatorWork: index.coordinatorWork, launchMemory: index.launchMemory, counts: index.counts, home: index.home } };
}
export function TestWorkspace({ children, data: provided }: { children: ReactNode; data?: ReturnType<typeof screenData> }) {
  const [initial] = useState(() => provided ?? screenData());
  const data = provided ?? initial;
  const [store] = useState(() => { data.seed(); return createWorkspaceStore(data); });
  useLayoutEffect(() => publishWorkspace(store, data), [store, data]);
  // As Workspace does: the conversation is read in the workspace shown.
  useLayoutEffect(() => { setConversationState({ root: data.info.root }); }, [data]);
  return <QueryClientProvider client={queryClient}><WorkspaceContext value={store}>{children}</WorkspaceContext></QueryClientProvider>;
}

export const run = (id = "R1", overrides: Partial<ControlRunDTO> = {}): ControlRunDTO => controlRunSchema.parse({
  id, placementId: "P1", agent: "codex", modelId: null, effort: null, launchValues: {},
  requestId: `request-${id}`, caller: null, resumes: null, continues: false,
  cwd: `/fixture/runs/${id}`,
  session: { provider: "codex", id: `session-${id}` }, state: "succeeded", reason: null, into: null, takesInput: false, activity: null,
  createdAt: at, startedAt: at, endedAt: at, usage: null, taskId: "T1", ...overrides,
});

/** A pointer that can hover (a mouse), as a desktop's is; undone by vi.restoreAllMocks. Without it the tests' pointer cannot. */
export function pointerCanHover() {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ ...original(query), matches: query === "(hover: hover)" }));
}

export function narrowScreen(matches: boolean) {
  const original = window.matchMedia;
  const listeners = new Set<() => void>();
  let current = matches;
  window.matchMedia = ((query: string) => ({
    get matches() { return query.includes("700px") ? current : false; }, media: query, onchange: null,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    set: (next: boolean) => { current = next; act(() => { listeners.forEach((listener) => listener()); }); },
    restore: () => { window.matchMedia = original; },
  };
}

/** A recipient label in a test's document; it carries no separate viewing context. */
export function labelled(doc: import('../src/features/coordinator/editor/document').Document, task: Pick<Task,'id'|'title'>): import('../src/features/coordinator/editor/document').Document {
  return {...doc,content:[{...doc.content[0]!,content:[{type:'taskLabel',attrs:{id:task.id,title:task.title}},...(doc.content[0]!.content??[])]},...doc.content.slice(1)]};
}

/** A selected answer's shown Task versions; tests with a responsible pass its revision explicitly. */
export const answerTask = (task: string | { id: string; hash?: string }, responsibleRevision: number | null = null) => ({
  id: typeof task === 'string' ? task : task.id, hash: typeof task === 'string' ? 'a'.repeat(64) : task.hash ?? 'a'.repeat(64), responsibleRevision,
});

/** A task named in a text, followed as a person does: pressed, its card comes up, and its Open goes to the task. */
export function openReference(reference: Element) {
  fireEvent.click(reference);
  const open = reference.ownerDocument.querySelector<HTMLElement>("[data-badge-card] [data-task-card-open]");
  if (!open) throw new Error("no task card came up for the reference");
  fireEvent.click(open);
}

/**
 * A launch profile as serve lists it (the contract's AgentChoice rows): each row's values in written order, the first
 * one initial ("-" is null, "none", and only leads); a row in `optional` written empty has only null;
 * `without`: the rows each model omits.
 */
export function launchProfile(key: string, rows: Record<string, string[]>, optional: readonly string[] = [],
  without: Record<string, string[]> = {}): ControlTreeDTO["profiles"][number] {
  return { key, without, choices: Object.entries(rows).map(([row, values]) => {
    const required = !optional.includes(row);
    const candidates = values.length || required ? values.map(value => value === "-" ? null : value) : [null];
    return { key: row, candidates, initial: candidates[0] ?? null, required, active: true };
  }) };
}
