import type { DatabaseSync } from 'node:sqlite';
import { ControlStore, type ChangeKey, type ChangeLog } from '@alpacawork/db';
import { speaksForUser, type InstructionLabel, type TaskBaseState } from '@alpacawork/raw';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import type { RunRecord } from '@alpacawork/contract/run';
import { taskLogsOf } from '../control/task-history.js';
import { Slices } from './slices.js';
import { beganBefore, clocks, reviewRounds, type Round, laterInstructions, firstConversations, launchOf, modelRun, prLinks, taskOutcome, userQuestions,
  type Launch, type ModelRun, type Outcome, type RunEvidence, type UserQuestion } from './rules.js';
import { tallyEligible } from './tally-scope.js';
import type { Activity } from './presence.js';

export type TaskNode = {
  internal: string; id: string; title: string; parent: string | null; project: string | null;
  kind: 'task' | 'project'; lifecycle: string; requested: boolean; state: TaskBaseState; created: string;
};
export type Unit = {
  node: TaskNode; outcome: Outcome; log: readonly TaskLog[]; ownQuestions: UserQuestion[];
  childQuestions: UserQuestion[]; questions: number;
  /** The user's questions of the subtree asked while the unit was open (`questions` counts them). */
  asked: UserQuestion[]; answers: number; workers: number; children: number; prs: Set<string>;
  firstOwner: ModelRun | null; launches: readonly FactLaunch[];
  /**
   * The user's instructions to the unit or any Task under it, after the request itself (answers and send-backs are not
   * instructions), and the labels their senders gave them.
   */
  instructions: { count: number; labels: InstructionLabel[] };
};
export type FactLaunch = Launch & { tallyEligible: boolean };
export type AnalysisFacts = {
  nodes: ReadonlyMap<string, TaskNode>; units: ReadonlyMap<string, Unit>; rootOf: ReadonlyMap<string, string>;
  usageRootOf: ReadonlyMap<string, string>; first: ReadonlySet<string>;
  /** The user's actions on every task and their messages to the coordinator, in time order (made on first use). */
  activity: () => readonly Activity[];
};

const nodeRows = `SELECT t.id AS internal,t.external_id AS id,t.title,
    p.external_id AS parent,pr.external_id AS project,t.kind,t.lifecycle,t.user_requested AS requested,t.base_state AS state,t.created_at AS created
  FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_id LEFT JOIN tasks pr ON pr.id=t.project_task_id`;
/**
 * Every Task row, or only those named (by ID): a Task's row names only itself, so a change reads only its own. Read row
 * by row, giving the loop back as it goes.
 */
async function readNodes(db: DatabaseSync, slices: Slices, ids?: ReadonlySet<string>) {
  const nodes: TaskNode[] = [];
  for (const row of ids ? db.prepare(nodeRows + ' WHERE t.external_id IN (SELECT value FROM json_each(?))').iterate(JSON.stringify([...ids]))
    : db.prepare(nodeRows).iterate()) {
    nodes.push({ ...row, requested: row.requested === 1 } as TaskNode);
    if (slices.due) await slices.pause();
  }
  return nodes;
}

/** Only what the counting reads of a Run is kept: its whole record is many times that, and there are many Runs. */
const runFromRow = (row: Record<string, unknown>) => {
  const record = JSON.parse(String(row.record)) as RunRecord, { model, effort } = record.launch.values;
  const run: RunEvidence = { id: record.id, task: record.task, role: record.role, agent: record.agent, state: record.state,
    created_at: record.created_at, started_at: record.started_at, ended_at: record.ended_at, session: record.session,
    launch: { adapter: record.launch.adapter, values: { model, effort } }, pids: { agent: record.pids.agent },
    usage: record.usage && { run: record.usage.run, includesEarlier: record.usage.includesEarlier } };
  const launch = launchOf(run);
  return { run, launch: launch && { ...launch, tallyEligible: row.tally_eligible === 1 } };
};
/** Whether a Run was made before another (by its creation, then its number): a unit's first owner Run is the earliest. */
const madeBefore = (run: RunEvidence, other: RunEvidence) => {
  const time = Date.parse(run.created_at) - Date.parse(other.created_at);
  return time < 0 || time === 0 && Number(run.id.slice(1)) < Number(other.id.slice(1));
};

