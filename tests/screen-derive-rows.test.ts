/**
 * The projection's rules over the real records (WorkspaceRecords): the records keep the promises `affected` compares
 * by — an unchanged record keeps its object, a changed delivery gives its return a new one, a coordinator's Run is not
 * a Task's Run — for keys in the form the writers name them.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openControlDatabase, type ChangeKey } from '@alpacawork/db';
import type { ProjectionVersion } from '@alpacawork/contract/control';
import { affected } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';
import { emptyWorkspaceRecords } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { coordinatorRecord } from './runs-fixtures.ts';

const pv = (n: number) => n as ProjectionVersion;
const at = '2026-11-16T00:00:00.000Z';

/** A small synthetic workspace (scripts/dev-fixtures) and its control database, removed after the test. */
function workspace(t: TestContext) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'screen-derive-records-')));
  const original = createOriginal({ tasks: 14, logs: 28, runs: 7, seed: 'workspace-records' }, join(area, 'originals'));
  const root = copyWorkspace(original.root, join(area, 'working')).root;
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 });
  t.after(() => { db.close(); removeWorkspace(root); removeWorkspace(original.root); rmSync(area, { recursive: true, force: true }); });
  return { root, db };
}

test('an advance keeps the objects of what did not change and gives a return whose delivery changed a new one', t => {
  const { root, db } = workspace(t);
  const wake = String(db.prepare("SELECT q.id FROM requests q JOIN returns r ON r.to_task_id=q.task_id WHERE r.id='fixture-return-2' LIMIT 1").get()!.id);
  db.prepare("INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at) VALUES ('fixture-return-2',?,?)").run(wake, at);
  const before = emptyWorkspaceRecords(root).load(db, pv(1));
  const owner = before.returnOwner('fixture-return-2')!;
  const delivery = before.bundle(owner)!.returns.find(row => row.id === 'fixture-return-2')!.deliveries[0]!;
  db.prepare('UPDATE return_deliveries SET received_at=?,consumed_at=? WHERE return_id=? AND wake_request_id=?').run(at, at, 'fixture-return-2', delivery.wakeRequestId);
  // The return lifecycle names a delivery by its return and wake Request, as a JSON pair.
  const keys: ChangeKey[] = [{ kind: 'delivery', id: JSON.stringify(['fixture-return-2', delivery.wakeRequestId]) }];
  const change = before.advance(db, keys, pv(2));
  const after = change.next;
  const changed = after.bundle(owner)!.returns.find(row => row.id === 'fixture-return-2')!;
  assert.equal(changed.deliveries[0]!.consumedAt, at, 'the delivery was read again');
  assert.notEqual(changed, before.bundle(owner)!.returns.find(row => row.id === 'fixture-return-2'), 'its return is a new object');
  for (const id of before.taskIds()) if (id !== owner) assert.equal(after.bundle(id), before.bundle(id), `${id} keeps its bundle`);
  for (const run of before.bundle(owner)!.runs) assert.equal(after.run(run.id), before.run(run.id), `${run.id} keeps its record`);
  const reached = affected(change);
  assert.ok(reached.tasks.get(owner)?.has('seat'), `${owner} is routed again`);
  assert.deepEqual([...reached.tasks.keys()].filter(id => id !== owner).filter(id => !reached.tasks.get(id)!.has('history')), [],
    'beyond the return\'s Task only the History of its cause');
});

