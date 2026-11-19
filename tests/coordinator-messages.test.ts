/** Request identities own screen records; no registration, timer or exclusive Task ownership replaces turns. */
import { evidenceTest as test, rememberEvidenceWorkspace } from './helpers/failure-workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import type { CoordinatorRunRecord } from '@alpacawork/contract/run';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { deliveredMessages, dialoguesOf, linkMessage, messageForRun, resultsOf, sourceMessage } from
  '@alpacawork/backend/test-dist/coordinator/messages.js';
import { call, callerWorkspace, claudeConversation, post, run, conversationHeaders } from './coordinator-caller.fixture.ts';

const control = <T>(root: string, work: (db: DatabaseSync) => T): T => {
  const store = new ControlStore(root, { busyTimeoutMs: 1000 });
  try { return store.write(work); } finally { store.close(); }
};
const runtime = (root: string, id: string) => {
  const runs = new RunStore(root, { busyTimeoutMs: 1000 });
  try { return runs.runtimeGet(id) as CoordinatorRunRecord; } finally { runs.close(); }
};
/** A joined Request has both the joined Run reference and the taken receipt of its actual executing Run. */
function joinInput(root: string, head: { id: string }, joined: { id: string }, taken = true) {
  const runs = new RunStore(root, { busyTimeoutMs: 1000 });
  try {
    runs.write(tx => tx.finish({ ...tx.runtimeGet(joined.id)!, state: 'joined', into: head.id,
      ended_at: new Date().toISOString() }, { state: 'missing', text: null }));
    if (taken) runs.connection.prepare(`INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,
      content_digest,state,initial,receipt_json) SELECT ?,attempt_id,?,?,'taken',0,'{}' FROM run_attempts WHERE run_no=?`)
      .run(randomUUID(), Number(joined.id.slice(1)), 'a'.repeat(64), Number(head.id.slice(1)));
  } finally { runs.close(); }
}

test('a source Request is the pinned Run own input or a proved taken joined input, never a queued or other Run input', t => {
  const w = callerWorkspace(t), head = w.screenRun({ words: 'A', session: 'head' });
  const joined = w.screenRun({ words: 'B', session: null, running: false });
  const queued = w.screenRun({ words: 'Queued C', session: null, running: false });
  const other = w.screenRun({ words: 'Other Run', session: 'other' });
  joinInput(w.root, head, joined, false);
  control(w.root, db => {
    assert.deepEqual(deliveredMessages(db, head.id), [head.requestId]);
    assert.throws(() => sourceMessage(db, head.id, joined.requestId), { code: 'invalid_input' });
  });
  control(w.root, db => db.prepare(`INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial,receipt_json)
    SELECT ?,attempt_id,?,?,'taken',0,'{}' FROM run_attempts WHERE run_no=?`)
    .run(randomUUID(), Number(joined.id.slice(1)), 'b'.repeat(64), Number(head.id.slice(1))));
  control(w.root, db => {
    assert.deepEqual(deliveredMessages(db, head.id), [head.requestId, joined.requestId]);
    assert.equal(sourceMessage(db, head.id), head.requestId, 'later taken input does not steal an earlier operation record');
    assert.equal(sourceMessage(db, head.id, joined.requestId), joined.requestId);
    for (const id of [queued.requestId, other.requestId, randomUUID()])
      assert.throws(() => sourceMessage(db, head.id, id), { code: 'invalid_input' });
    assert.equal(messageForRun(db, other.id), other.requestId, 'a new Run has its own Request without a previous-Run fallback');
  });
});

