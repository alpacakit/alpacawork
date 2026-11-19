import { remoteFixture, seedReviewRun } from '../fixture-writes.ts';
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ControlStore, taskHash } from "@alpacawork/db";
import { taskFolder as folderOf } from "@alpacawork/backend/test-dist/control/task-store.js";
import { readTaskValues, writeTaskValues } from "@alpacawork/backend/test-dist/control/task-values-store.js";
import type { TaskValues, ValuesPatch } from "@alpacawork/contract";

/** A generated Task's server-side file location, as the server places it; never derive it from the browser's URL or tree path. */
export function taskFolder(root: string, id: string): string {
  const folder = join(root, folderOf(id));
  mkdirSync(folder, { recursive: true });
  return folder;
}

type Log = Record<string, unknown> & { id: string; at: string };
/**
 * What patchTask changes: the values (the fields named, each a value or null to clear it, over the ones it has), the
 * state, log entries after the Task's own with the full texts of the answers among them (by log ID), and whether the
 * user asked for the Task, written as a person's mark change before those entries, with the column that follows it.
 */
type Patch = { values?: ValuesPatch; state?: string; logs?: Log[]; texts?: Record<string, string>; userRequested?: boolean };

/** A Task's values as the server stores them. */
export function taskValues(root: string, id: string): TaskValues {
  const control = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  try {
    return control.read(db => {
      if (!db.prepare("SELECT 1 FROM tasks WHERE external_id=?").get(id)) throw new Error(`Fixture Task ${id} is absent`);
      return readTaskValues(db, [id]).get(id) ?? {};
    });
  } finally { control.close(); }
}

/** Seed or change a historical fixture before a case reads it. The DB owns Task and log state. */
export function patchTask(root: string, id: string, patch: Patch): void {
  if (remoteFixture(root, { kind: 'patchTask', id, patch }).handled) return;
  const control = new ControlStore(root);
  try {
    control.write(db => {
      const row = db.prepare("SELECT id,base_state,hold,state,user_requested,revision FROM tasks WHERE external_id=?").get(id);
      if (!row) throw new Error(`Fixture Task ${id} is absent`);
      const at = patch.logs?.[0]?.at ?? new Date().toISOString();
      const logs: Log[] = [...patch.userRequested === undefined ? [] : [{ id: randomUUID(), kind: 'user_request_changed', at,
        title: null, description: null, actor: { kind: 'human' }, fromState: null, toState: null,
        userRequested: patch.userRequested }], ...patch.logs ?? []];
      if (patch.values) {
        const values: TaskValues = { ...readTaskValues(db, [id]).get(id) };
        for (const [field, value] of Object.entries(patch.values)) if (value === null) delete values[field]; else values[field] = value;
        writeTaskValues(db, id, values);
      }
      db.prepare(`UPDATE tasks SET base_state=?,hold=?,user_requested=?,revision=?,updated_at=? WHERE id=?`).run(
        patch.state === 'held' || patch.state === undefined ? String(row.base_state) : patch.state, patch.state === undefined ? Number(row.hold) : patch.state === 'held' ? 1 : 0,
        patch.userRequested === undefined ? Number(row.user_requested) : patch.userRequested ? 1 : 0,
        Number(row.revision) + 1, logs.at(-1)?.at ?? new Date().toISOString(), String(row.id));
      const ordinal = Number(db.prepare("SELECT COALESCE(MAX(ordinal),-1)+1 AS next FROM task_log WHERE task_id=?").get(String(row.id))!.next);
      logs.forEach((entry, index) => db.prepare("INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)")
        .run(entry.id, String(row.id), ordinal + index, JSON.stringify(entry)));
      for (const [logId, text] of Object.entries(patch.texts ?? {}))
        db.prepare("INSERT INTO log_texts(log_id,text) VALUES (?,?)").run(logId, text);
    });
  } finally { control.close(); }
}