function runRows(db: DatabaseSync, tallySince: number, ids?: Set<string>) {
  const prefix = `SELECT record, (${tallyEligible}) AS tally_eligible FROM runs WHERE task_id IS NOT NULL`;
  if (!ids) return db.prepare(prefix).iterate(tallySince);
  if (!ids.size) return [];
  return db.prepare(prefix + ' AND id IN (SELECT value FROM json_each(?))')
    .iterate(tallySince, JSON.stringify([...ids].map(id => Number(id.slice(1)))));
}

/** Which unit each Task counts toward (its top Task under a project), and the Tasks each unit gathers. */
function ancestry(nodes: ReadonlyMap<string, TaskNode>) {
  const rootOf = new Map<string, string>(), usageRootOf = new Map<string, string>();
  const members = new Map<string, string[]>(), usageMembers = new Map<string, string[]>();
  const join = (groups: Map<string, string[]>, top: string, id: string) => {
    const group = groups.get(top);
    if (group) group.push(id);
    else groups.set(top, [id]);
  };
  for (const node of nodes.values()) {
    if (node.kind !== 'task') continue;
    let top = node, hasDeletedTask = node.lifecycle === 'deleted';
    let parent = nodes.get(top.parent ?? '');
    while (parent?.kind === 'task') {
      top = parent;
      hasDeletedTask ||= top.lifecycle === 'deleted';
      parent = nodes.get(top.parent ?? '');
    }
    if (parent?.kind !== 'project' || parent.lifecycle === 'deleted' || top.lifecycle === 'deleted') continue;
    // Usage follows the whole subtree. Task history still stops at a deleted Task.
    usageRootOf.set(node.id, top.id);
    join(usageMembers, top.id, node.id);
    if (hasDeletedTask) continue;
    rootOf.set(node.id, top.id);
    join(members, top.id, node.id);
  }
  return { rootOf, usageRootOf, members, usageMembers };
}

async function valuesLinks(db: DatabaseSync, nodes: readonly TaskNode[], slices: Slices) {
  const found = new Map<string, string[]>();
  for (const row of db.prepare(`SELECT task_id,value FROM task_values
    WHERE task_id IN (SELECT value FROM json_each(?)) AND instr(lower(value),'github.com/')>0`)
    .iterate(JSON.stringify(nodes.map(node => node.internal)))) {
    const key = String(row.task_id), values = found.get(key) ?? [];
    values.push(...textLeaves(JSON.parse(String(row.value)))); found.set(key, values);
    if (slices.due) await slices.pause();
  }
  return new Map(nodes.map(node => [node.id, prLinks(found.get(node.internal) ?? [])]));
}

function* textLeaves(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (value && typeof value === 'object') for (const item of Object.values(value)) yield* textLeaves(item);
}