test('Request links deduplicate explicit targets without inheriting prose or reply targets; words and answers stay in Request/Run', t => {
  const w = callerWorkspace(t), head = w.screenRun({ words: `Look at ${w.project} and T999999`, session: 'head',
    tasks: [w.project, w.project, ...Array.from({ length: 32 }, (_, n) => `T${900000 + n}`)] });
  control(w.root, db => {
    let lookups = 0;
    const prepare = db.prepare.bind(db);
    const hook = t.mock.method(db, 'prepare', (sql: string) => {
      if (/^SELECT/.test(sql) && /\b(?:FROM|JOIN) tasks\b/.test(sql)) lookups++;
      return prepare(sql);
    });
    try { linkMessage(db, runtime(w.root, head.id)); } finally { hook.mock.restore(); }
    assert.equal(lookups, 1, 'explicit labels share one lookup, including missing sample IDs');
    linkMessage(db, runtime(w.root, head.id));
    assert.equal(db.prepare('SELECT count(*) AS n FROM task_dialogues').get()!.n, 1);
    assert.deepEqual(dialoguesOf(db, [new TaskRepository(w.root, db).metadataWithHistory(w.project)]), [{ taskId: w.project, messageId: head.requestId,
      at: db.prepare('SELECT submitted_at FROM requests WHERE id=?').get(head.requestId)!.submitted_at,
      words: `Look at ${w.project} and T999999`, answer: null }]);
  });
  w.end(head, 'succeeded', 'Completed answer');
  const reply = w.screenRun({ words: 'Follow-up', session: 'reply', replyTo: head.requestId });
  control(w.root, db => {
    linkMessage(db, runtime(w.root, reply.id));
    const linked = dialoguesOf(db, [new TaskRepository(w.root, db).metadataWithHistory(w.project)]);
    assert.equal(linked.find(row => row.messageId === head.requestId)!.answer, 'Completed answer');
    assert.equal(linked.some(row => row.messageId === reply.requestId), false, 'a reply reference does not grant recipient targets');
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('coordinator_turns','task_claims')").all(), []);
    assert.deepEqual(db.prepare('PRAGMA table_info(task_dialogues)').all().map(row => row.name).sort(), ['request_id', 'task_uuid']);
    const refusalColumns = db.prepare('PRAGMA table_info(coordinator_refusals)').all();
    assert.deepEqual(refusalColumns.map(row => row.name).sort(), ['code_only', 'problem_json', 'refused_at', 'request_id', 'task_uuid']);
    assert.equal(refusalColumns.find(row => row.name === 'problem_json')!.notnull, 0);
  });
});

test('real CLI writes after a joined input keep explicit Request ownership and receipts include source identity', async t => {
  const w = callerWorkspace(t), head = w.screenRun({ words: 'Create A', session: 'screen' });
  const joined = w.screenRun({ words: 'Create B', session: null, running: false });
  joinInput(w.root, head, joined);
  const url = await w.start(); await w.startScreenRun(url, head);
  const env = claudeConversation('screen');
  const args = (title: string, id: string, source?: string) => ['task', 'new', '--from-user', '--parent', w.project,
    '--title', title, '--op-id', id, ...(source === undefined ? [] : ['--source-request', source])];
  const a = await call(url, args('A', randomUUID()), env);
  const op = randomUUID(), bArgs = args('B', op, joined.requestId), b = await call(url, bArgs, env);
  const lastActor = async (id: string) => (await call(url, ['task', 'get', '--task', id, '--log', '1'])).task.log.at(-1).actor;
  assert.equal((await lastActor(a.task.id)).message, head.requestId);
  assert.equal((await lastActor(b.task.id)).message, joined.requestId);
  assert.deepEqual(await call(url, bArgs, env), b);
  await assert.rejects(call(url, args('B', op, head.requestId), env), { code: 'idempotency_conflict' });
  const invalid = await run(url, args('Invalid source', randomUUID(), randomUUID()), env);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'invalid_input');
  w.end(head);
  assert.deepEqual(await call(url, bArgs, env), b, 'an ended screen Run can replay its immutable receipt');
  const result = control(w.root, db => resultsOf(db, [head.requestId, joined.requestId]));
  assert.deepEqual(result.get(head.requestId)!.writes.map(write => write.task), [a.task.id]);
  assert.deepEqual(result.get(joined.requestId)!.writes.map(write => write.task), [b.task.id]);
  assert.deepEqual(result.get(joined.requestId)!.refused, []);
});

