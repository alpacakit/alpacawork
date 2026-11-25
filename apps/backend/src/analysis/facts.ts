import type { DatabaseSync } from 'node:sqlite';
import { type ChangeKey, type ChangeLog } from '@alpacawork/db';
import type { TaskBaseState } from '@alpacawork/raw';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import type { RunRecord } from '@alpacawork/contract/run';
import { taskLogs } from '../control/task-history.js';
import { clocks, firstConversations, launchOf, modelRun, prLinks, taskOutcome, userQuestions,
  type Launch, type ModelRun, type Outcome, type RunEvidence, type UserQuestion } from './rules.js';
import { tallyEligible } from './tally-scope.js';

export type TaskNode = {
  internal: string; id: string; title: string; parent: string | null; project: string | null;
  kind: 'task' | 'project'; lifecycle: string; requested: boolean; state: TaskBaseState; created: string;
};
export type Unit = {
  node: TaskNode; outcome: Outcome; log: readonly TaskLog[]; ownQuestions: UserQuestion[];
  childQuestions: UserQuestion[]; questions: number; answers: number; workers: number; children: number; prs: Set<string>;
  firstOwner: ModelRun | null; launches: readonly FactLaunch[]; clock: ReturnType<typeof clocks> | null;
};
export type FactLaunch = Launch & { tallyEligible: boolean };
export type AnalysisFacts = {
  nodes: ReadonlyMap<string, TaskNode>; units: ReadonlyMap<string, Unit>; rootOf: ReadonlyMap<string, string>;
  usageRootOf: ReadonlyMap<string, string>; first: ReadonlySet<string>;
};

const nodeRows = `SELECT t.id AS internal,t.external_id AS id,t.title,
    p.external_id AS parent,pr.external_id AS project,t.kind,t.lifecycle,t.user_requested AS requested,t.base_state AS state,t.created_at AS created
  FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_id LEFT JOIN tasks pr ON pr.id=t.project_task_id`;
/** Every Task row, or only those named (by ID): a Task's row names only itself, so a change reads only its own. */
const readNodes = (db: DatabaseSync, ids?: ReadonlySet<string>) => (ids
  ? db.prepare(nodeRows + ' WHERE t.external_id IN (SELECT value FROM json_each(?))').all(JSON.stringify([...ids]))
  : db.prepare(nodeRows).all()).map(row => ({ ...row, requested: row.requested === 1 }) as TaskNode);

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