function unitFacts(node: TaskNode, ids: readonly string[], logs: ReadonlyMap<string, TaskLog[]>,
  values: ReadonlyMap<string, ReadonlySet<string>>, firstOwner: RunEvidence | null, launches: readonly FactLaunch[],
  memberIds: readonly string[]): Unit {
  const log = logs.get(node.id) ?? [];
  const ownQuestions = userQuestions(log), childQuestions: UserQuestion[] = [], prs = new Set<string>();
  for (const id of ids) {
    const history = logs.get(id) ?? [];
    if (id !== node.id) childQuestions.push(...userQuestions(history));
    for (const link of values.get(id) ?? []) prs.add(link);
    const reports = history.filter(entry => entry.kind === 'reported').flatMap(entry => [entry.title ?? '', entry.description ?? '']);
    for (const link of prLinks(reports)) prs.add(link);
  }
  const instructions = laterInstructions(log, ids.map(id => logs.get(id) ?? []));
  const outcome = taskOutcome(log, node.state, node.created, [...ownQuestions, ...childQuestions]);
  // A unit done without acceptance stops at its done time as a finished one does at its end.
  const ended = outcome.finishedAt ?? outcome.doneAt;
  const from = Date.parse(outcome.requestedAt), to = ended ? Date.parse(ended) : null;
  const questions = [...ownQuestions, ...childQuestions].filter(question => question.from >= from && (to === null || question.from <= to));
  const workers = new Set(memberIds);
  // The placement row remembers its final role. Its history retains member assignments before a promotion.
  for (const entry of log) if (entry.placementEffect === 'member' && entry.placementId) workers.add(entry.placementId);
  return { node, outcome, log, ownQuestions, childQuestions, questions: questions.length, asked: questions,
    answers: questions.filter(question => question.answered).length, workers: workers.size, children: ids.length - 1, prs,
    firstOwner: firstOwner && modelRun(firstOwner), launches, instructions };
}

/**
 * Ended-task clocks depend only on these facts (usage reads do not need them): a unit accepted or stopped, or done by
 * its owner without acceptance, runs to that end.
 */
const finishedClocks = new WeakMap<Unit, ReturnType<typeof clocks>>();
export function finishedClock(unit: Unit) {
  const ended = unit.outcome.finishedAt ?? unit.outcome.doneAt;
  if (!ended) return null;
  let clock = finishedClocks.get(unit);
  if (!clock) {
    const to = Date.parse(ended);
    clock = clocks(unit.log, unit.ownQuestions, unit.childQuestions, unit.launches, Date.parse(unit.outcome.requestedAt), to, to);
    finishedClocks.set(unit, clock);
  }
  return clock;
}

/** A unit's review rounds (rules.ts reviewRounds) up to its end, or `now` while it is open; kept once it has ended. */
const endedRounds = new WeakMap<Unit, Round[]>();
export function roundsOf(unit: Unit, now: number): Round[] {
  const kept = endedRounds.get(unit);
  if (kept) return kept;
  const ended = unit.outcome.finishedAt ?? unit.outcome.doneAt;
  const rounds = reviewRounds(unit.log, unit.asked, unit.launches, Date.parse(unit.outcome.requestedAt), ended ? Date.parse(ended) : now);
  if (ended) endedRounds.set(unit, rounds);
  return rounds;
}

/**
 * The user's messages to the coordinator (all of them, or those named), each with the Tasks it acts on or names (none
 * when it names none): one action per Task, at the time the message was sent, by message. The warm-up message a
 * conversation opens with is not the user's, nor is a cancellation recorded before a message was sent (it has no words).
 */