test('an ordinary screen reply with no write has an empty successful result', async t => {
  const w = callerWorkspace(t), head = w.screenRun({ words: 'Hello', session: 'screen' });
  const url = await w.start(); await w.startScreenRun(url, head); w.end(head, 'succeeded', 'Hello back');
  const message = new CoordinatorConversation(w.root).read().turns.find(turn => turn.id === head.requestId)!;
  assert.equal(message.answer, 'Hello back'); assert.deepEqual(message.result, { writes: [], refused: [] });
});

test('input validation and authorization failures on an existing Task preserve their actual Problem on the screen Request', async t => {
  const w = callerWorkspace(t), head = w.screenRun({ words: `Update ${w.project}`, session: 'screen' });
  const url = await w.start(); await w.startScreenRun(url, head);
  const headers = conversationHeaders('screen');
  const invalid = await post(url, '/api/task/update', { task: w.project, title: 'Missing expected hash' }, headers);
  assert.equal(invalid.status, 400);
  const opId = randomUUID();
  const forbidden = await post(url, '/api/task/report', { task: w.project, state: 'doing', expectedTaskHash: 'a'.repeat(64), opId },
    { ...headers, 'X-Alpacawork-Op-Id': opId });
  assert.equal(forbidden.status, 403);
  const results = control(w.root, db => resultsOf(db, [head.requestId])).get(head.requestId)!;
  assert.deepEqual(results.writes, []);
  assert.deepEqual(results.refused, [{ task: w.project, ...invalid.body.error }, { task: w.project, ...forbidden.body.error }]);
});

test('an HTTP operation waiting across a same-session Run change records its refusal only on the pinned Request', async t => {
  const w = callerWorkspace(t), head = w.screenRun({ words: 'Change title A', session: 'shared-screen' });
  const next = w.screenRun({ words: 'Change title B', session: 'shared-screen', running: false });
  const url = await w.start(); await w.startScreenRun(url, head);
  const shown = (await call(url, ['task', 'get', '--task', w.project])).task;
  let entered!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = ControlStore.prototype.writeOperationAsync, opId = randomUUID();
  t.mock.method(ControlStore.prototype, 'writeOperationAsync', async function (this: ControlStore,
    ...args: Parameters<ControlStore['writeOperationAsync']>) {
    if (args[0].opId === opId) { entered(); await gate; }
    return original.apply(this, args);
  });
  const pending = post(url, '/api/task/update', { task: w.project, title: 'Must not reach B', expectedTaskHash: shown.hash },
    { ...conversationHeaders('shared-screen'), 'X-Alpacawork-Op-Id': opId });
  await admitted;
  try {
    w.end(head);
    const runs = new RunStore(w.root, { busyTimeoutMs: 1000 });
    try { runs.write(tx => tx.update({ ...tx.runtimeGet(next.id)!, state: 'running', started_at: new Date().toISOString() })); }
    finally { runs.close(); }
  } finally { release(); }
  const rejected = await pending;
  assert.equal(rejected.status, 403); assert.equal(rejected.body.error.reason.kind, 'coordinator_run_changed');
  const results = control(w.root, db => resultsOf(db, [head.requestId, next.requestId]));
  assert.deepEqual(results.get(head.requestId), { writes: [], refused: [{ task: w.project, ...rejected.body.error }] });
  assert.deepEqual(results.get(next.requestId), { writes: [], refused: [] });
  assert.equal((await call(url, ['task', 'get', '--task', w.project])).task.hash, shown.hash);
});

