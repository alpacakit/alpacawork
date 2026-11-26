/**
 * analysis trace | findings | at | changes: one load of a task's records (its whole subtree) at one read point, then the
 * answer counted from that load alone (timeline.ts, findings.ts). The caller has authorized reading the task.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { ControlStore } from '@alpacawork/db';
import { RUN_FILES, RUN_STEPS_PAGE_LIMIT, runFolder, type RunRecord } from '@alpacawork/contract/run';
import { analysisStepsMissingSchema } from '@alpacawork/contract/analysis';
import type { AnalysisAtInput, AnalysisAtView, AnalysisChangesInput, AnalysisChangesView, AnalysisHead, AnalysisFindingsInput, AnalysisFindingsView, AnalysisTraceInput,
  AnalysisTraceScope, AnalysisTraceView } from '@alpacawork/contract/analysis';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import type { InstructionLabel, TaskBaseState } from '@alpacawork/raw';
import { taskLogsOf } from '../control/task-history.js';
import { readConditions } from '../runs/conditions.js';
import { readRunStepIndex } from '../runs/run-steps.js';
import { serverZone } from './calendar.js';
import type { Activity } from './presence.js';
import { Kept, type Slices } from './slices.js';
import { inDays } from './calendar.js';
import { changeEvents, type ChangeRun } from './changes.js';
import type { FactLaunch } from './facts.js';
import { allRules, findFindings, STEP_RULES, thresholdsOf } from './findings.js';
import { breakdown, iso, isOpen, timedSteps, lanes, marks, sceneUrl, segments, situationAt, spans, waited, wholePeriod,
  type Interval, type TraceRecords, type TraceRequest, type TraceRun, type TraceStep, type TraceTask } from './timeline.js';

const FIRST_LINE = 200;
const firstLine = (text: string) => {
  const line = text.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  return line.length > FIRST_LINE ? line.slice(0, FIRST_LINE - 1) + '…' : line;
};

type TaskRow = { internal: string; id: string; parent: string | null; title: string; project: string; created: string; state: TaskBaseState };
const taskRows = `SELECT t.id AS internal,t.external_id AS id,p.external_id AS parent,t.title,pr.external_id AS project,t.created_at AS created,t.base_state AS state
  FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_id JOIN tasks pr ON pr.id=t.project_task_id`;

/** The task and every task under it (the user acting on any of them acts on this task), the root first. */
function familyOf(db: DatabaseSync, task: string): TaskRow[] {
  const root = db.prepare(`${taskRows} WHERE t.external_id=? AND t.kind='task' AND t.lifecycle<>'deleted'`).get(task) as TaskRow | undefined;
  if (!root) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task });
  const below = db.prepare(`WITH RECURSIVE under(id) AS (SELECT id FROM tasks WHERE parent_id=?
      UNION SELECT t.id FROM tasks t JOIN under u ON t.parent_id=u.id WHERE t.kind='task')
    ${taskRows} WHERE t.id IN (SELECT id FROM under) AND t.kind='task' AND t.lifecycle<>'deleted' ORDER BY t.number`).all(root.internal) as TaskRow[];
  return [root, ...below];
}

