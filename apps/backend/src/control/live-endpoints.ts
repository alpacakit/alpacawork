/** Branch rules and routing share the same live relationship boundary; only branch writes include descendants. */
import type { DatabaseSync } from 'node:sqlite';
import { latestUserRequests, admissionFacts, returnCauseIds, UNFINISHED_SQL, type AdmissionFacts } from '@alpacawork/runs';

import { controlReadContext } from './read-context.js';

/** The same read point shares one admission snapshot, including callers for every selected seat. */
function admissions(db: DatabaseSync, root: string, seats: readonly string[]): AdmissionFacts {
  const context = controlReadContext(db), prior = context?.peek<AdmissionFacts>('routing_admissions');
  if (prior && seats.every(seat => prior.sent.has(seat))) return prior;
  const facts = admissionFacts(db, root, [...new Set([...prior?.sent.keys() ?? [], ...seats])]);
  context?.remember('routing_admissions', facts);
  return facts;
}
/** Incoming accounting starts at the last user reset; live work and outgoing obligations are retained explicitly. */
export function liveRequestIds(db: DatabaseSync, root: string, seats: readonly string[], extra: readonly string[] = []): string[] {
  const facts = admissions(db, root, seats), sent = seats.flatMap(seat => facts.sent.get(seat) ?? []);
  const ancestry = db.prepare(`WITH RECURSIVE up(seed,id,external_id,parent_id) AS (
    SELECT external_id,id,external_id,parent_id FROM tasks WHERE external_id IN (SELECT value FROM json_each(?))
    UNION SELECT up.seed,t.id,t.external_id,t.parent_id FROM up JOIN tasks t ON t.id=up.parent_id
  ) SELECT seed,external_id FROM up`).all(JSON.stringify(seats));
  const resets = latestUserRequests(db, root, [...new Set(ancestry.map(row => String(row.external_id)))]);
  const bySeat = new Map<string, { id: string; at: string }>();
  for (const row of ancestry) {
    const reset = resets.get(String(row.external_id)), seat = String(row.seed), previous = bySeat.get(seat);
    if (reset && (!previous || reset.at.localeCompare(previous.at) > 0 ||
      reset.at.localeCompare(previous.at) === 0 && Buffer.compare(Buffer.from(reset.id), Buffer.from(previous.id)) > 0)) bySeat.set(seat, reset);
  }
  // Requester identity needs the seat's own last user instruction even after an ancestor resets automatic accounting.
  const cutoffs = JSON.stringify(seats.map(seat => ({ task: seat, at: (resets.get(seat) ?? bySeat.get(seat))?.at ?? null })));
  return db.prepare(`WITH selected(id) AS (SELECT value FROM json_each(?)), candidates(id) AS (
    SELECT q.id FROM requests q JOIN json_each(?) cutoff ON q.task_id=json_extract(cutoff.value,'$.task')
      WHERE json_extract(cutoff.value,'$.at') IS NULL OR q.submitted_at>=json_extract(cutoff.value,'$.at')
    UNION SELECT q.id FROM requests q JOIN runs r ON r.request_id=q.id
      WHERE q.task_id IN selected AND (r.state IN (${UNFINISHED_SQL}) OR
        q.purpose<>'return_continuation' AND json_extract(q.author,'$.kind')='placement'
        AND NOT EXISTS (SELECT 1 FROM returns closed WHERE closed.request_id=q.id))
    UNION SELECT r.request_id FROM returns r JOIN requests q ON q.id=r.request_id
      WHERE q.task_id IN selected AND NOT EXISTS (SELECT 1 FROM return_resolutions x WHERE x.return_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM return_deliveries d WHERE d.return_id=r.id AND d.consumed_at IS NOT NULL)
    UNION SELECT d.wake_request_id FROM returns r JOIN return_deliveries d ON d.return_id=r.id
      WHERE r.to_task_id IN selected AND d.released_at IS NULL AND d.consumed_at IS NULL
    UNION SELECT q.id FROM requests q WHERE q.wait_cycle_id IN
      (SELECT id FROM wait_cycles WHERE task_id IN selected AND closed_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM returns closed WHERE closed.request_id=q.id)
    UNION SELECT value FROM json_each(?)
    ) SELECT q.id FROM candidates c JOIN requests q ON q.id=c.id
    ORDER BY q.submitted_at,q.id`).all(JSON.stringify(seats), cutoffs, JSON.stringify([...extra, ...sent, ...[...bySeat.values()].map(reset => reset.id)])).map(row => String(row.id));
}

export function liveEndpoints(db: DatabaseSync, root: string, ids: readonly string[], descendants: boolean): string[] {
  const selected = descendants ? db.prepare(`WITH RECURSIVE branch(id,external_id) AS (
    SELECT id,external_id FROM tasks WHERE external_id IN (SELECT value FROM json_each(?))
    UNION SELECT t.id,t.external_id FROM tasks t JOIN branch b ON t.parent_id=b.id
  ) SELECT external_id FROM branch`).all(JSON.stringify(ids)).map(row => String(row.external_id)) : [...ids];
  const ancestry = (seeds: readonly string[]) => db.prepare(`WITH RECURSIVE up(id,external_id,parent_id) AS (
    SELECT id,external_id,parent_id FROM tasks WHERE external_id IN (SELECT value FROM json_each(?))
    UNION SELECT t.id,t.external_id,t.parent_id FROM tasks t JOIN up ON t.id=up.parent_id
  ) SELECT external_id FROM up ORDER BY external_id`).all(JSON.stringify(seeds)).map(row => String(row.external_id));
  const seats = ancestry(selected), facts = admissions(db, root, seats), requests = seats.flatMap(seat => facts.sent.get(seat) ?? []);
  const endpoints = new Set(seats), selectedJson = JSON.stringify(selected), seatsJson = JSON.stringify(seats);
  for (const row of db.prepare(`SELECT task_id FROM requests WHERE id IN (SELECT value FROM json_each(?))
    UNION SELECT q.task_id FROM requests q JOIN wait_cycles c ON c.id=q.wait_cycle_id
      WHERE c.task_id IN (SELECT value FROM json_each(?)) AND c.closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM returns closed WHERE closed.request_id=q.id)
    UNION SELECT linked.task_id FROM runs r JOIN runs linked ON linked.id IN
      (CAST(substr(r.resumes_id,2) AS INTEGER),CAST(substr(r.into_id,2) AS INTEGER))
      WHERE r.task_id IN (SELECT value FROM json_each(?)) AND (r.resumes_id IS NOT NULL OR r.into_id IS NOT NULL)
        AND (r.state IN (${UNFINISHED_SQL})
        OR NOT EXISTS (SELECT 1 FROM task_log WHERE id='LENDR'||r.id))`).all(JSON.stringify(requests), seatsJson, selectedJson))
    if (row.task_id !== null) endpoints.add(String(row.task_id));
  for (const seat of selected) for (const task of facts.callers.get(seat) ?? []) endpoints.add(task);
  // Undisposed notices need their cause for rendering; questions also need their origin lifecycle.
  for (const row of db.prepare(`SELECT DISTINCT t.external_id FROM task_log l JOIN tasks t ON t.id=l.task_id
    WHERE l.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...returnCauseIds(db, root, seats)])))
    endpoints.add(String(row.external_id));
  return ancestry([...endpoints]);
}