function coordinatorMessages(db: DatabaseSync, ids?: readonly string[]) {
  const sql = `SELECT q.id, q.submitted_at AS at, t.external_id AS task FROM requests q
      JOIN coordinator_conversations c ON c.id=q.conversation_id
      LEFT JOIN task_dialogues d ON d.request_id=q.id LEFT JOIN tasks t ON t.id=d.task_uuid
    WHERE q.coordinator_turn_no IS NOT NULL AND q.body <> ''`;
  const rows = ids ? db.prepare(sql + ' AND q.id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) : db.prepare(sql).all();
  const messages = new Map<string, Activity[]>();
  for (const row of rows) {
    const id = String(row.id), actions = messages.get(id) ?? [];
    actions.push({ at: Date.parse(String(row.at)), task: row.task === null ? null : String(row.task) });
    messages.set(id, actions);
  }
  return messages;
}

/** Every action in time order, made once when a read first needs it. */
function activityOf(acts: ReadonlyMap<string, readonly number[]>, messages: ReadonlyMap<string, readonly Activity[]>) {
  let made: Activity[] | undefined;
  return () => made ??= [...[...messages.values()].flat(), ...[...acts].flatMap(([task, times]) => times.map(at => ({ at, task })))]
    .sort((a, b) => a.at - b.at);
}
const sameTimes = (a: readonly number[] | undefined, b: readonly number[]) => a?.length === b.length && a.every((time, at) => time === b[at]);

/**
 * Task histories are read from the table this many Tasks at a time (not through the kept history, which reads every
 * Task's at once), so a full read gives the loop back between them.
 */
const HISTORY_SLICE = 500;

/**
 * A single serve owns this reader. Its journal cursor only advances after a full committed read. A read after changes
 * reads again only what they name (the Tasks, values, Runs and placements changed) and counts again only the units
 * whose Tasks or Runs those are; the rest is kept as it was counted.
 */
export class FactsCache {
  private data?: AnalysisFacts;
  private tree?: ReturnType<typeof ancestry>;
  private logs = new Map<string, TaskLog[]>();
  private values = new Map<string, ReadonlySet<string>>();
  /** Each Run's launch (null before it is witnessed), each Task's launches, and each Task's first owner Run. */
  private runs = new Map<string, FactLaunch | null>();
  private runsByTask = new Map<string, Map<string, FactLaunch>>();
  private firstOwners = new Map<string, RunEvidence>();
  /** The launched Runs of each conversation (provider and session), and the one that began it. */
  private sessions = new Map<string, Set<string>>();
  private sessionOf = new Map<string, string>();
  private firstOf = new Map<string, string>();
  private first = new Set<string>();
  /** Each Task's times of the user's actions (their own or the coordinator's for them), and the coordinator's messages. */
  private acts = new Map<string, number[]>();
  private messages = new Map<string, Activity[]>();
  /** The user's actions as last made; kept while neither their actions nor their messages change. */
  private activity?: () => readonly Activity[];
  private workspace: unknown;
  private readonly release?: () => void;
  constructor(private readonly root: string, private readonly tallySince: number, private readonly journal?: ChangeLog) {
    this.release = journal?.register('analysis');
  }

  close() { this.release?.(); }

  /**
   * The facts as of one read point, which this read takes itself: the journal's position is read and the read point
   * taken right after it, with no pause between them, so every change the position counts is in what is read (a change
   * committed after the position and before the read point is read twice, never missed). The work gives the event loop
   * back every slice and holds that read point across the pauses (ControlStore.readAsync); reads are taken one at a time
   * (the caller's queue). What is returned is never changed afterwards, so a read still counting over older facts counts
   * them as they were.
   */
  async read(slices: Slices): Promise<AnalysisFacts> {
    const store = new ControlStore(this.root, { busyTimeoutMs: 10_000 }, true);
    try { return await store.readAsync(() => this.readAt(store.connection, slices)); }
    finally { store.close(); }
  }

  private async readAt(db: DatabaseSync, slices: Slices): Promise<AnalysisFacts> {
    const change = this.journal?.read('analysis');
    // The transaction's first statement: the read point is taken here.
    const identity = db.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()?.id;
    const full = !this.data || this.workspace !== identity || !change || change.kind === 'overflow';
    if (!full && change.kind === 'changes' && !change.batches.length) return this.data!;
    try {
      const keys = full || change.kind !== 'changes' ? [] : change.batches.flatMap(batch => batch.keys);
      const next = await this.refresh(db, full, keys, slices);
      if (change) this.journal!.acknowledge('analysis', change.through);
      this.workspace = identity;
      return this.data = next;
    } catch (error) {
      // The next read rebuilds if any slice was already read when an input failed.
      this.data = undefined;
      throw error;
    }
  }

  private keepRun({ run, launch }: ReturnType<typeof runFromRow>, changedSessions?: Set<string>) {
    const previous = this.runs.get(run.id);
    this.runs.set(run.id, launch);
    let own = this.runsByTask.get(run.task);
    if (!own) this.runsByTask.set(run.task, own = new Map());
    if (launch) own.set(run.id, launch);
    else own.delete(run.id);
    const first = this.firstOwners.get(run.task);
    if (run.role === 'owner' && (!first || first.id === run.id || madeBefore(run, first))) this.firstOwners.set(run.task, run);
    const before = this.sessionOf.get(run.id), after = launch?.session ? `${launch.provider}\u0000${launch.session}` : undefined;
    if (before === after && previous?.started === launch?.started) return;
    if (before !== undefined) {
      this.sessions.get(before)?.delete(run.id); this.sessionOf.delete(run.id);
      changedSessions?.add(before);
    }
    if (after !== undefined) {
      let group = this.sessions.get(after);
      if (!group) this.sessions.set(after, group = new Set());
      group.add(run.id); this.sessionOf.set(run.id, after);
      changedSessions?.add(after);
    }
  }

  /** The Run that began each conversation named (every one, for a full read), again from its launched Runs. */
  private async settleFirst(keys: Iterable<string> | 'all', slices: Slices) {
    if (keys === 'all') {
      const first = new Map<string, FactLaunch>();
      for (const launch of this.runs.values()) {
        const key = launch && this.sessionOf.get(launch.id);
        if (!key) continue;
        const old = first.get(key);
        if (!old || beganBefore(launch, old)) first.set(key, launch);
        if (slices.due) await slices.pause();
      }
      for (const [key, launch] of first) { this.first.add(launch.id); this.firstOf.set(key, launch.id); }
      return;
    }
    // The facts given out before hold the last set: it is copied, never changed.
    const keyed = [...keys];
    if (keyed.length) this.first = new Set(this.first);
    for (const key of keyed) {
      const old = this.firstOf.get(key);
      if (old !== undefined) { this.first.delete(old); this.firstOf.delete(key); }
      const launches = [...this.sessions.get(key) ?? []].map(id => this.runs.get(id)!);
      for (const id of firstConversations(launches)) { this.first.add(id); this.firstOf.set(key, id); }
      if (!launches.length) this.sessions.delete(key);
    }
  }

  private async refresh(db: DatabaseSync, full: boolean, keys: readonly ChangeKey[], slices: Slices): Promise<AnalysisFacts> {
    const changedTasks = new Set(keys.filter(key => key.kind === 'task').map(key => key.id));
    const runIds = new Set(keys.filter(key => key.kind === 'run').map(key => key.id));
    const placementIds = keys.filter(key => key.kind === 'placement').map(key => key.id);
    const valuesIds = new Set(keys.filter(key => key.kind === 'task_value').map(key => (JSON.parse(key.id) as [string])[0]));
    const messaged = keys.some(key => key.kind === 'request' || key.kind === 'dialogue');
    if (!full && !changedTasks.size && !runIds.size && !valuesIds.size && !placementIds.length && !messaged) return this.data!;
    const previous = this.data, taskIds = new Set(changedTasks);
    if (full) {
      for (const kept of [this.logs, this.values, this.runs, this.runsByTask, this.firstOwners, this.sessions, this.sessionOf, this.firstOf, this.acts]) kept.clear();
      this.first = new Set();
    }
    let nodes = previous?.nodes ?? new Map<string, TaskNode>();
    if (full) nodes = new Map((await readNodes(db, slices)).map(node => [node.id, node]));
    else if (changedTasks.size) {
      const next = new Map(nodes);
      for (const node of await readNodes(db, slices, changedTasks)) next.set(node.id, node);
      nodes = next;
    }
    const tasks = full ? [...nodes.values()].filter(node => node.kind === 'task') : [];
    const historyNodes = full ? tasks : [...changedTasks].flatMap(id => nodes.get(id)?.kind === 'task' ? [nodes.get(id)!] : []);
    let acted = false;
    for (let at = 0; at < historyNodes.length; at += HISTORY_SLICE) {
      const part = historyNodes.slice(at, at + HISTORY_SLICE);
      const current = taskLogsOf(db, part.map(node => node.internal));
      for (const node of part) {
        const log = current.get(node.internal) ?? [];
        this.logs.set(node.id, log);
        const times = log.flatMap(entry => speaksForUser(entry.actor) ? [Date.parse(entry.at)] : []);
        if (!sameTimes(this.acts.get(node.id), times)) { this.acts.set(node.id, times); acted = true; }
      }
      if (slices.due) await slices.pause();
    }
    if (full) { this.messages = coordinatorMessages(db); acted = true; }
    else if (messaged) {
      // A request key names the request; a dialogue key names the Task and the request it links.
      const ids = [...new Set(keys.flatMap(key => key.kind === 'request' ? [key.id]
        : key.kind === 'dialogue' ? [(JSON.parse(key.id) as [string, string])[1]] : []))];
      const read = coordinatorMessages(db, ids);
      for (const id of ids) {
        const before = this.messages.get(id), after = read.get(id);
        // A write that changes only how a message was delivered leaves its actions as they were.
        if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue;
        if (after) this.messages.set(id, after); else this.messages.delete(id);
        acted = true;
      }
    }
    if (acted || !this.activity) this.activity = activityOf(new Map(this.acts), new Map(this.messages));
    if (full || valuesIds.size)
      for (const [id, links] of await valuesLinks(db, full ? tasks : [...nodes.values()].filter(node => node.kind === 'task' && valuesIds.has(node.internal)), slices)) {
        this.values.set(id, links); taskIds.add(id);
      }
    if (slices.due) await slices.pause();
    const sessionKeys = full ? undefined : new Set<string>();
    for (const row of runRows(db, this.tallySince, full ? undefined : runIds)) {
      const item = runFromRow(row);
      this.keepRun(item, sessionKeys);
      if (!full) taskIds.add(item.run.task);
      if (slices.due) await slices.pause();
    }
    await this.settleFirst(sessionKeys ?? 'all', slices);
    if (slices.due) await slices.pause();
    const moved = full || changedTasks.size > 0;
    const tree = this.tree = moved ? ancestry(nodes) : this.tree!;
    const { rootOf, usageRootOf, members, usageMembers } = tree;
    if (slices.due) await slices.pause();
    const dirty = new Set(full ? [...members.keys()] : []);
    if (placementIds.length)
      for (const row of db.prepare('SELECT DISTINCT task_id FROM placements WHERE id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(placementIds))) taskIds.add(String(row.task_id));
    if (!full) {
      const scopes = [[previous!.rootOf, rootOf], [previous!.usageRootOf, usageRootOf]] as const;
      for (const [previousRoots, nextRoots] of scopes) {
        for (const id of taskIds) {
          const before = previousRoots.get(id), after = nextRoots.get(id);
          if (before) dirty.add(before);
          if (after) dirty.add(after);
        }
        // A move or deletion can affect every Task underneath the changed row.
        if (moved) for (const [id, root] of previousRoots) {
          const next = nextRoots.get(id);
          if (root !== next) { dirty.add(root); if (next) dirty.add(next); }
        }
      }
    }
    if (slices.due) await slices.pause();
    const units = full ? new Map<string, Unit>() : new Map(previous!.units);
    const workers = new Map<string, string[]>();
    if (dirty.size)
      for (const row of db.prepare('SELECT task_id,id FROM placements WHERE responsible=0 AND task_id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify([...dirty]))) {
        const id = String(row.task_id), group = workers.get(id) ?? [];
        group.push(String(row.id)); workers.set(id, group);
      }
    if (slices.due) await slices.pause();
    for (const id of dirty) {
      const node = nodes.get(id), group = members.get(id);
      if (!node || !group) { units.delete(id); continue; }
      const launches: FactLaunch[] = [];
      for (const task of usageMembers.get(id) ?? [])
        for (const launch of this.runsByTask.get(task)?.values() ?? []) launches.push(launch);
      units.set(id, unitFacts(node, group, this.logs, this.values, this.firstOwners.get(id) ?? null,
        launches, workers.get(id) ?? []));
      if (slices.due) await slices.pause();
    }
    return { nodes, units, rootOf, usageRootOf, first: this.first, activity: this.activity! };
  }
}
