/** Scoped ancestor reads preserve the automatic admission limit's user resets. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { automaticIndex, type StoredRequest } from '@alpacawork/runs';
import { routingRequests } from '@alpacawork/backend/test-dist/control/routing-work.js';
import type { TaskDecisionFacts } from '@alpacawork/backend/test-dist/control/routing-facts.js';

const task = (id: string, parentId: string | null): TaskDecisionFacts => ({ id,
  meta: { id, parentId, kind: 'task', lifecycle: 'active', title: id, baseState: 'doing', state: 'doing',
    hold: false, userRequested: false, log: [] } });
const request = (id: string, taskId: string, second: number, author: StoredRequest['author'],
  deliveryState: StoredRequest['deliveryState'] = 'queued'): StoredRequest => ({
  id, taskId, placementId: `placement-${taskId}`, placementRevision: 1, taskHash: '0'.repeat(64),
  waitCycleId: null, headRunId: null, aboutRunId: null, mode: 'new', body: 'Continue the work',
  purpose: 'return_continuation', author, submittedAt: `2026-11-16T00:00:${String(second).padStart(2, '0')}Z`,
  deliveryState, runId: null,
});

test('scoped automatic counts match full history across ancestor resets, timestamp ties and refused delivery', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE tasks(id TEXT,external_id TEXT,parent_id TEXT);
    CREATE TABLE requests(id TEXT PRIMARY KEY,task_id TEXT,author TEXT,submitted_at TEXT,delivery_state TEXT,wait_cycle_id TEXT,purpose TEXT DEFAULT 'return_continuation');
    CREATE TABLE wait_cycles(id TEXT,task_id TEXT,closed_at TEXT);
    CREATE TABLE returns(id TEXT,request_id TEXT,to_task_id TEXT);
    CREATE TABLE return_resolutions(return_id TEXT);
    CREATE TABLE return_deliveries(return_id TEXT,wake_request_id TEXT,released_at TEXT,consumed_at TEXT);
    CREATE TABLE runs(id INTEGER,request_id TEXT,caller_run TEXT,task_id TEXT,state TEXT);`);
  const tasks = [task('P1', null), task('T1', 'P1'), task('T2', 'T1')];
  for (const task of tasks) db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.id, task.id, task.meta.parentId);
  const human = { kind: 'human' } as const;
  const main = { kind: 'main', provider: 'codex', conversationId: 'user-conversation' } as const;
  const automatic = { kind: 'placement', placementId: 'requesting-placement' } as const;
  const rows: StoredRequest[] = [
    request('root-reset', 'P1', 1, human), request('old-parent-reset', 'T1', 2, human),
    request('before-reset', 'T2', 3, automatic),
    request('z-parent-reset', 'T1', 4, main), request('a-parent-reset', 'T1', 4, human),
    request('ä-parent-reset', 'T1', 4, human),
    request('zz-between-resets', 'T2', 4, automatic), request('Ω-after-resets', 'T2', 4, automatic),
    request('later-automatic', 'T2', 5, automatic), request('aborted-parent-reset', 'T1', 6, human, 'aborted'),
    request('unconfirmed-root-reset', 'P1', 7, main, 'recorded_unconfirmed'),
    request('aborted-automatic', 'T2', 8, automatic, 'aborted'),
    request('unconfirmed-automatic', 'T2', 9, automatic, 'recorded_unconfirmed'),
  ];
  const insert = db.prepare('INSERT INTO requests(id,task_id,author,submitted_at,delivery_state,wait_cycle_id) VALUES (?,?,?,?,?,NULL)');
  for (const row of rows) insert.run(row.id, row.taskId, JSON.stringify(row.author), row.submittedAt, row.deliveryState);
  const byId = new Map(rows.map(row => [row.id, row]));
  const tx = { getRequests: (ids: readonly string[]) => new Map(ids.map(id => [id, byId.get(id)!])) };
  const compare = (expected: number) => {
    const full = db.prepare('SELECT id FROM requests ORDER BY submitted_at,id').all().map(row => byId.get(String(row.id))!);
    const scoped = routingRequests(db, tx, { tasks: new Set(['T2']) });
    const ancestry = ['T2', 'T1', 'P1'];
    assert.equal(automaticIndex(scoped).count('placement-T2', ancestry), automaticIndex(full).count('placement-T2', ancestry));
    assert.equal(automaticIndex(scoped).count('placement-T2', ancestry), expected,
      'the latest valid ancestor instruction resets the limit; rejected instructions do not');
  };
  compare(2);
  const own = request('own-reset', 'T2', 6, human);
  rows.push(own); byId.set(own.id, own);
  insert.run(own.id, own.taskId, JSON.stringify(own.author), own.submittedAt, own.deliveryState);
  compare(0);
  const scoped = routingRequests(db, tx, { tasks: new Set(['T2']) });
  assert(!scoped.some(row => row.id === 'before-reset'), 'old automatic inputs are no longer decoded after a local user reset');
  const current = request('new-root-reset', 'P1', 10, main);
  rows.push(current); byId.set(current.id, current);
  insert.run(current.id, current.taskId, JSON.stringify(current.author), current.submittedAt, current.deliveryState);
  compare(0);
});
