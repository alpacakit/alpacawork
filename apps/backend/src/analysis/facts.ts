import type { DatabaseSync } from 'node:sqlite';
import { type ChangeKey, type ChangeLog } from '@alpacawork/db';
import type { TaskBaseState } from '@alpacawork/raw';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
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

const readNodes = (db: DatabaseSync) => db.prepare(`SELECT t.id AS internal,t.external_id AS id,t.title,
    p.external_id AS parent,pr.external_id AS project,t.kind,t.lifecycle,t.user_requested AS requested,t.base_state AS state,t.created_at AS created
  FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_id LEFT JOIN tasks pr ON pr.id=t.project_task_id`).all().map(
  row => ({ ...row, requested: row.requested === 1 }) as TaskNode);

const runFromRow = (row: Record<string, unknown>) => {
  const run = JSON.parse(String(row.record)) as RunEvidence;
  const launch = launchOf(run);
  return { run, launch: launch && { ...launch, tallyEligible: row.tally_eligible === 1 } };
};
type StoredRun = ReturnType<typeof runFromRow>;

function runRows(db: DatabaseSync, tallySince: number, ids?: Set<string>) {
  const prefix = `SELECT record, (${tallyEligible}) AS tally_eligible FROM runs WHERE task_id IS NOT NULL`;
  if (!ids) return db.prepare(prefix).all(tallySince);
  if (!ids.size) return [];
  return db.prepare(prefix + ' AND id IN (SELECT value FROM json_each(?))')
    .all(tallySince, JSON.stringify([...ids].map(id => Number(id.slice(1)))));
}

function ancestry(nodes: ReadonlyMap<string, TaskNode>) {
  const rootOf = new Map<string, string>(), usageRootOf = new Map<string, string>(), members = new Map<string, string[]>();
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
    if (hasDeletedTask) continue;
    rootOf.set(node.id, top.id);
    const group = members.get(top.id);
    if (group) group.push(node.id);
    else members.set(top.id, [node.id]);
  }
  return { rootOf, usageRootOf, members };
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
  values: ReadonlyMap<string, ReadonlySet<string>>, ownRuns: readonly StoredRun[], launches: readonly FactLaunch[],
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
  const firstOwner = ownRuns.reduce<RunEvidence | null>((earliest, { run }) => {
    if (run.role !== 'owner') return earliest;
    if (!earliest) return run;
    const time = Date.parse(run.created_at) - Date.parse(earliest.created_at);
    return time < 0 || time === 0 && Number(run.id.slice(1)) < Number(earliest.id.slice(1)) ? run : earliest;
  }, null);
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

/** A single serve owns this reader. Its journal cursor only advances after a full committed read. */
export class FactsCache {
  private data?: AnalysisFacts;
  private logs = new Map<string, TaskLog[]>();
  private values = new Map<string, ReadonlySet<string>>();
  private runs = new Map<string, StoredRun>();
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

  private refresh(db: DatabaseSync, full: boolean, keys: readonly ChangeKey[]): AnalysisFacts {
    const taskIds = new Set(keys.filter(key => key.kind === 'task').map(key => key.id));
    const runIds = new Set(keys.filter(key => key.kind === 'run').map(key => key.id));
    const placementIds = keys.filter(key => key.kind === 'placement').map(key => key.id);
    const valuesIds = new Set(keys.filter(key => key.kind === 'task_value').map(key => (JSON.parse(key.id) as string[])[0]));
    if (!full && !taskIds.size && !runIds.size && !valuesIds.size && !placementIds.length) return this.data!;
    const previous = this.data;
    const nodes = full || taskIds.size ? new Map(readNodes(db).map(node => [node.id, node])) : previous!.nodes;
    const tasks = [...nodes.values()].filter(node => node.kind === 'task');
    const historyNodes = full ? tasks : tasks.filter(node => taskIds.has(node.id));
    if (full) { this.logs.clear(); this.values.clear(); this.runs.clear(); }
    if (historyNodes.length) {
      const current = taskLogs(db, this.root, historyNodes.map(node => node.internal));
      for (const node of historyNodes) this.logs.set(node.id, current.get(node.internal) ?? []);
    }
    for (const [id, links] of valuesLinks(db, full ? tasks : tasks.filter(node => valuesIds.has(node.internal)))) {
      this.values.set(id, links); taskIds.add(id);
    }
    for (const row of runRows(db, this.tallySince, full ? undefined : runIds)) {
      const item = runFromRow(row);
      this.runs.set(item.run.id, item); taskIds.add(item.run.task);
    }
    const { rootOf, usageRootOf, members } = ancestry(nodes);
    const byTask = new Map<string, StoredRun[]>(), launches: Launch[] = [];
    const launchesByRoot = new Map<string, FactLaunch[]>();
    for (const item of this.runs.values()) {
      const group = byTask.get(item.run.task);
      if (group) group.push(item);
      else byTask.set(item.run.task, [item]);
      const run = item.launch;
      if (!run) continue;
      launches.push(run);
      const root = usageRootOf.get(run.task);
      if (!root) continue;
      const groupRuns = launchesByRoot.get(root);
      if (groupRuns) groupRuns.push(run);
      else launchesByRoot.set(root, [run]);
    }
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
        for (const [id, root] of previousRoots) {
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
      if (node && group) units.set(id, unitFacts(node, group, this.logs, this.values,
        byTask.get(id) ?? [], launchesByRoot.get(id) ?? [], workers.get(id) ?? []));
      else units.delete(id);
    }
    return { nodes, units, rootOf, usageRootOf, first: firstConversations(launches) };
  }
}