test('keys named as JSON pairs by their writers reach their Tasks', t => {
  const { root, db } = workspace(t);
  const before = emptyWorkspaceRecords(root).load(db, pv(1));
  db.prepare("INSERT INTO task_dependencies(task_id,after_task_id) VALUES ('T5','T4')").run();
  const after = before.advance(db, [{ kind: 'dependency', id: JSON.stringify(['T5', 'T4']) }], pv(2)).next;
  assert.deepEqual(after.bundle('T5')!.after, ['T4'], 'a dependency by its Task and the Task after');
  assert.ok(after.dependents('T4').includes('T5'));
  const uuid = String(db.prepare("SELECT id FROM tasks WHERE external_id='T3'").get()!.id);
  db.prepare("INSERT INTO task_values(task_id,field_id,value) VALUES (?,'goal','\"Synthetic goal\"') ON CONFLICT DO UPDATE SET value=excluded.value").run(uuid);
  const valued = after.advance(db, [{ kind: 'task_value', id: JSON.stringify([uuid, 'goal']) }], pv(3)).next;
  assert.notEqual(valued.bundle('T3')!.task.values, after.bundle('T3')!.task.values, 'a Task value by its Task\'s UUID and field');
});

test("a coordinator's Run changes reach the Tasks its message is linked to, though the records keep it out of run()", t => {
  const { root, db } = workspace(t);
  const conversation = randomUUID(), message = randomUUID();
  const uuid = (task: string) => String(db.prepare('SELECT id FROM tasks WHERE external_id=?').get(task)!.id);
  const before = emptyWorkspaceRecords(root).load(db, pv(1));
  db.exec('BEGIN');
  db.prepare('INSERT INTO coordinator_conversations(id,started_at) VALUES (?,?)').run(conversation, at);
  db.prepare("INSERT INTO requests(id,conversation_id,mode,body,purpose,author,submitted_at,delivery_state) VALUES (?,?,'new','Synthetic message','instruction','{\"kind\":\"human\"}',?,'queued')").run(message, conversation, at);
  db.prepare("INSERT INTO runs(id,record,prompt) VALUES (8,?,'Synthetic')").run(JSON.stringify(coordinatorRecord('R8', { requestId: message, conversationId: conversation })));
  // T3 is linked by a dialogue; T4 only names the message in its log (a coordinator's record).
  db.prepare('INSERT INTO task_dialogues(task_uuid,request_id) VALUES (?,?)').run(uuid('T3'), message);
  const ordinal = Number(db.prepare('SELECT coalesce(max(ordinal),-1)+1 AS n FROM task_log WHERE task_id=?').get(uuid('T4'))!.n);
  db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)').run('coordinator-note', uuid('T4'), ordinal, JSON.stringify({ id: 'coordinator-note',
    kind: 'reported', at, actor: { kind: 'main', provider: 'claude', conversationId: conversation, message, quote: 'Synthetic quote' }, fromState: null, toState: null, title: 'Synthetic note', description: null }));
  db.exec('COMMIT');
  const linked = before.advance(db, [{ kind: 'conversation', id: conversation }, { kind: 'request', id: message }, { kind: 'run', id: 'R8' },
    { kind: 'dialogue', id: JSON.stringify([uuid('T3'), message]) }, { kind: 'log', id: 'coordinator-note' }], pv(2)).next;
  assert.equal(linked.run('R8'), undefined, 'a coordinator\'s Run is not a Task\'s Run of the records');
  assert.equal(linked.runOwner('R8'), null);
  assert.deepEqual(linked.dialogueTasks(message), ['T3']);
  assert.ok(linked.messageTasks(message).includes('T4'));
  const answered = JSON.stringify(coordinatorRecord('R8', { requestId: message, conversationId: conversation, state: 'succeeded', ended_at: at }));
  db.prepare("UPDATE runs SET record=?,result='Synthetic answer',result_state='present' WHERE id=8").run(answered);
  const change = linked.advance(db, [{ kind: 'run', id: 'R8' }], pv(3));
  const reached = affected(change);
  assert.ok(reached.tasks.get('T3')?.has('history'), 'the dialogue\'s answer reaches its Task\'s History');
  assert.ok(reached.tasks.get('T4')?.has('history'), 'the coordinator that wrote T4\'s record is shown in its History');
  assert.notDeepEqual(change.next.coordinatorRun(message), undefined);
});