function requestsOf(db: DatabaseSync, tasks: readonly string[]): Map<string, TraceRequest> {
  const rows = db.prepare(`SELECT q.id,q.task_id AS task,q.purpose,q.author,q.submitted_at AS at,q.body,q.answers_question AS answers,
      p.task_id AS author_task
    FROM requests q LEFT JOIN placements p ON p.id=json_extract(q.author,'$.placementId')
    WHERE q.task_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(tasks));
  return new Map(rows.map(row => {
    const author = JSON.parse(String(row.author)) as { kind: string };
    const by = author.kind !== 'placement' ? 'user' : row.author_task === row.task ? 'owner' : 'parent';
    const purpose = row.purpose === 'review_send_back' ? 'send-back' : row.purpose === 'return_continuation' ? 'return' : 'instruction';
    return [String(row.id), { id: String(row.id), task: String(row.task), at: Date.parse(String(row.at)), by, purpose,
      firstLine: firstLine(String(row.body)), answers: row.answers === null ? null : String(row.answers) }];
  }));
}

/** The commands a Run's manager stopped at the time limit, from the Run's protocol events. */
function stoppedCommands(folder: string): TraceRun['stopped'] {
  const result: { at: number; seconds: number; signal: string }[] = [];
  let attempts: string[];
  try { attempts = readdirSync(join(folder, 'protocol')); } catch { return result; }
  for (const attempt of attempts) {
    const events = join(folder, 'protocol', attempt, 'events');
    let names: string[];
    try { names = readdirSync(events); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const text = readFileSync(join(events, name), 'utf8');
      if (!text.includes('"command_stopped"')) continue;
      const event = JSON.parse(text) as { type: string; occurredAt: string; payload: { seconds: number; signal: string } };
      if (event.type === 'command_stopped') result.push({ at: Date.parse(event.occurredAt), seconds: event.payload.seconds, signal: event.payload.signal });
    }
  }
  return result.sort((a, b) => a.at - b.at);
}

/**
 * The steps of Runs that have ended, which never change again: reading a Run's steps reads its whole output, so a task
 * read again (another page, a finding, an instant) reads only the Runs still going.
 */
const endedSteps = new Kept<string, TraceStep[]>(512);
async function stepsOf(root: string, run: RunRecord): Promise<{ steps: TraceStep[] | null; missing: TraceRun['stepsMissing'] }> {
  // Kept by the journal's size as well: a time written after the Run ended (its last steps settled) is read again.
  const folder = runFolder(root, run.id), journal = statSync(join(folder, RUN_FILES.steps), { throwIfNoEntry: false });
  const key = `${root}\0${run.id}\0${journal?.size ?? 0}`, kept = run.ended_at === null ? undefined : endedSteps.get(key);
  if (kept) return { steps: kept, missing: null };
  // Step times and conditions came in together: a Run with neither started before step times were kept.
  if (!journal && !existsSync(join(folder, RUN_FILES.conditions)))
    return { steps: null, missing: 'before-step-times' };
  const index = await readRunStepIndex(root, run.id);
  if (!index) return { steps: null, missing: 'provider-unsupported' };
  const steps: TraceStep[] = [];
  for (let from = 0, total = 1; from < total; from += RUN_STEPS_PAGE_LIMIT) {
    const page = index.range(from, RUN_STEPS_PAGE_LIMIT);
    total = page.total;
    for (const step of page.steps) steps.push({ n: step.n, id: step.id, tool: step.tool, kind: step.kind, line: step.text,
      fingerprint: step.fingerprint && `${step.fingerprint.line}\0${step.fingerprint.bodyDigest ?? ''}`,
      from: step.startedAt === null ? null : Date.parse(step.startedAt), to: step.endedAt === null ? null : Date.parse(step.endedAt),
      state: step.state, source: step.startSource, inside: step.parentId, subagentSteps: step.subagentSteps,
      output: step.output?.whole ? step.output.digest : null, more: step.more });
  }
  const timed = timedSteps(steps);
  if (!timed) return { steps: null, missing: 'missing-step-times' };
  if (run.ended_at !== null) endedSteps.set(key, steps);
  return { steps, missing: null };
}

async function traceRun(root: string, record: RunRecord): Promise<TraceRun> {
  const values = record.launch.values as Record<string, unknown>, text = (key: string) => typeof values[key] === 'string' ? values[key] as string : null;
  const time = (value: string | null) => value === null ? null : Date.parse(value);
  const { steps, missing } = record.started_at === null || record.state === 'joined' ? { steps: [], missing: null } : await stepsOf(root, record);
  return { id: record.id, task: record.task, placement: record.placementId, role: record.role === 'owner' ? 'owner' : 'member',
    agent: record.agent, model: text('model'), effort: text('effort'), state: record.state, reason: record.reason,
    request: record.requestId, supersededBy: record.supersededBy ?? null,
    created: Date.parse(record.created_at), started: time(record.started_at), ended: time(record.ended_at),
    compactions: (record.compactions ?? []).map(item => ({ at: Date.parse(item.at), beforeTokens: item.beforeTokens, afterTokens: item.afterTokens })),
    steps, stepsMissing: missing, conditions: readConditions(runFolder(root, record.id)), stopped: stoppedCommands(runFolder(root, record.id)) };
}

/**
 * The version of the records read: what the task's history, its Runs and their steps hold now. Two reads of one version
 * with the same inputs give the same answer; a page cursor holds to one version.
 */
function versionOf(tasks: readonly TraceTask[], runs: readonly TraceRun[]) {
  const hash = createHash('sha256');
  for (const task of tasks) hash.update(`${task.id}:${task.log.length}:${task.log.at(-1)?.id ?? ''}\n`);
  for (const run of runs) {
    hash.update(`${run.id}:${run.state}:${run.ended ?? ''}:${run.stepsMissing ?? ''}:${run.compactions.length}:${run.stopped.length}:${run.conditions ? 1 : 0}\n`);
    // Every step's times and state: one step ending while another runs is a new version too.
    for (const step of run.steps ?? []) hash.update(`${step.n}:${step.from ?? ''}:${step.to ?? ''}:${step.state}\n`);
  }
  return hash.digest('base64url').slice(0, 12);
}

/**
 * Every record of the task and every task under it, at one read point of the control database: the breakdown, the
 * waits and the findings read them all; `scope` only chooses what a trace or an instant lists.
 */
export async function readTimelineRecords(root: string, task: string, scope: AnalysisTraceScope, activity: readonly Activity[] = [],
  now = Date.now()): Promise<TraceRecords> {
  const store = new ControlStore(root, { busyTimeoutMs: 10_000 }, true);
  let family: TaskRow[], logs: Map<string, TaskLog[]>, runs: RunRecord[], requests: Map<string, TraceRequest>;
  try {
    ({ family, logs, runs, requests } = store.read(db => {
      const family = familyOf(db, task), ids = family.map(row => row.id);
      return { family, logs: taskLogsOf(db, family.map(row => row.internal)), requests: requestsOf(db, ids),
        runs: db.prepare('SELECT record FROM runs WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY id')
          .all(JSON.stringify(ids)).map(row => JSON.parse(String(row.record)) as RunRecord) };
    }));
  } finally { store.close(); }
  const tasks: TraceTask[] = family.map(row => ({ id: row.id, parent: row.parent, title: row.title, created: Date.parse(row.created),
    log: logs.get(row.internal) ?? [] }));
  const labels = new Map<string, { kind: InstructionLabel['kind']; fixes: InstructionLabel['fixes'] }>();
  for (const item of tasks) for (const entry of item.log)
    if (entry.kind === 'request_labeled' && entry.label) labels.set(entry.label.request, { kind: entry.label.kind, fixes: [...entry.label.fixes] });
  const traced: TraceRun[] = [];
  for (const record of runs) traced.push(await traceRun(root, record));
  return { root: task, project: family[0]!.project, scope, tasks, runs: traced, requests, labels, rootState: family[0]!.state,
    activity, version: versionOf(tasks, traced), now };
}

/** The period read: as asked, else the task's whole period; resolved first, then checked. */
function windowOf(records: TraceRecords, input: { from?: string; to?: string }): Interval {
  const whole = wholePeriod(records);
  const window = { from: input.from ? Date.parse(input.from) : whole.from, to: input.to ? Date.parse(input.to) : whole.to };
  if (window.from >= window.to) throw new Problem(PROBLEM_CODE.invalidInput,
    `The period must end after it starts: it runs from ${iso(window.from)} to ${iso(window.to)}`);
  return window;
}
const headOf = (records: TraceRecords, timeZone: string | undefined) => ({ task: records.root, project: records.project,
  scope: records.scope, timeZone: timeZone ?? serverZone(), generatedAt: iso(records.now), version: records.version });

/** A page cursor: which reading (`selector`), of which version of the records, from where. */
function readCursor(cursor: string | undefined, selector: string, version: string, total: number, name: string) {
  if (!cursor) return 0;
  const match = /^([\w-]{12})\.([\w-]{12})\.(\d+)$/.exec(cursor);
  if (!match || match[1] !== selector || Number(match[3]) > total) throw new Problem(PROBLEM_CODE.invalidInput, `Use a cursor from the same ${name}`);
  if (match[2] !== version) throw new Problem(PROBLEM_CODE.invalidInput, `The records changed since that page: read ${name} again from its start`);
  return Number(match[3]);
}

const PAGE = 200;
/** `activity`: the user's actions on every task (AnalysisFacts.activity), which split the waits as the counts split them. */
export async function readTrace(root: string, input: AnalysisTraceInput, activity: readonly Activity[]): Promise<AnalysisTraceView> {
  const scope = input.scope ?? 'self', records = await readTimelineRecords(root, input.task, scope, activity), window = windowOf(records, input);
  const kinds = input.kinds && new Set<string>(input.kinds), only = input.lanes && new Set(input.lanes);
  const listed = (item: { kind: string; lane: string }) => (!kinds || kinds.has(item.kind)) && (!only || only.has(item.lane));
  // A span is listed when it overlaps the period; an instant (a mark) when it falls in it, either end included.
  const allSpans = spans(records).filter(span => listed(span) && Date.parse(span.from) < window.to &&
    (span.to === null || Date.parse(span.to) > window.from || Date.parse(span.from) === window.from));
  const allMarks = marks(records).filter(mark => listed(mark) && Date.parse(mark.at) >= window.from && Date.parse(mark.at) <= window.to);
  const items = [...allSpans.map(span => ({ at: span.from, id: span.id, span })), ...allMarks.map(mark => ({ at: mark.at, id: mark.id, mark }))]
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  // The period as asked, not as resolved: an open task's period ends now, and the next page is read later.
  const selector = createHash('sha256').update(JSON.stringify([input.task, scope, input.from ?? null, input.to ?? null, input.kinds ?? null,
    input.lanes ?? null])).digest('base64url').slice(0, 12);
  const offset = readCursor(input.cursor, selector, records.version, items.length, 'analysis trace');
  const end = offset + (input.limit ?? PAGE), page = items.slice(offset, end);
  const { time, waits, settled } = waited(records, window);
  const runs = records.runs.filter(run => run.started !== null && run.state !== 'joined');
  const lanesListed = lanes(records).filter(lane => !only || only.has(lane.id));
  return {
    head: { ...headOf(records, input.timeZone), from: iso(window.from), to: iso(window.to),
      settled: (!isOpen(records) || window.to < records.now) && settled },
    coverage: {
      steps: { known: runs.filter(run => run.steps !== null).map(run => run.id),
        unknown: analysisStepsMissingSchema.options.flatMap(reason => {
          const missing = runs.filter(run => run.stepsMissing === reason).map(run => run.id);
          return missing.length ? [{ reason, runs: missing }] : [];
        }) },
      conditions: { known: runs.filter(run => run.conditions).map(run => run.id), unknown: runs.filter(run => !run.conditions).map(run => run.id) },
      values: { recordedFrom: null },
    },
    lanes: lanesListed,
    spans: page.flatMap(item => 'span' in item ? [item.span] : []), marks: page.flatMap(item => 'mark' in item ? [item.mark] : []),
    breakdown: breakdown(records, window, segments(records, window)), time, waits,
    total: items.length, cursor: end < items.length ? `${selector}.${records.version}.${end}` : null,
    url: sceneUrl(records.root, scope, input.from ? { at: input.from } : {}),
  };
}

const FINDINGS = 20;
export async function readFindings(root: string, input: AnalysisFindingsInput): Promise<AnalysisFindingsView> {
  const scope = input.scope ?? 'self', records = await readTimelineRecords(root, input.task, scope), window = windowOf(records, {});
  const thresholds = thresholdsOf(input.threshold), chosen = input.rules ?? allRules;
  const stepless = !records.runs.some(run => run.steps !== null && run.started !== null && run.state !== 'joined');
  const found = findFindings(records, window, chosen, thresholds);
  const findings = found.slice(0, input.limit ?? FINDINGS).map(item => {
    const id = `${item.rule}:${item.anchor}`;
    return { id, rule: item.rule, at: iso(item.at), durationMs: item.durationMs, lane: item.lane, count: item.count,
      threshold: thresholds[item.rule], source: item.source, evidence: item.evidence, url: sceneUrl(records.root, scope, { at: item.at, finding: id }) };
  });
  return {
    head: { ...headOf(records, input.timeZone), from: iso(window.from), to: iso(window.to) },
    rules: { set: 'experimental', used: chosen.map(rule => ({ rule, threshold: thresholds[rule] })),
      skipped: stepless ? chosen.filter(rule => STEP_RULES.has(rule)).map(rule => ({ rule, reason: 'no-step-times' as const })) : [] },
    findings, total: found.length, url: sceneUrl(records.root, scope),
  };
}

export async function readAt(root: string, input: AnalysisAtInput): Promise<AnalysisAtView> {
  const scope = input.scope ?? 'self', at = Date.parse(input.at);
  const records = await readTimelineRecords(root, input.task, scope);
  return { head: { ...headOf(records, input.timeZone), at: iso(at) }, ...situationAt(records, at), url: sceneUrl(records.root, scope, { at }) };
}

/** Ended Runs that kept no conditions (from before they were kept): they never will, so their folders are not read again. */
const noConditions = new Set<string>();
type DatedRun = ChangeRun & { day: string };
type ChangesMade = { runs: DatedRun[]; events: ReturnType<typeof changeEvents<DatedRun>> };
/**
 * The change events of one scope's launches, made once per reading of the facts (the launches given are kept with
 * those facts, `ScopedAnalysis.datedLaunches`): later pages and other periods of the same facts read them again.
 */
const made = new WeakMap<object, Promise<ChangesMade>>();
async function makeChanges(root: string, launches: readonly { day: string; run: FactLaunch }[], slices: Slices): Promise<ChangesMade> {
  const store = new ControlStore(root, { busyTimeoutMs: 10_000 }, true), seats = new Map<string, string>();
  try {
    store.read(db => {
      for (const row of db.prepare("SELECT 'R'||id AS id, json_extract(record,'$.placementId') AS placement FROM runs WHERE id IN (SELECT value FROM json_each(?))")
        .iterate(JSON.stringify(launches.map(({ run }) => Number(run.id.slice(1)))))) seats.set(String(row.id), String(row.placement));
    });
  } finally { store.close(); }
  const runs: DatedRun[] = [];
  for (const { day, run } of launches) {
    const key = `${root}\0${run.id}`;
    const conditions = noConditions.has(key) ? null : readConditions(runFolder(root, run.id));
    if (!conditions && !run.live) noConditions.add(key);
    runs.push({ id: run.id, task: run.task, placement: seats.get(run.id) ?? run.id, agent: run.agent, model: run.model, effort: run.effort,
      started: run.started, conditions, day });
    if (slices.due) await slices.pause();
  }
  // Launch choices compare within a placement; versions, skills and instruction files within an agent.
  const events = changeEvents(runs, (run, what) => what === 'agent' || what === 'model' || what === 'effort' ? `placement:${run.placement}` : `agent:${run.agent}`);
  return { runs, events };
}

const CHANGES = 100;
/**
 * analysis changes: each Run of the scope that ran under a condition its agent had not run under before (a version, a
 * skill, an instruction file; these need the Runs' condition records) or whose placement changed its launch choices
 * (agent, model, effort; from the launch records), dated on the period's days. Every earlier Run of the scope is read
 * too, so the first Run of the period compares with the last before it.
 */
export async function readChanges(root: string, head: AnalysisHead, launches: readonly { day: string; run: FactLaunch }[],
  input: AnalysisChangesInput, slices: Slices): Promise<AnalysisChangesView> {
  let making = made.get(launches);
  if (!making) {
    made.set(launches, making = makeChanges(root, launches, slices));
    making.catch(() => made.delete(launches));
  }
  const { runs, events: all } = await making;
  const inPeriod = (day: string) => inDays(day, head.period), events = all.filter(({ run }) => inPeriod(run.day));
  const selector = createHash('sha256').update(JSON.stringify([head.project, head.timeZone, head.period])).digest('base64url').slice(0, 12);
  let offset = 0;
  if (input.cursor) {
    const match = /^([\w-]{12})\.(\d+)$/.exec(input.cursor);
    if (!match || match[1] !== selector || Number(match[2]) > events.length) throw new Problem(PROBLEM_CODE.invalidInput, 'Use a cursor from the same analysis changes');
    offset = Number(match[2]);
  }
  const end = offset + (input.limit ?? CHANGES), period = runs.filter(run => inPeriod(run.day));
  return {
    head, runs: { launched: period.length, recorded: period.filter(run => run.conditions).length },
    changes: events.slice(offset, end).map(({ run, changes }) => ({ id: `change:${run.id}`, at: iso(run.started!), run: run.id,
      task: run.task, agent: run.agent, changes })),
    total: events.length, cursor: end < events.length ? `${selector}.${end}` : null,
  };
}