/** What a seeded record says, and when (now when left out). */
type Said = { title?: string; description?: string; at?: string };

/** A Task as a seed reads it: its version, its state, the user's mark, its parent and its responsible's placement. */
function seedFacts(root: string, id: string) {
  const control = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  try {
    return control.read(db => {
      const row = db.prepare(`SELECT t.id, t.revision, t.state, t.user_requested, parent.external_id AS parent,
        parent.kind AS parent_kind, (SELECT p.id FROM placements p WHERE p.task_id = t.external_id AND p.responsible = 1
          AND p.ended_at IS NULL) AS responsible
        FROM tasks t JOIN tasks parent ON parent.id = t.parent_id WHERE t.external_id = ? AND t.kind = 'task'`).get(id);
      if (!row) throw new Error(`Fixture Task ${id} is absent`);
      if (row.responsible === null) throw new Error(`Fixture Task ${id} has no responsible to ask or report`);
      return { hash: taskHash(String(row.id), Number(row.revision)), state: String(row.state),
        userRequested: Number(row.user_requested) === 1, parent: String(row.parent), parentIsTask: row.parent_kind === 'task',
        responsible: String(row.responsible) };
    });
  } finally { control.close(); }
}

/**
 * Seeds the Task's responsible asking a question, in place of a person writing waiting/external: an `asked` record that
 * keeps the state and fixes the Task's decide value as the server does when it asks; the caller writes that value first.
 * Questions may go to the user without changing the Task’s mark; `to: 'parent'` requires a task parent.
 * Returns the question's ID.
 */
export function seedQuestion(root: string, id: string,
  { to, title = 'Please review', description = 'Please answer the questions in the body.', at = new Date().toISOString() }:
    Said & { to: 'user' | 'parent' }): string {
  const task = seedFacts(root, id);
  if (to === 'parent' && !task.parentIsTask)
    throw new Error(`Fixture Task ${id} would ask the user, not its parent`);
  const control = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  let decide: TaskValues[string] | undefined;
  try { decide = control.read(db => readTaskValues(db, [id]).get(id)?.decide); }
  finally { control.close(); }
  if (!Array.isArray(decide) || !decide.length) throw new Error(`Fixture Task ${id} has no question to ask: write its decide value first`);
  const question = randomUUID();
  patchTask(root, id, { logs: [{ id: question, kind: 'asked', at, title, description, actor: { kind: 'placement', placementId: task.responsible },
      fromState: null, toState: null, askedTo: to === 'user' ? null : task.parent, decide }] });
  return question;
}

/**
 * Seeds the Task waiting for the user's review, in place of a person writing waiting/review: its responsible's Run
 * finishes and reports done, which on the user's request is a review of that Run. Only the user's request waits for a
 * review, so the Task is marked first when it is not. A child passed here explicitly represents a historical
 * marked child review (kept readable); new child results finish without review.
 * Returns the Run the review confirms (its --about-run).
 * The report is dated after the Run it reports from ends: one dated at or before the Run's start would leave serve to
 * apply that start (doing) after it.
 */
export function seedReview(root: string, id: string,
  { title = 'Please review', description }: Omit<Said, 'at'> = {}): string {
  const task = seedFacts(root, id);
  const run = seedReviewRun(root, id, task.responsible, task.hash);
  const control = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  let ended: string;
  try {
    ended = control.read(db => String(db.prepare("SELECT json_extract(record,'$.ended_at') AS at FROM runs WHERE id=?")
      .get(Number(run.slice(1)))!.at));
  } finally { control.close(); }
  const at = new Date(Math.max(Date.now(), Date.parse(ended) + 1)).toISOString();
  patchTask(root, id, { state: 'waiting', ...task.userRequested ? {} : { userRequested: true },
    logs: [{ id: randomUUID(), kind: 'reported', at, title, description: description ?? null,
      actor: { kind: 'placement', placementId: task.responsible }, fromState: task.state, toState: 'waiting', runId: run }] });
  return run;
}