test('a refused mutation and later async mutation keep their separate Request records', async t => {
  const { Problem } = await import('@alpacawork/core');
  const { ControlTaskCommands } = await import('@alpacawork/backend/test-dist/control/task-commands.js');
  const { setTimeout: delay } = await import('node:timers/promises');
  const w = callerWorkspace(t), head = w.screenRun({ words: 'Audit concurrency', session: 'audit-race' });
  const url = await w.start(); await w.startScreenRun(url, head);
  const a = (await call(url, ['task', 'new', '--parent', w.project, '--title', 'A'])).task;
  const b = (await call(url, ['task', 'new', '--parent', w.project, '--title', 'B'])).task;
  let aEntered!: () => void, releaseA!: () => void, bEntered!: () => void, releaseB!: () => void;
  const aStarted = new Promise<void>(resolve => { aEntered = resolve; }), gateA = new Promise<void>(resolve => { releaseA = resolve; });
  const bStarted = new Promise<void>(resolve => { bEntered = resolve; }), gateB = new Promise<void>(resolve => { releaseB = resolve; });
  const original = ControlTaskCommands.prototype.update;
  t.mock.method(ControlTaskCommands.prototype, 'update', async function (this: InstanceType<typeof ControlTaskCommands>,
    ...args: Parameters<InstanceType<typeof ControlTaskCommands>['update']>) {
    const input = args[0] as { title?: string };
    if (input.title === 'Reject A') { aEntered(); await gateA; throw new Problem('conflict', 'A refused', undefined,
      { reason: { kind: 'task_changed_reload_before_review' } }); }
    if (input.title === 'Block B') { bEntered(); await gateB; }
    return original.apply(this, args);
  });
  const headers = conversationHeaders('audit-race');
  const first = post(url, '/api/task/update', { task: a.id, title: 'Reject A', expectedTaskHash: a.hash }, headers);
  await aStarted;
  const second = post(url, '/api/task/update', { task: b.id, title: 'Block B', expectedTaskHash: b.hash }, headers);
  await delay(100); releaseA();
  try { await bStarted; assert.equal((await first).status, 409); }
  finally { releaseB(); }
  const rejected = await first, succeeded = await second;
  assert.equal(rejected.status, 409); assert.equal(succeeded.status, 200);
  const result = control(w.root, db => resultsOf(db, [head.requestId])).get(head.requestId)!;
  assert.deepEqual(result.refused, [{ task: a.id, ...rejected.body.error }]);
  assert.deepEqual(result.writes.map(write => write.task), [b.id]);
});


test('an admitted refusal survives quiesce and drained observes its durable Problem snapshot', async t => {
  const { Problem } = await import('@alpacawork/core');
  const { ControlTaskCommands } = await import('@alpacawork/backend/test-dist/control/task-commands.js');
  const { setTimeout: delay } = await import('node:timers/promises');
  const w = callerWorkspace(t), head = w.screenRun({ words: 'Audit during quiesce', session: 'audit-quiesce' });
  const url = await w.start(); await w.startScreenRun(url, head);
  const task = (await call(url, ['task', 'new', '--parent', w.project, '--title', 'Refused during drain'])).task;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(ControlTaskCommands.prototype, 'update', async () => {
    entered(); await gate; throw new Problem('conflict', 'Refused during drain', undefined,
      { reason: { kind: 'task_changed_reload_before_review' } });
  });
  const first = post(url, '/api/task/update', { task: task.id, title: 'Rejected', expectedTaskHash: task.hash },
    conversationHeaders('audit-quiesce'));
  await started;
  let drainedReturned = false, savedWhenDrained = 0;
  const draining = fetch(new URL('/api/runtime/quiesce', url), { method: 'POST' }).then(response => {
    drainedReturned = true;
    savedWhenDrained = control(w.root, db => resultsOf(db, [head.requestId])).get(head.requestId)!.refused.length;
    return response;
  });
  try { await delay(100); assert.equal(drainedReturned, false, 'drained must wait for the admitted operation and its audit'); }
  finally { release(); }
  const rejected = await first, drained = await draining;
  assert.equal(rejected.status, 409); assert.equal(drained.status, 200);
  assert.equal((await drained.json()).state, 'drained');
  assert.equal(savedWhenDrained, 1, 'the original admission includes durable refusal recording');
  const result = control(w.root, db => resultsOf(db, [head.requestId])).get(head.requestId)!;
  assert.deepEqual(result, { writes: [], refused: [{ task: task.id, ...rejected.body.error }] });
});