function valuesLinks(db: DatabaseSync, nodes: readonly TaskNode[]) {
  const found = new Map<string, string[]>();
  for (const row of db.prepare(`SELECT task_id,value FROM task_values
    WHERE task_id IN (SELECT value FROM json_each(?)) AND instr(lower(value),'github.com/')>0`)
    .all(JSON.stringify(nodes.map(node => node.internal)))) {
    const key = String(row.task_id), values = found.get(key) ?? [];
    values.push(...textLeaves(JSON.parse(String(row.value)))); found.set(key, values);
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
  const log = logs.get(node.id) ?? [], outcome = taskOutcome(log, node.state, node.created);
  const ownQuestions = userQuestions(log), childQuestions: UserQuestion[] = [], prs = new Set<string>();
  for (const id of ids) {
    const history = logs.get(id) ?? [];
    if (id !== node.id) childQuestions.push(...userQuestions(history));
    for (const link of values.get(id) ?? []) prs.add(link);
    const reports = history.filter(entry => entry.kind === 'reported').flatMap(entry => [entry.title ?? '', entry.description ?? '']);
    for (const link of prLinks(reports)) prs.add(link);
  }
  const from = Date.parse(outcome.requestedAt), to = outcome.finishedAt ? Date.parse(outcome.finishedAt) : null;
  const questions = [...ownQuestions, ...childQuestions].filter(question => question.from >= from && (to === null || question.from <= to));
  const workers = new Set(memberIds);
  // The placement row remembers its final role. Its history retains member assignments before a promotion.
  for (const entry of log) if (entry.placementEffect === 'member' && entry.placementId) workers.add(entry.placementId);
  return { node, outcome, log, ownQuestions, childQuestions, questions: questions.length,
    answers: questions.filter(question => question.answered).length, workers: workers.size, children: ids.length - 1, prs,
    firstOwner: firstOwner && modelRun(firstOwner), launches,
    clock: to === null ? null : clocks(log, ownQuestions, childQuestions, launches, from, to, to) };
}

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
  private workspace: unknown;
  private readonly release?: () => void;
  constructor(private readonly root: string, private readonly tallySince: number, private readonly journal?: ChangeLog) {
    this.release = journal?.register('analysis');
  }

  close() { this.release?.(); }

  read(db: DatabaseSync): AnalysisFacts {
    const identity = db.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()?.id;
    const change = this.journal?.read('analysis');
    const full = !this.data || this.workspace !== identity || !change || change.kind === 'overflow';
    if (!full && change.kind === 'changes' && !change.batches.length) return this.data!;
    try {
      const keys = full || change.kind !== 'changes' ? [] : change.batches.flatMap(batch => batch.keys);
      const next = this.refresh(db, full, keys);
      if (change) this.journal!.acknowledge('analysis', change.through);
      this.workspace = identity;
      return this.data = next;
    } catch (error) {
      // The next read rebuilds if any slice was already read when an input failed.
      this.data = undefined;
      throw error;
    }
  }

  private keepRun({ run, launch }: ReturnType<typeof runFromRow>) {
    const previous = this.runs.get(run.id);
    this.runs.set(run.id, launch);
    let own = this.runsByTask.get(run.task);
    if (!own) this.runsByTask.set(run.task, own = new Map());
    if (launch) own.set(run.id, launch);
    else own.delete(run.id);
    const first = this.firstOwners.get(run.task);
    if (run.role === 'owner' && (!first || first.id === run.id || madeBefore(run, first))) this.firstOwners.set(run.task, run);
    const before = this.sessionOf.get(run.id), after = launch?.session ? `${launch.provider}\u0000${launch.session}` : undefined;
    if (before === after && previous?.started === launch?.started) return [];
    if (before !== undefined) { this.sessions.get(before)?.delete(run.id); this.sessionOf.delete(run.id); }
    if (after !== undefined) {
      let group = this.sessions.get(after);
      if (!group) this.sessions.set(after, group = new Set());
      group.add(run.id); this.sessionOf.set(run.id, after);
    }
    return [before, after].filter(key => key !== undefined);
  }

  /** The Run that began each conversation named (every one, for a full read), again from its launched Runs. */
  private settleFirst(keys: Iterable<string> | 'all') {
    if (keys === 'all') {
      for (const id of firstConversations([...this.runs.values()].filter(launch => launch !== null))) {
        this.first.add(id); this.firstOf.set(this.sessionOf.get(id)!, id);
      }
      return;
    }
    for (const key of keys) {
      const old = this.firstOf.get(key);
      if (old !== undefined) { this.first.delete(old); this.firstOf.delete(key); }
      const launches = [...this.sessions.get(key) ?? []].map(id => this.runs.get(id)!);
      for (const id of firstConversations(launches)) { this.first.add(id); this.firstOf.set(key, id); }
      if (!launches.length) this.sessions.delete(key);
    }
  }

  private refresh(db: DatabaseSync, full: boolean, keys: readonly ChangeKey[]): AnalysisFacts {
    const changedTasks = new Set(keys.filter(key => key.kind === 'task').map(key => key.id));
    const runIds = new Set(keys.filter(key => key.kind === 'run').map(key => key.id));
    const placementIds = keys.filter(key => key.kind === 'placement').map(key => key.id);
    const valuesIds = new Set(keys.filter(key => key.kind === 'task_value').map(key => (JSON.parse(key.id) as [string])[0]));
    if (!full && !changedTasks.size && !runIds.size && !valuesIds.size && !placementIds.length) return this.data!;
    const previous = this.data, taskIds = new Set(changedTasks);
    if (full) {
      for (const kept of [this.logs, this.values, this.runs, this.runsByTask, this.firstOwners, this.sessions, this.sessionOf, this.firstOf]) kept.clear();
      this.first.clear();
    }
    let nodes = previous?.nodes ?? new Map<string, TaskNode>();
    if (full) nodes = new Map(readNodes(db).map(node => [node.id, node]));
    else if (changedTasks.size) {
      const next = new Map(nodes);
      for (const node of readNodes(db, changedTasks)) next.set(node.id, node);
      nodes = next;
    }
    const tasks = full ? [...nodes.values()].filter(node => node.kind === 'task') : [];
    const historyNodes = full ? tasks : [...changedTasks].flatMap(id => nodes.get(id)?.kind === 'task' ? [nodes.get(id)!] : []);
    if (historyNodes.length) {
      const current = taskLogs(db, this.root, historyNodes.map(node => node.internal));
      for (const node of historyNodes) this.logs.set(node.id, current.get(node.internal) ?? []);
    }
    if (full || valuesIds.size)
      for (const [id, links] of valuesLinks(db, full ? tasks : [...nodes.values()].filter(node => node.kind === 'task' && valuesIds.has(node.internal)))) {
        this.values.set(id, links); taskIds.add(id);
      }
    const sessionKeys = new Set<string>();
    for (const row of runRows(db, this.tallySince, full ? undefined : runIds)) {
      const item = runFromRow(row);
      for (const key of this.keepRun(item)) sessionKeys.add(key);
      taskIds.add(item.run.task);
    }
    this.settleFirst(full ? 'all' : sessionKeys);
    const moved = full || changedTasks.size > 0;
    const tree = this.tree = moved ? ancestry(nodes) : this.tree!;
    const { rootOf, usageRootOf, members, usageMembers } = tree;
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
    const units = full ? new Map<string, Unit>() : new Map(previous!.units);
    const workers = new Map<string, string[]>();
    if (dirty.size)
      for (const row of db.prepare('SELECT task_id,id FROM placements WHERE responsible=0 AND task_id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify([...dirty]))) {
        const id = String(row.task_id), group = workers.get(id) ?? [];
        group.push(String(row.id)); workers.set(id, group);
      }
    for (const id of dirty) {
      const node = nodes.get(id), group = members.get(id);
      if (!node || !group) { units.delete(id); continue; }
      const launches: FactLaunch[] = [];
      for (const task of usageMembers.get(id) ?? [])
        for (const launch of this.runsByTask.get(task)?.values() ?? []) launches.push(launch);
      units.set(id, unitFacts(node, group, this.logs, this.values, this.firstOwners.get(id) ?? null,
        launches, workers.get(id) ?? []));
    }
    return { nodes, units, rootOf, usageRootOf, first: this.first };
  }
}
