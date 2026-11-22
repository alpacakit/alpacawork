/** A published reader survives later writes; the next reader agrees with a fresh read of the same database. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChangeLog, openControlDatabase, type ChangeKey } from '@alpacawork/db';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SCHEMA, historyCursor } from '@alpacawork/contract';
import { HISTORY_WINDOW_MAX, type ProjectionVersion } from '@alpacawork/contract/control';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { emptyWorkspaceRecords, ownerLookup, resultHeadOf, type DatabaseWorkspaceRecords } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { aggregateFactsOf } from '@alpacawork/backend/test-dist/receiver/workspace-aggregate-facts.js';
import { readTask } from '@alpacawork/backend/test-dist/control/task-store.js';
import { ProjectionOwner } from '@alpacawork/backend/test-dist/receiver/projection-owner.js';
import { affected, withoutActivity } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';
import { coordinatorRecord } from './runs-fixtures.ts';
import type { PublishedFrame, RunFileRecord } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
const pv = (n: number) => n as ProjectionVersion;
const at = '2026-11-16T00:00:00.000Z';
function fixture(t: TestContext) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-records-')));
  const original = createOriginal({ tasks: 14, logs: 28, runs: 7, seed: 'workspace-records' }, join(area, 'originals'));
  const root = copyWorkspace(original.root, join(area, 'working')).root;
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 });
  t.after(() => { db.close(); removeWorkspace(root); removeWorkspace(original.root); rmSync(area, { recursive: true, force: true }); });
  return { root, db, load: () => emptyWorkspaceRecords(root).load(db, pv(1)) };
}
function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Map) return [...value].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, value]) => [key, normalize(value)]);
  if (value instanceof Set) return [...value].sort();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, normalize(value)]));
  return value;
}
function snapshot(records: DatabaseWorkspaceRecords) {
  const ids = [...records.taskIds()].sort();
  const runs = ids.flatMap(id => records.bundle(id)!.runs.map(run => run.id));
  return normalize({ tasks: ids.map(id => ({ id, bundle: records.bundle(id), parent: records.parent(id), children: records.children(id),
    ancestors: records.ancestors(id), subtree: [...records.subtree(id)], project: records.projectOf(id), scopes: records.scopes(id),
    dependents: records.dependents(id), senders: records.sendersTo(id), targets: records.targetsFromAll(id), causes: records.returnsByCauseTask(id),
    questions: records.questionsByDestination(id), histories: records.historyReferrers(id), sent: records.sentRequests(id),
    schema: records.bundle(id)!.task.meta.kind === 'project' ? records.schemaOf(id) : null,
    schemaUsers: records.schemaUsers(id) })),
    runs: runs.map(id => [id, records.run(id), records.runOwner(id), records.runReferrers(id), records.joinedMessages(id), records.inputsByInstruction(id)]),
    logOwners: ids.flatMap(id => records.bundle(id)!.task.meta.log.map(log => [log.id, records.logOwner(log.id)])),
    placements: ids.flatMap(id => records.bundle(id)!.placements.map(p => [p.id, records.placementOwner(p.id), records.placementWritesTo(p.id)])),
    requests: ids.flatMap(id => records.bundle(id)!.requests.map(q => [q.id, records.requestOwner(q.id), records.runByRequest(q.id),
      records.closedRequest(q.id), records.deliveriesByWakeRequest(q.id)])),
    returns: ids.flatMap(id => records.bundle(id)!.returns.map(r => [r.id, records.returnOwner(r.id)])),
    fields: records.catalog(), fieldUsers: [...records.catalog().keys()].sort().map(id => [id, records.fieldUsers(id)]),
    shelf: records.shelf().catalog(), shelfRevision: records.shelf().revision, environment: records.environment(), settings: records.seatSettings() });
}
function log(db: DatabaseSync, task: string, id: string, extra: object = {}) {
  const uuid = String(db.prepare('SELECT id FROM tasks WHERE external_id=?').get(task)!.id);
  const ordinal = Number(db.prepare('SELECT coalesce(max(ordinal),-1)+1 AS n FROM task_log WHERE task_id=?').get(uuid)!.n);
  db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)').run(id, uuid, ordinal, JSON.stringify({
    id, kind: 'reported', at, actor: { kind: 'human' }, fromState: null, toState: null, title: 'Synthetic observation', description: 'Synthetic details', ...extra }));
}

test('activity updates list patches without aging the opened view, while batched record changes still age it', async t => {
  const h = fixture(t), journal = new ChangeLog();
  h.db.prepare("UPDATE tasks SET base_state='doing',revision=revision+1 WHERE external_id='T5'").run();
  h.db.prepare("UPDATE runs SET record=json_set(record,'$.state','running','$.ended_at',NULL,'$.exit',NULL,'$.reason',NULL) WHERE id=4").run();
  let files: RunFileRecord = { activity: null, errorCause: undefined };
  const owner = new ProjectionOwner({ root: h.root, generation: 'activity-regression', log: journal,
    observations: { runFiles: run => run.id === 'R4' ? files : { activity: null, errorCause: undefined } },
    locations: () => ({}), published: () => {}, personal: async () => ({ notices: null,
      person: { settings: null, notices: null, coordinator: null }, presence: { state: 'away', until: null }, host: null, coordinatorWork: null, launchMemory: { agent: null, values: {}, version: 0 } }) });
  try {
    await owner.start();
    let before = owner.current!;
    const task = before.records.runOwner('R4')!;
    for (const [index, kind] of (['output', 'output', 'tool_start', 'tool_end'] as const).entries()) {
      files = { activity: { at: new Date(Date.parse(at) + index * 1000).toISOString(),
        kind, toolName: kind.startsWith('tool') ? 'Synthetic tool' : null,
        doing: null, note: { at, text: `Synthetic output ${index}` } }, errorCause: index === 3 ? 'weekly_limit' : undefined };
      const keys: ChangeKey[] = [{ kind: 'activity', id: 'R4' }];
      const after = await owner.read(journal.append(keys));
      const impact = affected({ before: before.records, after: after.records, keys, owners: new Set([task]) });
      assert.deepEqual([...impact.tasks.get(task)!], ['row'], 'activity reaches only the list');
      assert.equal(after.requiredPv.view[task], before.requiredPv.view[task], 'activity must not request a detail reload');
      assert.deepEqual(withoutActivity(after.derived(task)!), withoutActivity(before.derived(task)!));
      const patch = after.patch!;
      assert.deepEqual(patch.requiredPv.view.upsert, {});
      assert.deepEqual(patch.tasks.upsert, [], 'activity leaves the list row facts intact');
      assert.deepEqual(patch.runs.upsert.find(run => run.id === 'R4')?.activity, files.activity);
      assert.equal(patch.runs.upsert.find(run => run.id === 'R4')?.errorCause, files.errorCause);
      assert.equal(patch.placements.upsert.find(placement => placement.taskId === task)?.runtime.lastOutputAt, files.activity!.at);
      before = after;
    }
    // Activity in the same publication must never suppress a real record change.
    for (const kind of ['log', 'run'] as const) {
      const keys: ChangeKey[] = [{ kind: 'activity', id: 'R4' }];
      if (kind === 'log') {
        log(h.db, task, 'synthetic-activity-report');
        keys.push({ kind: 'log', id: 'synthetic-activity-report' });
      } else {
        h.db.prepare("UPDATE runs SET record=json_set(record,'$.state','succeeded','$.ended_at',?) WHERE id=4").run(at);
        keys.push({ kind: 'run', id: 'R4' });
      }
      const after = await owner.read(journal.append(keys));
      const impact = affected({ before: before.records, after: after.records, keys, owners: new Set([task]) });
      for (const facet of ['view', 'seat', 'push', 'membership'] as const) assert.ok(impact.tasks.get(task)?.has(facet));
      assert.ok(after.requiredPv.view[task]! > before.requiredPv.view[task]!);
      before = after;
    }
  } finally { await owner.close(); }
});

test('key advances preserve old publications and agree with full reads across Task, Run, return, input and schema changes', t => {
  const h = fixture(t);
  let records = h.load(), version = 1;
  for (const id of records.taskIds()) assert.deepEqual(records.bundle(id)!.task, readTask(h.db, id));
  const original = records, originalSnapshot = snapshot(original);
  const step = (keys: ChangeKey[], write: () => void) => {
    const before = records, held = snapshot(before);
    h.db.exec('BEGIN'); try { write(); h.db.exec('COMMIT'); } catch (error) { h.db.exec('ROLLBACK'); throw error; }
    const change = records.advance(h.db, keys, pv(++version)); records = change.next;
    assert.deepEqual(snapshot(before), held, 'the previous publication remains readable');
    assert.deepEqual(snapshot(records), snapshot(emptyWorkspaceRecords(h.root).load(h.db, pv(version))), JSON.stringify(keys));
    return change;
  };
  const untouched = records.bundle('T14'), taskLog = records.bundle('T5')!.task.meta.log;
  step([{ kind: 'task_value', id: 'T5' }], () => h.db.prepare(`UPDATE task_values SET value=? WHERE task_id=(SELECT id FROM tasks WHERE external_id='T5') AND field_id='notes'`).run(JSON.stringify('Changed synthetic note')));
  assert.equal(records.bundle('T14'), untouched);
  assert.equal(records.bundle('T5')!.task.meta.log, taskLog);
  step([{ kind: 'task', id: 'T5' }], () => h.db.prepare(`UPDATE tasks SET title='New synthetic title',revision=revision+1,parent_id=(SELECT id FROM tasks WHERE external_id='T3') WHERE external_id='T5'`).run());
  assert.equal(records.parent('T5'), 'T3'); assert.ok(records.children('T3').includes('T5'));
  step([{ kind: 'log', id: 'question' }], () => log(h.db, 'T3', 'question', { kind: 'asked', askedTo: 'T4', decide: [{ choice: 'Synthetic choice' }], actor: { kind: 'placement', placementId: 'fixture-placement-2' } }));
  assert.deepEqual(records.questionsByDestination('T4'), ['T3']);
  assert.ok(records.placementWritesTo('fixture-placement-2').includes('T3'));
  assert.ok(records.historyReferrers('T4').includes('T3'));
  step([{ kind: 'dependency', id: 'T5' }], () => h.db.prepare("INSERT INTO task_dependencies(task_id,after_task_id) VALUES ('T5','T3')").run());
  assert.deepEqual(records.dependents('T3'), ['T5']);
  const otherRun = records.run('R1');
  step([{ kind: 'run', id: 'R4' }], () => h.db.prepare('UPDATE runs SET record=json_set(record,\'$.usage\',json(?)) WHERE id=4')
    .run(JSON.stringify({ conversation: null, run: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, includesEarlier: false })));
  assert.equal(records.run('R1'), otherRun);
  assert.ok(resultHeadOf(records.run('R4')!)!.startsWith('Synthetic result 4.'));
  assert.equal(resultHeadOf(records.run('R4')!)!.length, 300);
  assert.ok(records.sendersTo('T5').includes('T2'));
  assert.ok(records.targetsFromAll('T2').includes('T5'));
  step([{ kind: 'return', id: 'new-close' }], () => h.db.prepare("INSERT INTO returns(id,request_id,to_task_id,outcome,boundary_run_id,created_at) VALUES ('new-close','fixture-request-4','T2','succeeded','R4',?)").run(at));
  assert.equal(records.closedRequest('fixture-request-4'), true);
  assert.ok(!records.sendersTo('T5').includes('T2'));
  step([{ kind: 'delivery', id: 'new-close:fixture-request-1' }], () => h.db.prepare("INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at) VALUES ('new-close','fixture-request-1',?)").run(at));
  assert.deepEqual(records.deliveriesByWakeRequest('fixture-request-1'), ['new-close']);
  step([{ kind: 'delivery', id: 'new-close:fixture-request-1' }], () => h.db.prepare("DELETE FROM return_deliveries WHERE return_id='new-close'").run());
  const removed = step([{ kind: 'return', id: 'new-close' }], () => h.db.prepare("DELETE FROM returns WHERE id='new-close'").run());
  assert.ok(removed.owners.has('T2')); assert.equal(records.closedRequest('fixture-request-4'), false);
  const inputChange = step([{ kind: 'input', id: 'synthetic-input' }, { kind: 'attempt', id: '4' }], () => {
    h.db.prepare("INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES (4,'attempt-four','{}')").run();
    h.db.prepare("INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial) VALUES ('synthetic-input','attempt-four',2,'digest','uncertain',0)").run();
  });
  assert.deepEqual([...inputChange.owners].sort(), ['T3', 'T5']);
  assert.ok(records.bundle('T5')!.inputs.uncertain.get('fixture-placement-5')!.has('R2'));
  assert.deepEqual(records.inputsByInstruction('R2'), ['synthetic-input']);
  const changedInstruction = step([{ kind: 'input', id: 'synthetic-input' }], () => h.db.prepare("UPDATE run_inputs SET instruction_run_no=3 WHERE input_id='synthetic-input'").run());
  assert.deepEqual([...changedInstruction.owners].sort(), ['T3', 'T4', 'T5']);
  assert.deepEqual(records.inputsByInstruction('R2'), []);
  assert.deepEqual(records.inputsByInstruction('R3'), ['synthetic-input']);
  step([{ kind: 'input', id: 'synthetic-input' }], () => h.db.prepare("DELETE FROM run_inputs WHERE input_id='synthetic-input'").run());
  assert.deepEqual(records.inputsByInstruction('R3'), []);
  step([{ kind: 'attempt', id: 'attempt-four' }], () => h.db.prepare("UPDATE run_attempts SET diagnostic='{}' WHERE run_no=4").run());
  assert.ok(records.bundle('T5')!.inputs.closed.has('R4'));
  h.db.prepare("INSERT INTO agents(id,created_at) VALUES ('moving-agent',?)").run(at);
  step([{ kind: 'placement', id: 'moving-placement' }], () => h.db.prepare("INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at) VALUES ('moving-placement','T3','moving-agent','fixture',0,1,?)").run(at));
  const moved = step([{ kind: 'placement', id: 'moving-placement' }], () => h.db.prepare("UPDATE placements SET task_id='T4' WHERE id='moving-placement'").run());
  assert.deepEqual([...moved.owners].sort(), ['T3', 'T4']);
  step([{ kind: 'placement', id: 'moving-placement' }], () => h.db.prepare("DELETE FROM placements WHERE id='moving-placement'").run());
  const custom = { ...records.catalog().get('notes')!, id: 'synthetic_field', title: 'Synthetic field', required: false };
  step([{ kind: 'field_def', id: custom.id }, { kind: 'project_field', id: 'P1' }], () => {
    h.db.prepare('INSERT INTO field_defs(id,definition,updated_at) VALUES (?,?,?)').run(custom.id, JSON.stringify(custom), at);
    for (const [position, field] of [...DEFAULT_SCHEMA, custom.id].entries()) h.db.prepare("INSERT INTO project_fields(project_task_id,position,field_id) VALUES ((SELECT id FROM tasks WHERE external_id='P1'),?,?)").run(position, field);
  });
  assert.deepEqual(records.fieldUsers(custom.id), ['P1']); assert.deepEqual(records.schemaUsers('P1'), ['P1']);
  step([{ kind: 'task', id: 'P15' }], () => h.db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,created_at,updated_at)
    SELECT ?,'project',15,id,NULL,'Nested synthetic project',lifecycle,base_state,hold,user_requested,settings,1,created_at,updated_at FROM tasks WHERE external_id='P1'`).run(randomUUID()));
  assert.deepEqual(records.fieldUsers(custom.id), ['P1', 'P15']);
  assert.deepEqual(records.schemaUsers('P1'), ['P1', 'P15']);
  step([{ kind: 'task', id: 'T16' }], () => h.db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,created_at,updated_at)
    SELECT ?,'task',16,p.id,p.id,t.title,t.lifecycle,t.base_state,t.hold,t.user_requested,NULL,1,t.created_at,t.updated_at FROM tasks t JOIN tasks p ON p.external_id='P15' WHERE t.external_id='T14'`).run(randomUUID()));
  assert.deepEqual(records.scopes('T16'), ['root', 'P1', 'P15']);
  step([{ kind: 'project_field', id: 'P15' }], () => {
    for (const [position, field] of DEFAULT_SCHEMA.entries()) h.db.prepare("INSERT INTO project_fields(project_task_id,position,field_id) VALUES ((SELECT id FROM tasks WHERE external_id='P15'),?,?)").run(position, field);
  });
  assert.deepEqual(records.fieldUsers(custom.id), ['P1']);
  assert.deepEqual(records.schemaUsers('P15'), ['P15']);
  step([{ kind: 'task', id: 'P15' }], () => h.db.prepare("UPDATE tasks SET lifecycle='archived',revision=revision+1 WHERE external_id='P15'").run());
  assert.deepEqual(records.scopes('T16'), ['root']);
  step([{ kind: 'project_field', id: 'P15' }], () => h.db.prepare("DELETE FROM project_fields WHERE project_task_id=(SELECT id FROM tasks WHERE external_id='P15')").run());
  assert.deepEqual(records.fieldUsers(custom.id), ['P1', 'P15']);
  step([{ kind: 'project_field', id: 'P1' }], () => h.db.prepare("DELETE FROM project_fields WHERE project_task_id=(SELECT id FROM tasks WHERE external_id='P1')").run());
  step([{ kind: 'field_def', id: custom.id }], () => h.db.prepare('DELETE FROM field_defs WHERE id=?').run(custom.id));
  assert.deepEqual(snapshot(original), originalSnapshot);
});

test('joined coordinator messages and every key owner retain their Task links across later coordinator completion', t => {
  const h = fixture(t), conversation = randomUUID(), message = randomUUID(), joined = randomUUID();
  const uuid = String(h.db.prepare("SELECT id FROM tasks WHERE external_id='T3'").get()!.id);
  let records = h.load();
  h.db.exec('BEGIN');
  h.db.prepare('INSERT INTO coordinator_conversations(id,started_at) VALUES (?,?)').run(conversation, at);
  for (const request of [message, joined]) h.db.prepare("INSERT INTO requests(id,conversation_id,mode,body,purpose,author,submitted_at,delivery_state) VALUES (?,?,'new','Synthetic message','instruction','{\"kind\":\"human\"}',?,'queued')").run(request, conversation, at);
  const actual = coordinatorRecord('R8', { requestId: message, conversationId: conversation });
  const proxy = coordinatorRecord('R9', { requestId: joined, conversationId: conversation, state: 'joined', into: 'R8', ended_at: at });
  h.db.prepare('INSERT INTO runs(id,record,prompt) VALUES (8,?,\'Synthetic\')').run(JSON.stringify(actual));
  h.db.prepare('INSERT INTO runs(id,record,prompt) VALUES (9,?,\'Synthetic\')').run(JSON.stringify(proxy));
  h.db.prepare('INSERT INTO task_dialogues(task_uuid,request_id) VALUES (?,?)').run(uuid, joined);
  h.db.exec('COMMIT');
  records = records.advance(h.db, [{ kind: 'conversation', id: conversation }, { kind: 'run', id: 'R8' }, { kind: 'run', id: 'R9' },
    { kind: 'dialogue', id: `${uuid}:${joined}` }], pv(2)).next;
  assert.deepEqual(records.joinedMessages('R8'), [joined]); assert.deepEqual(records.dialogueTasks(joined), ['T3']);
  const before = records;
  h.db.prepare("UPDATE runs SET record=?,result='Synthetic answer',result_state='present' WHERE id=8").run(JSON.stringify({ ...actual, state: 'succeeded', ended_at: at }));
  records = records.advance(h.db, [{ kind: 'run', id: 'R8' }], pv(3)).next;
  assert.equal(before.bundle('T3')!.dialogues[0]!.answer, null);
  assert.equal(records.bundle('T3')!.dialogues[0]!.answer, 'Synthetic answer');
  assert.deepEqual(snapshot(records), snapshot(emptyWorkspaceRecords(h.root).load(h.db, pv(3))));
  assert.deepEqual(records.coordinatorRun(joined), { agent: proxy.agent, modelId: null, effort: null });
  const checks: [keyof typeof ownerLookup, string, string | null][] = [
    ['task', 'T3', 'T3'], ['task_value', 'T3', 'T3'], ['dependency', 'T3', 'T3'], ['stop_epoch', 'T3', 'T3'],
    ['log', 'fixture-log-2', 'T3'], ['placement', 'fixture-placement-3', 'T3'], ['wait_cycle', 'fixture-cycle', 'T2'],
    ['request', 'fixture-request-2', 'T3'], ['start_grant', 'fixture-request-2', 'T3'], ['run', 'R2', 'T3'], ['attempt', '2', 'T3'],
    ['return', 'fixture-return-2', 'T2'], ['resolution', 'fixture-return-2', 'T2'], ['delivery', 'fixture-return-2:fixture-request-1', 'T2'],
    ['dialogue', `${uuid}:${joined}`, 'T3'], ['refusal', `${joined}:${uuid}`, 'T3'], ['project_field', 'P1', 'P1'],
    ['request', joined, null], ['run', 'R9', null], ['conversation', conversation, null],
  ];
  for (const [kind, id, task] of checks) assert.equal(ownerLookup[kind](h.db, [id]).get(id)?.task, task, `${String(kind)}:${id}`);
});

test('an unrelated malformed schema does not block a Run change; a failed advance leaves its published facts intact', t => {
  const h = fixture(t), before = h.load(), held = snapshot(before);
  h.db.prepare("INSERT INTO field_defs(id,definition,updated_at) VALUES ('broken','{\"id\":\"broken\"}',?)").run(at);
  const after = before.advance(h.db, [{ kind: 'run', id: 'R4' }], pv(2)).next;
  assert.equal(after.catalog(), before.catalog());
  assert.deepEqual(snapshot(before), held);
  assert.throws(() => after.advance(h.db, [{ kind: 'field_def', id: 'broken' }], pv(3)));
  assert.equal(after.bundle('T14'), before.bundle('T14'));
  assert.equal(after.pv, pv(2));
});

test('folder observations, Request ordering and personal count facts all read the published snapshot', t => {
  const h = fixture(t);
  const files = new Map<string, { activity: import('@alpacawork/contract').RunActivity | null; errorCause: 'weekly_limit' | undefined }>();
  const fileLists = new Map<string, { name: string; size: number; revision: string; at: string }[]>();
  const config = { environment: { root: h.root, profiles: [], attachmentBytes: 1024, writable: true, errors: [] },
    settings: { profiles: new Set(['synthetic']), automaticLimit: 3 } };
  const observations = { runFiles: (run: { id: string }) => files.get(run.id) ?? { activity: null, errorCause: undefined },
    files: (task: string) => fileLists.get(task) ?? [], configuration: () => config };
  const before = emptyWorkspaceRecords(h.root, observations).load(h.db, pv(1));
  const activity = { at, kind: 'output' as const, toolName: null, doing: null, note: { at, text: 'Synthetic output' } };
  files.set('R4', { activity, errorCause: 'weekly_limit' });
  const after = before.advance(h.db, [{ kind: 'activity', id: 'R4' }], pv(2)).next;
  assert.equal(before.bundle('T5')!.runFiles!.get('R4')!.activity, null);
  assert.equal(after.bundle('T5')!.runFiles!.get('R4')!.activity!.note!.text, 'Synthetic output');
  assert.equal(after.bundle('T5')!.runFiles!.get('R4')!.errorCause, 'weekly_limit');
  assert.equal(after.bundle('T14'), before.bundle('T14'));
  activity.note.text = 'Later synthetic output';
  assert.equal(after.bundle('T5')!.runFiles!.get('R4')!.activity!.note!.text, 'Synthetic output');
  activity.note.text = 'Synthetic output';
  assert.deepEqual(snapshot(after), snapshot(emptyWorkspaceRecords(h.root, observations).load(h.db, pv(2))));
  for (const id of ['z-earlier', 'a-later']) h.db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state)
    VALUES (?,'T5','fixture-placement-5',1,?,'new','Synthetic request','instruction','{"kind":"human"}',?,'queued')`).run(id, '0'.repeat(64), at);
  const withRequests = after.advance(h.db, [{ kind: 'request', id: 'z-earlier' }, { kind: 'request', id: 'a-later' }], pv(3)).next;
  const requested = withRequests.bundle('T5')!.requests.filter(request => ['z-earlier', 'a-later'].includes(request.id));
  assert.deepEqual(requested.map(request => request.id), ['a-later', 'z-earlier']);
  const row = { state: 'done', notice: { bodyHash: 'body', logCount: 2, lastNoticed: { kind: 'reported', position: 1, at }, turnKey: null } };
  assert.deepEqual(aggregateFactsOf(withRequests, 'T5', row, null), { scopes: ['root', 'P1'], listed: true, menuRunning: false, freshFinished: false });
  assert.equal(aggregateFactsOf(withRequests, 'T5', row, { checkpoint: { tasks: {} }, reads: {} }).freshFinished, true);
  assert.equal(aggregateFactsOf(withRequests, 'T5', row, { checkpoint: { tasks: { T5: { log: 2, state: 'done', body: 'body' } } }, reads: {} }).freshFinished, false);
  fileLists.set('T5', [{ name: 'synthetic.md', size: 12, revision: 'synthetic', at }]);
  const withFiles = withRequests.advance(h.db, [{ kind: 'files', id: 'T5' }], pv(4)).next;
  assert.deepEqual(withRequests.bundle('T5')!.files, []);
  assert.equal(withFiles.bundle('T5')!.files![0]!.name, 'synthetic.md');
  fileLists.get('T5')![0]!.name = 'later.md';
  assert.equal(withFiles.bundle('T5')!.files![0]!.name, 'synthetic.md');
  config.environment.attachmentBytes = 2048; config.settings.profiles.add('later');
  const withConfig = withFiles.advance(h.db, [{ kind: 'config', id: 'config.yaml' }], pv(5)).next;
  assert.equal(withFiles.environment().attachmentBytes, 1024);
  assert.equal(withFiles.seatSettings().profiles.has('later'), false);
  assert.equal(withConfig.environment().attachmentBytes, 2048);
  assert.equal(withConfig.seatSettings().profiles.has('later'), true);
  assert.equal(withConfig.bundle('T5'), withFiles.bundle('T5'));
});

test('History reverse references cover exactly the Tasks named across all own and direct-child events', async t => {
  const h = fixture(t);
  log(h.db, 'T6', 'named-question', { kind: 'asked', askedTo: 'T4', decide: [{ choice: 'Synthetic choice' }], actor: { kind: 'placement', placementId: 'fixture-placement-2' } });
  log(h.db, 'T5', 'named-dependency', { kind: 'dependencies_changed', dependencies: { after: ['T4'], previous: ['T6'] } });
  h.db.prepare("UPDATE tasks SET parent_id=(SELECT id FROM tasks WHERE external_id='T3') WHERE external_id='T7'").run();
  h.db.prepare("UPDATE runs SET record=json_set(record,'$.state','joined','$.into','R4') WHERE id=3").run();
  log(h.db, 'T7', 'named-cause', { toState: 'done', runId: 'R4' });
  h.db.prepare("INSERT INTO returns(id,to_task_id,outcome,cause_log_id,created_at) VALUES ('named-return','T4','question','named-question',?)").run(at);
  h.db.prepare("INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at) VALUES ('named-return','fixture-request-3',?)").run(at);
  const records = h.load();
  // The oracle is the History a reader opens: the Tasks each one names, over its whole window.
  const { ProjectedHistory } = await import('@alpacawork/backend/test-dist/receiver/task-reads.js');
  const histories = new ProjectedHistory();
  const frame = { generation: 'history-reference-oracle', pv: pv(1), records } as unknown as PublishedFrame;
  const expected = new Map<string, Set<string>>();
  for (const id of records.taskIds()) {
    const all = histories.events(frame, id);
    const window = histories.read(frame, id, all.length ? { mode: 'since', since: historyCursor(all.at(-1)!), keep: HISTORY_WINDOW_MAX } : { mode: 'latest' });
    assert.equal(window.hasOlder, false, `${id}'s whole History is read`);
    for (const name of Object.keys(window.tasks ?? {})) {
      const refs = expected.get(name) ?? new Set<string>(); refs.add(id); expected.set(name, refs);
    }
  }
  for (const id of records.taskIds()) assert.deepEqual(records.historyReferrers(id), [...expected.get(id) ?? []].sort(), id);
});