test('an already delivered reply reference remains readable while another input referencing it has an uncertain receipt', async t => {
  const w = callerWorkspace(t), source = w.screenRun({ words: 'Original source', session: 'original-source' });
  w.end(source, 'succeeded', 'Original full answer');
  const head = w.screenRun({ words: 'A references the original source', session: 'reply-head', replyTo: source.requestId });
  const pending = w.screenRun({ words: 'B references the same source', session: null, replyTo: source.requestId, running: false });
  const inputId = randomUUID();
  control(w.root, db => db.prepare(`INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial,receipt_json)
    SELECT ?,attempt_id,?,?,'uncertain',0,'{}' FROM run_attempts WHERE run_no=?`)
    .run(inputId, Number(pending.id.slice(1)), 'a'.repeat(64), Number(head.id.slice(1))));
  const url = await w.start(); await w.startScreenRun(url, head);
  const reply = await call(url, ['coordinator', 'reply', 'get', '--message', source.requestId], claudeConversation('reply-head'));
  assert.equal(reply.text, 'Original full answer', 'pending B cannot revoke the already delivered reference of A');
  control(w.root, db => {
    assert.equal(db.prepare('SELECT state FROM run_inputs WHERE input_id=?').get(inputId)!.state, 'uncertain',
      'reading through A does not invent a delivery receipt for B');
    assert.deepEqual(deliveredMessages(db, head.id), [head.requestId]);
  });
});

test('message result lookup uses indexes for both disjoint canonical authors',async t=>{
  const w=callerWorkspace(t),screen=w.screenRun({words:'Index result source',session:'indexed'});
  const original=DatabaseSync.prototype.prepare,plans:string[][]=[];
  t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
    if(sql.startsWith('SELECT id,request_id,task FROM (')){
      const explain=original.call(this,'EXPLAIN QUERY PLAN '+sql);plans.push(explain.all(JSON.stringify([screen.requestId]),JSON.stringify([screen.requestId])).map(row=>String(row.detail)));
    }
    return original.call(this,sql);
  });
  const result=control(w.root,db=>resultsOf(db,[screen.requestId]));assert.deepEqual(result.get(screen.requestId),{writes:[],refused:[]});
  assert.equal(plans.length,1);const plan=plans[0]!.join('\n');
  assert.match(plan,/SEARCH l USING INDEX task_log_message/);assert.match(plan,/SEARCH q USING INDEX requests_message/);
  assert.doesNotMatch(plan,/SCAN [lq](?:\s|$)/m);
});

test('an independent quoted Task note retains its dialogue, apart from a Request author quote',t=>{
  const w=callerWorkspace(t);
  control(w.root,db=>{
    const task=db.prepare('SELECT id FROM tasks WHERE external_id=?').get(w.project)!;
    const ordinal=db.prepare('SELECT coalesce(max(ordinal),-1)+1 n FROM task_log WHERE task_id=?').get(task.id!)!.n;
    const entry={id:'independent-external-quote',kind:'reported',at:new Date().toISOString(),title:'Separate legitimate note',description:null,
      fromState:null,toState:null,actor:{kind:'main',provider:'codex',conversationId:'outside',quote:'Independent quoted words'}};
    db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)').run(entry.id,task.id!,ordinal!,JSON.stringify(entry));
    assert.deepEqual(dialoguesOf(db,[new TaskRepository(w.root, db).metadataWithHistory(w.project)]).find(row=>row.messageId===entry.id),
      {taskId:w.project,messageId:entry.id,at:entry.at,words:entry.actor.quote,answer:null});
  });
});
