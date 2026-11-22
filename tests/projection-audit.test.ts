/** Synthetic databases only: missed identities, independent derived caches, and bounded aggregate repairs. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { openControlDatabase, type ChangeSeq } from '@alpacawork/db';
import type { ProjectionVersion } from '@alpacawork/contract/control';
import { DEFAULT_SCHEMA } from '@alpacawork/contract';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { coordinatorRecord } from './runs-fixtures.ts';
import { emptyWorkspaceRecords, DatabaseWorkspaceRecords } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { ProjectionAudit } from '@alpacawork/backend/test-dist/receiver/projection-audit.js';
import { auditCandidate } from '@alpacawork/backend/test-dist/receiver/projection-audit-reader.js';
import { deriveTask } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';
import { createScreenAggregate, repairScreenAggregate, type AggregateSnapshot } from '@alpacawork/backend/test-dist/receiver/screen-aggregate.js';
import { aggregateFactsOf } from '@alpacawork/backend/test-dist/receiver/workspace-aggregate-facts.js';
import type { PublishedFrame } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';

const pv = 1 as ProjectionVersion, seq = 0 as ChangeSeq, at = '2026-11-16T00:00:00.000Z';
function fixture(t: TestContext) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'projection-audit-')));
  const original = createOriginal({ tasks: 14, logs: 28, runs: 7, seed: 'projection-audit' }, join(area, 'originals'));
  const root = copyWorkspace(original.root, join(area, 'working')).root;
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 });
  t.after(() => { db.close(); removeWorkspace(root); removeWorkspace(original.root); rmSync(area, { recursive: true, force: true }); });
  // A mismatch is expected in these tests; keep the test runner's error output meaningful.
  t.mock.method(console, 'error', () => {});
  const records = emptyWorkspaceRecords(root).load(db, pv);
  const values = new Map([...records.taskIds()].map(id => [id, deriveTask(records, id)]));
  const facts = new Map([...values].map(([id, value]) => [id, aggregateFactsOf(records, id, value.row, null)]));
  const aggregate = createScreenAggregate([...values.values()].map(value => value.contribution), facts);
  const frame: PublishedFrame = { generation: 'synthetic-audit', pv, applied: seq, records, derived: id => values.get(id), aggregate,
    requiredPv: { view: {}, history: {}, page: {}, timeline: {}, search: {} }, patch: null };
  return { root, db, records, values, aggregate, frame };
}
function sweep(h: ReturnType<typeof fixture>, frame = h.frame, limit = 3) {
  const audit = new ProjectionAudit(), results = [];
  for (let i = 0; i < 20; i++) results.push(audit.tick(h.db, frame, () => seq, { limit }));
  return results;
}
function kinds(results: ReturnType<typeof sweep>, task: string) {
  return new Set(results.flatMap(result => result.repairs.filter(repair => repair.task === task).flatMap(repair => [...repair.kinds])));
}

test('unchanged audits stay bounded and do not run the startup loader or mutate the held frame', t => {
  const h = fixture(t), held = h.records.bundle('T5'), seen = new Set<string>();
  t.mock.method(DatabaseWorkspaceRecords.prototype, 'load', () => { throw new Error('Full load is forbidden during audit'); });
  for (const result of sweep(h)) {
    assert.equal(result.skipped, false);
    assert.ok(result.tasks.length <= 3);
    assert.deepEqual(result.repairs, []);
    assert.deepEqual(result.reloadKeys, []);
    result.tasks.forEach(id => seen.add(id));
  }
  assert.deepEqual(seen, new Set(h.records.taskIds()));
  assert.equal(h.records.bundle('T5'), held);
});

test('a consistent handoff does not ask the projection audit for repairs', t => {
  const h = fixture(t);
  const { resultHead: _, ...first } = h.records.run('R4')!;
  h.db.prepare(`INSERT INTO runs(id,record,prompt,result,result_state)
    SELECT 8,?,prompt,result,result_state FROM runs WHERE id=4`)
    .run(JSON.stringify({ ...first, id: 'R8', firstRunId: first.id, attempt: 1 }));
  h.db.prepare(`UPDATE runs SET record=json_set(record,'$.state','failed','$.reason','exit','$.supersededBy','R8') WHERE id=4`).run();
  const records = emptyWorkspaceRecords(h.root).load(h.db, pv);
  const values = new Map([...records.taskIds()].map(id => [id, deriveTask(records, id)]));
  const facts = new Map([...values].map(([id, value]) => [id, aggregateFactsOf(records, id, value.row, null)]));
  const aggregate = createScreenAggregate([...values.values()].map(value => value.contribution), facts);
  assert.equal(records.runByRequest(first.requestId), 'R8');
  const results = sweep(h, { ...h.frame, records, derived: id => values.get(id), aggregate });
  assert.ok(results.some(result => result.tasks.includes(first.task!)));
  assert.deepEqual(results.flatMap(result => result.repairs), []);
});

test('bundle reload discovers new records and removes deleted identities while keeping the old publication', t => {
  const h = fixture(t), held = h.records.bundle('T5')!;
  const taskUuid = String(h.db.prepare("SELECT id FROM tasks WHERE external_id='T5'").get()!.id);
  h.db.prepare(`INSERT INTO task_log(id,task_id,ordinal,entry) VALUES ('new-audit-log',?,99,?)`).run(taskUuid,
    JSON.stringify({ id: 'new-audit-log', kind: 'reported', at, actor: { kind: 'human' }, title: 'New synthetic log', description: 'New synthetic observation.', fromState: null, toState: null }));
  h.db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state)
    SELECT 'new-audit-request',task_id,placement_id,placement_revision,task_hash,mode,'New synthetic request',purpose,'{"kind":"human"}',submitted_at,delivery_state
    FROM requests WHERE id='fixture-request-4'`).run();
  const oldRun = h.records.run('R4')!;
  const { resultHead: _, ...runRecord } = oldRun;
  h.db.prepare('INSERT INTO runs(id,record,prompt) VALUES (8,?,\'Synthetic\')').run(JSON.stringify({ ...runRecord, id: 'R8', requestId: 'new-audit-request', caller: null }));
  h.db.prepare("INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES (8,'new-audit-attempt','{}')").run();
  h.db.prepare("INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial) VALUES ('new-audit-input','new-audit-attempt',8,'digest','uncertain',0)").run();
  const next = h.records.reloadBundles(h.db, ['T5'], 2 as ProjectionVersion).next;
  assert.equal(next.bundle('T5')!.requests.some(request => request.id === 'new-audit-request'), true);
  assert.equal(next.bundle('T5')!.runs.some(run => run.id === 'R8'), true);
  assert.equal(next.bundle('T5')!.task.meta.log.some(log => log.id === 'new-audit-log'), true);
  assert.deepEqual(next.inputsByAttempt('new-audit-attempt'), ['new-audit-input']);
  h.db.prepare("DELETE FROM run_inputs WHERE input_id='new-audit-input'").run();
  const deleted = next.reloadBundles(h.db, ['T5'], 3 as ProjectionVersion).next;
  assert.deepEqual(deleted.inputsByAttempt('new-audit-attempt'), []);
  assert.equal(h.records.bundle('T5'), held);
  assert.equal(held.requests.some(request => request.id === 'new-audit-request'), false);
  const results = sweep(h);
  assert.ok(kinds(results, 'T5').has('records'));
  assert.ok(kinds(results, 'T5').has('derived'));
  // A later repair must read the latest value, rather than publishing the audit's candidate.
  h.db.prepare("UPDATE tasks SET title='Latest repair value',revision=revision+1 WHERE external_id='T5'").run();
  const repair = h.records.reloadBundles(h.db, ['T5'], 4 as ProjectionVersion).next;
  assert.equal(repair.bundle('T5')!.task.meta.title, 'Latest repair value');
});

test('a missing task and schema definitions are discovered by the bounded database cursor', t => {
  const h = fixture(t), uuid = randomUUID();
  h.db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,created_at,updated_at)
    SELECT ?,'task',15,p.id,p.id,'Missing synthetic task','active','todo',0,0,NULL,1,t.created_at,t.updated_at
    FROM tasks t JOIN tasks p ON p.external_id='P1' WHERE t.external_id='T14'`).run(uuid);
  const field = { ...h.records.catalog().get('notes')!, id: 'audit_custom', title: 'Audit field', required: false };
  h.db.prepare('INSERT INTO field_defs(id,definition,updated_at) VALUES (?,?,?)').run(field.id, JSON.stringify(field), at);
  for (const [position, id] of [...DEFAULT_SCHEMA, field.id].entries())
    h.db.prepare("INSERT INTO project_fields(project_task_id,position,field_id) VALUES ((SELECT id FROM tasks WHERE external_id='P1'),?,?)").run(position, id);
  const results = sweep(h);
  assert.ok(kinds(results, 'T15').has('records'));
  assert.ok(kinds(results, 'P1').has('records'));
  assert.ok(results.some(result => result.reloadKeys.some(key => key.kind === 'field_def' && key.id === field.id)));
  const result = h.records.reloadBundles(h.db, ['T15', 'P1'], 2 as ProjectionVersion, [{ kind: 'field_def', id: field.id }]).next;
  assert.ok(result.catalog().has(field.id));
  assert.equal(result.bundle('T15')!.task.meta.title, 'Missing synthetic task');
  assert.ok(result.schemaOf('P1').fields.includes(field.id));
});

test('derivation of the selected task refreshes a related dependency bundle', t => {
  const h = fixture(t);
  h.db.prepare("INSERT INTO task_dependencies(task_id,after_task_id) VALUES ('T5','T3')").run();
  const records = h.records.reloadBundles(h.db, ['T5'], pv).next;
  const values = new Map(h.values); values.set('T5', deriveTask(records, 'T5'));
  const frame = { ...h.frame, records, derived: (id: string) => values.get(id) };
  h.db.prepare("UPDATE tasks SET title='Fresh dependency title',revision=revision+1 WHERE external_id='T3'").run();
  const results = sweep(h, frame);
  assert.ok(kinds(results, 'T5').has('derived'));
  assert.ok(kinds(results, 'T3').has('records'));
});

test('sent Request audit reads discover newly received work and changed destination facts from the sender alone', t => {
  const h = fixture(t), held = h.records.sentRequests('T2');
  h.db.prepare("UPDATE requests SET delivery_state='aborted' WHERE id='fixture-request-4'").run();
  h.db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state,wait_cycle_id)
    SELECT 'new-sent-audit-request','T14','fixture-placement-14',placement_revision,task_hash,mode,'New synthetic sent work',purpose,author,submitted_at,delivery_state,wait_cycle_id
    FROM requests WHERE id='fixture-request-7'`).run();
  const { resultHead: _, ...receiving } = h.records.run('R7')!;
  h.db.prepare("INSERT INTO runs(id,record,prompt) VALUES (8,?,'Synthetic sent work')")
    .run(JSON.stringify({ ...receiving, id: 'R8', task: 'T14', placementId: 'fixture-placement-14', requestId: 'new-sent-audit-request' }));
  const candidate = auditCandidate(h.db, h.records, ['T2'], []);
  const sent = candidate.read(id => candidate.reader.sentRequests(id)).get('T2')!;
  assert.ok(sent.some(request => request.id === 'new-sent-audit-request'));
  assert.equal(sent.find(request => request.id === 'fixture-request-4')!.deliveryState, 'aborted');
  assert.equal(held.some(request => request.id === 'new-sent-audit-request'), false);
  assert.equal(held.find(request => request.id === 'fixture-request-4')!.deliveryState, 'queued');
});

test('coordinator owners without task bundles are audited and can request metadata-only repairs', t => {
  const h = fixture(t), conversation = randomUUID(), message = randomUUID();
  h.db.prepare('INSERT INTO coordinator_conversations(id,started_at) VALUES (?,?)').run(conversation, at);
  h.db.prepare("INSERT INTO requests(id,conversation_id,mode,body,purpose,author,submitted_at,delivery_state) VALUES (?,?,'new','Synthetic coordinator message','instruction','{\"kind\":\"human\"}',?,'queued')").run(message, conversation, at);
  const actual = coordinatorRecord('R8', { requestId: message, conversationId: conversation });
  h.db.prepare('INSERT INTO runs(id,record,prompt) VALUES (8,?,\'Synthetic\')').run(JSON.stringify(actual));
  const results = sweep(h);
  assert.ok(results.some(result => result.reloadKeys.some(key => key.kind === 'conversation' && key.id === conversation)));
  assert.ok(results.some(result => result.reloadKeys.some(key => key.kind === 'person' && key.id === 'coordinator')));
  const records = h.records.reloadBundles(h.db, [], pv, [{ kind: 'conversation', id: conversation }]).next;
  assert.equal(records.conversation(conversation)!.started_at, at);
  h.db.prepare("INSERT INTO requests(id,conversation_id,mode,body,purpose,author,submitted_at,delivery_state) VALUES (?,?,'new','Fresh coordinator message','instruction','{\"kind\":\"human\"}',?,'queued')")
    .run(randomUUID(), conversation, at);
  assert.ok(sweep(h, { ...h.frame, records }).some(result => result.reloadKeys.some(key => key.kind === 'conversation')));
});

test('aggregate corruption is detected separately and rebuilt without a contribution delta', t => {
  const h = fixture(t);
  // Deliberately damage a cached ancestor total while leaving every canonical record and contribution unchanged.
  const internal = h.aggregate as unknown as { nodes: { get(id: string): object; set(id: string, value: object): unknown } };
  const node = internal.nodes.get('P1');
  const damaged = Object.assign(Object.create(Object.getPrototypeOf(h.aggregate)), h.aggregate,
    { nodes: internal.nodes.set('P1', { ...node, belowWorking: 901 }) }) as AggregateSnapshot;
  const results = sweep(h, { ...h.frame, aggregate: damaged });
  assert.ok(results.some(result => result.repairs.some(repair => repair.kinds.has('aggregate'))));
  assert.equal(results.some(result => result.repairs.some(repair => repair.kinds.has('records'))), false);
  assert.equal(damaged.workingBelow('P1'), 901, 'audit never repairs a held frame in place');
  const next = repairScreenAggregate(damaged, [{ task: 'T5', kind: 'aggregate' }]).next;
  assert.equal(next.workingBelow('P1'), h.aggregate.workingBelow('P1'));
});

test('audit skips a lagging projection and discards a candidate when the latest floor changes', t => {
  const h = fixture(t), audit = new ProjectionAudit();
  assert.equal(audit.tick(h.db, h.frame, () => 1 as ChangeSeq).skipped, true);
  let checks = 0;
  const result = audit.tick(h.db, h.frame, () => checks++ === 0 ? seq : 1 as ChangeSeq);
  assert.equal(result.skipped, true);
  assert.deepEqual(result.repairs, []);
  assert.deepEqual(result.reloadKeys, []);
});

test('membership and order damage request their own repair classes', t => {
  const h = fixture(t);
  const internal = h.aggregate as unknown as {
    nodes: { get(id: string): object; set(id: string, value: object): unknown };
    homeOrder: { first(): [unknown, string]; delete(key: unknown): unknown };
  };
  const [key, first] = internal.homeOrder.first();
  const damaged = Object.assign(Object.create(Object.getPrototypeOf(h.aggregate)), h.aggregate, {
    nodes: internal.nodes.set(first, { ...internal.nodes.get(first), live: 0 }),
    homeOrder: internal.homeOrder.delete(key),
  }) as AggregateSnapshot;
  const results = sweep(h, { ...h.frame, aggregate: damaged });
  assert.ok(kinds(results, first).has('membership'));
  assert.ok(kinds(results, first).has('order'));
  assert.equal(results.some(result => result.repairs.some(repair => repair.kinds.has('records'))), false);
});

test('scope-count summaries are audited through one scope rather than whole count materialization', t => {
  const h = fixture(t);
  const internal = h.aggregate as unknown as {
    scopes: { get(id: string): { root: { total: readonly number[] } }; set(id: string, value: object): unknown };
  };
  const totals = internal.scopes.get('root');
  const corrupted = Object.assign(Object.create(Object.getPrototypeOf(totals)), totals,
    { root: { ...totals.root, total: totals.root.total.map(value => value + 100) } });
  const damaged = Object.assign(Object.create(Object.getPrototypeOf(h.aggregate)), h.aggregate,
    { scopes: internal.scopes.set('root', corrupted) }) as AggregateSnapshot;
  // These full materializations must never be called by the audit.
  t.mock.method(Object.getPrototypeOf(h.aggregate), 'counts', () => { throw new Error('Whole count materialization is forbidden'); });
  t.mock.method(Object.getPrototypeOf(h.aggregate), 'page', () => { throw new Error('Whole page materialization is forbidden'); });
  const results = sweep(h, { ...h.frame, aggregate: damaged });
  assert.ok(results.some(result => result.repairs.some(repair => repair.kinds.has('aggregate'))));
  const next = repairScreenAggregate(damaged, [{ task: 'T5', kind: 'aggregate' }]).next;
  assert.deepEqual(next.scopeCounts('root'), h.aggregate.scopeCounts('root'));
});


test('asynchronous audit yields while retaining one snapshot and discards evidence after the floor advances', async t => {
  const h = fixture(t), held = h.records.bundle('T5')!, title = held.task.meta.title;
  let settled = false;
  const pending = new ProjectionAudit().tickAsync(h.root, h.frame, () => seq, { limit: 30, sliceMs: 0 })
    .finally(() => { settled = true; });
  await nextTurn();
  assert.equal(settled, false, 'other event loop work runs before the audit completes');
  // This silent writer commits after the audit has selected its snapshot, while its read transaction is suspended.
  h.db.prepare("UPDATE tasks SET title='Changed during audit',revision=revision+1 WHERE external_id='T5'").run();
  const beforeWrite = await pending;
  assert.equal(beforeWrite.skipped, false);
  assert.deepEqual(beforeWrite.repairs, [], 'one audit cannot mix pre-write and post-write bundles');
  const afterWrite = await new ProjectionAudit().tickAsync(h.root, h.frame, () => seq, { limit: 30 });
  assert.ok(afterWrite.repairs.some(repair => repair.task === 'T5' && repair.kinds.has('records')));
  assert.equal(h.records.bundle('T5'), held);
  assert.equal(held.task.meta.title, title);
  let latest = seq;
  const stale = new ProjectionAudit().tickAsync(h.root, h.frame, () => latest, { limit: 30, sliceMs: 0 });
  await nextTurn();
  latest = 1 as ChangeSeq;
  const discarded = await stale;
  assert.equal(discarded.skipped, true);
  assert.deepEqual(discarded.repairs, []);
  assert.deepEqual(discarded.reloadKeys, []);
});
