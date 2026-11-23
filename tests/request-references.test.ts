import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { historyCursor, startsEstimateRound } from '@alpacawork/contract';
import { taskHistoryWindowSchema, type HistoryWindowRequest } from '@alpacawork/contract/control';
import { TaskTransition } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { requesterSeat, returnFacts } from '@alpacawork/backend/test-dist/control/return-rules.js';
import { evidenceTest as test, rememberEvidenceWorkspace } from './helpers/failure-workspace.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { automaticIndex, RunStore } from '@alpacawork/runs';
import { controlDatabasePath } from '@alpacawork/db';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { readControlTree } from './helpers/control-tree.ts';
import { setupReview } from './review.fixture.ts';
import { commandFetch } from './helpers/command-fetch.ts';
import { cliRun } from './helpers/http-cli.ts';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { questionFact } from './helpers/coordinator-question-fixture.ts';
const human = { kind: 'human' } as const;
/** Read the current window contract; a rejected query is never mistaken for an empty History. */
async function historyWindow(server: string, task: string, window: HistoryWindowRequest) {
  const url = new URL('/api/task/history', server);
  url.searchParams.set('task', task);
  for (const [key, value] of Object.entries(window)) url.searchParams.set(key, String(value));
  const response = await fetch(url), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return taskHistoryWindowSchema.parse(body);
}
const inputFor = (h: Awaited<ReturnType<typeof setupReview>>) => ({ task: h.task.id, body: 'One send-back',
  newConversation: true, opId: randomUUID(), expectedTaskHash: h.expectedTaskHash,
  expectedPlacementRevision: h.expectedPlacementRevision });

test('new admission stores identity, position and independent note;  DB rejects missing, foreign, duplicate, rewritten and copied admissions', async t => {
  const h = await setupReview(t, { userRequested: false }), input = inputFor(h), service = new TaskRequestService(h.root);
  const accepted = await service.request(input, human, human);
  const before = await readControlTree(h.root);
  assert.deepEqual(await service.request(input, human, human), accepted);
  await assert.rejects(service.request({ ...input, body: 'Other words' }, human, human), { code: 'idempotency_conflict' });
  assert.deepEqual(await readControlTree(h.root), before);
  const db = new DatabaseSync(controlDatabasePath(h.root)); db.exec('PRAGMA foreign_keys=ON');
  try {
    const slot = db.prepare('SELECT * FROM task_log WHERE id=?').get(input.opId)!;
    assert.equal(slot.entry, null); assert.equal(slot.request_id, input.opId);
    assert.equal(slot.kind, null); assert.equal(slot.at, null);
    const q = db.prepare('SELECT * FROM requests WHERE id=?').get(input.opId)!;
    const event = (await new ControlTaskStore(h.root).get(h.task.id)).meta.log.find(entry => entry.id === input.opId)!;
    assert.deepEqual(event, { id: input.opId, kind: 'request_accepted', at: String(q.submitted_at), title: null,
      description: null, actor: human, fromState: 'done', toState: null, startsEstimateRound: true });
    const other = String(db.prepare('SELECT id FROM tasks WHERE external_id=?').get(h.project)!.id);
    const insert = db.prepare('INSERT INTO task_log(id,task_id,ordinal,request_id) VALUES (?,?,?,?)');
    assert.throws(() => insert.run('missing', slot.task_id, 1000, 'missing'));
    assert.throws(() => insert.run(input.opId, other, 1000, input.opId), /same Task/);
    assert.throws(() => insert.run(input.opId, slot.task_id, 1000, input.opId), /UNIQUE/);
    assert.throws(() => insert.run('other-id', slot.task_id, 1000, input.opId), /CHECK|UNIQUE/);
    assert.throws(() => db.prepare('UPDATE task_log SET request_id=NULL WHERE id=?').run(input.opId), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM task_log WHERE id=?').run(input.opId), /immutable/);
    assert.throws(() => db.prepare('UPDATE requests SET author=? WHERE id=?').run('{"kind":"placement","placementId":"other"}', input.opId), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM requests WHERE id=?').run(input.opId), /FOREIGN KEY/);
    assert.throws(() => db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)')
      .run('copy', slot.task_id, 1000, JSON.stringify({ ...event, id: 'copy' })), /CHECK/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

for (const table of ['requests','runs','task_log'] as const) test(`failure in ${table} rolls back the entire admission and the same operation retries once`, async t => {
  const h = await setupReview(t, { userRequested: true }), input = inputFor(h), service = new TaskRequestService(h.root);
  const before = await readControlTree(h.root), db = new DatabaseSync(controlDatabasePath(h.root));
  try {
    db.exec(`CREATE TRIGGER fail_reference BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'reference fault'); END`);
    await assert.rejects(service.request(input, human, human));
    assert.deepEqual(await readControlTree(h.root), before);
    db.exec('DROP TRIGGER fail_reference');
    const accepted = await service.request(input, human, human);
    assert.deepEqual(await service.request(input, human, human), accepted);
    assert.equal(db.prepare('SELECT count(*) n FROM task_log WHERE request_id=?').get(input.opId)!.n, 1);
  } finally { db.close(); }
});

test('HTTP receipt fault rolls back the Request, Run, reference and Task revision; replay keeps the original response', async t => {
  const h = await setupReview(t, { userRequested: true }), input = inputFor(h);
  writeFileSync(`${h.root}/config.yaml`, stringify({ agents: { "claude": fixtureAgentSetting('claude') } }));
  const server = await h.start(), db = new DatabaseSync(controlDatabasePath(h.root));
  console.log('LEASE', JSON.stringify({ pid: process.pid, root: h.root, url: server.url, deadline: new Date(Date.now() + 60000).toISOString() }));
  const timer = setTimeout(() => void server.close(), 60000);
  const post = async ({ body, ...input }: typeof input) => {
    const r = await commandFetch(new URL('/api/task/request', server.url), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, instruction: body }) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const before = await readControlTree(h.root);
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON cli_operations BEGIN SELECT RAISE(ABORT,'receipt fault'); END");
    assert.ok((await post(input)).status >= 400);
    assert.deepEqual(await readControlTree(h.root), before);
    assert.equal(db.prepare('SELECT count(*) n FROM cli_operations WHERE op_id=?').get(input.opId)!.n, 0);
    db.exec('DROP TRIGGER fail_receipt');
    const accepted = await post(input); assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    await h.commands.update({ id: h.task.id, values: { notes: 'After frozen response' },
      expectedTaskHash: (await new ControlTaskStore(h.root).get(h.task.id)).hash });
    assert.deepEqual(await post(input), accepted);
    assert.equal((await post({ ...input, body: 'Different input' })).status, 409);
    // Unknown fields are rejected at the shared entry before reaching the operation journal.
    assert.equal((await post({ ...input, title: 'Not a public instruction field' } as any)).status, 400);
    assert.equal((await post({ ...input, description: 'Changed summary' } as any)).status, 400);
    const history = await historyWindow(server.url, h.task.id, { mode: 'latest' });
    assert.deepEqual(history.events.filter((event: { id: string }) => event.id === input.opId)
      .map((event: { kind: string; summary: string; note?: object }) => [event.kind, event.summary, event.note]),
      [['request', input.body, undefined]]);
  } finally { clearTimeout(timer); db.close(); await server.close(); }
});

test('separate real admissions at exactly the same clock retain two Requests, Runs and references, with retry unchanged',async t=>{
 const h=await setupReview(t,{userRequested:false}),service=new TaskRequestService(h.root),person={kind:'human'} as const;
 const RealDate=Date;const instant='2026-10-21T05:00:00.123Z';
 const accepted=[];try{
  globalThis.Date=class extends RealDate{constructor(...args:any[]){super(...(args.length?args:[instant]) as [any]);}static now(){return RealDate.parse(instant);}} as DateConstructor;
  for(const id of ['same-clock-first','same-clock-second']){const input={task:h.task.id,body:'Same words',opId:id,expectedTaskHash:(await new ControlTaskStore(h.root).get(h.task.id)).hash,expectedPlacementRevision:h.placement.revision};const response=await service.request(input,person,person);const before=await new ControlTaskStore(h.root).get(h.task.id);assert.deepEqual(await service.request(input,person,person),response);assert.deepEqual(await new ControlTaskStore(h.root).get(h.task.id),before);accepted.push(response);}
 }finally{globalThis.Date=RealDate;}
 const db=new DatabaseSync(controlDatabasePath(h.root));try{const rows=db.prepare("SELECT q.id,q.submitted_at,r.id AS run,l.ordinal,l.entry,l.request_id FROM requests q JOIN runs r ON r.request_id=q.id JOIN task_log l ON l.request_id=q.id WHERE q.id LIKE 'same-clock-%' ORDER BY l.ordinal").all();assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.run)).size,2);assert.ok(rows.every(r=>r.submitted_at===instant&&r.entry===null));}finally{db.close();}
 const store=new RunStore(h.root,{busyTimeoutMs:1000});try{const runs=store.read();store.write(tx=>{for(const run of runs)if(run.state==='queued')tx.finish({...run,state:'cancelled',reason:'stopped',ended_at:instant},{state:'missing',text:null});});}finally{store.close();}
 const app=await h.start();const timer=setTimeout(()=>void app.close(),60000);try{
  const latest = await historyWindow(app.url, h.task.id, { mode: 'latest' });
  assert.ok(latest.events.length);
  const events = [latest.events[0]!];
  let before = historyCursor(events[0]!);
  // Walk one event at a time to keep checking cursor ties at the same clock.
  while (true) {
    const page = await historyWindow(app.url, h.task.id, { mode: 'older', before, limit: 1 });
    events.push(...page.events);
    if (!page.hasOlder) break;
    assert.ok(page.oldestKey);
    before = page.oldestKey;
  }
  const focal=events.filter(e=>e.id.startsWith('same-clock-'));assert.equal(focal.length,2);assert.ok(focal.every(e=>e.kind==='request'&&e.summary==='Same words'&&e.at===instant));
  const delta = await historyWindow(app.url, h.task.id, { mode: 'since', since: historyCursor(focal.at(-1)!), keep: 80 });
  assert.equal(delta.events.filter(e=>e.id.startsWith('same-clock-')).length,2);
 }finally{clearTimeout(timer);await app.close();}
});

test('Task note and body have separate owners, atomic replay identity and unmodified delivered prompt', async t => {
  const h = await setupReview(t, { userRequested: false }), requests = new RequestService(h.root);
  const service={request:(input:ReturnType<typeof inputFor> & {title?:string;description?:string},_actor:unknown,_caller:unknown)=>requests.request({taskId:input.task,requestId:input.opId,expectedTaskHash:input.expectedTaskHash,expectedPlacementRevision:input.expectedPlacementRevision,mode:'new',body:input.body,title:input.title,description:input.description},{purpose:'instruction',actor:human})};
  const input = { ...inputFor(h), title: 'History annotation', description: 'Only for readers of the Task history' };
  const accepted = await service.request(input, human, human);
  const db = new DatabaseSync(controlDatabasePath(h.root));
  try {
    const row = db.prepare('SELECT entry,note_title,note_description FROM task_log WHERE request_id=?').get(input.opId)!;
    assert.deepEqual({ ...row }, { entry: null, note_title: input.title, note_description: input.description });
    assert.deepEqual(await service.request(input, human, human), accepted);
    for (const changed of [{ title: 'Other title' }, { description: 'Other description' }])
      await assert.rejects(service.request({ ...input, ...changed }, human, human), { code: 'idempotency_conflict' });
    const read = new ControlTaskStore(h.root);
    const note = (await read.get(h.task.id)).meta.log.find(log => log.id === input.opId)!;
    assert.equal(note.kind, 'request_accepted'); assert.equal(note.runId, undefined);
    assert.equal(note.title, input.title); assert.equal(note.description, input.description);
    const store = new RunStore(h.root, { busyTimeoutMs: 1000 }, true);
    try {
      const request = store.getRequest(input.opId)!;
      assert.equal(request.purpose, 'instruction'); assert.equal(request.body, input.body);
      const prompt = store.getText(request.runId!)!.prompt!;
      assert.ok(prompt.includes(input.body));
      assert.ok(!prompt.includes(input.title)); assert.ok(!prompt.includes(input.description));
    } finally { store.close(); }
    const taskUuid = String(db.prepare('SELECT id FROM tasks WHERE external_id=?').get(h.task.id)!.id);
    const ordinary = { id: 'bad-note', kind: 'reported', at: new Date().toISOString(), actor: human,
      title: 'A comment', description: null, fromState: null, toState: null };
    assert.throws(() => db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry,note_title) VALUES (?,?,?,?,?)')
      .run(ordinary.id, taskUuid, 10000, JSON.stringify(ordinary), 'Leaked note'), /CHECK/);
    assert.throws(() => db.prepare('INSERT INTO task_log(id,task_id,ordinal,request_id,note_description) VALUES (?,?,?,?,?)')
      .run('bad-ref', taskUuid, 10000, 'bad-ref', 'No title'), /CHECK|same Task/);
  } finally { db.close(); }
});

test('stored placement review keeps review purpose, caller and requester cycle independently of new-review authorization', async t => {
  const h = await setupReview(t, { userRequested: true });
  const store = new RunStore(h.root, { busyTimeoutMs:1000 });
  try {
    const head=store.get(h.reviewRun)!,author={kind:'placement' as const,placementId:head.placementId};
    const id='historical-placement-review';
    store.write(tx=>{
      const db=store.connection;
      let cycle=db.prepare('SELECT id FROM wait_cycles WHERE task_id=? AND closed_at IS NULL').get(h.task.id)?.id;
      if(!cycle){cycle='cycle-placement-review';db.prepare('INSERT INTO wait_cycles(id,task_id,opened_at) VALUES (?,?,?)').run(cycle,h.task.id,new Date().toISOString());}
      tx.insertRequest({id,taskId:h.task.id,placementId:head.placementId,placementRevision:h.expectedPlacementRevision,
        taskHash:h.expectedTaskHash,headRunId:head.id,aboutRunId:head.id,waitCycleId:String(cycle),mode:'continue',body:'Historical review body',
        purpose:'review_send_back',author,submittedAt:new Date().toISOString(),deliveryState:'queued'});
      tx.create({...head,requestId:id,caller:{run:head.id},resumes:head.id,continues:false},'Frozen historical input');
      new TaskTransition().appendRequestReference({store,runs:tx},h.task.id,id,{});
    });
    const request=store.getRequest(id)!,record=(await new ControlTaskStore(h.root).get(h.task.id)).meta.log.find(e=>e.id===id)!;
    assert.equal(record.kind,'review_sent_back');assert.equal(record.runId,h.reviewRun);assert.deepEqual(record.actor,author);
    assert.equal(requesterSeat(request,returnFacts([],store.read())),h.task.id);
    assert.equal(automaticIndex([request]).count(head.placementId,[h.task.id]),1);
    assert.equal(startsEstimateRound(request,{role:'owner'}),true);
    assert.ok(request.waitCycleId);
  } finally { store.close(); }
});

test('CLI instructions return a submitted result for revision once, while question replies and member work remain instructions', async t => {
  const h = await setupReview(t, { userRequested: true });
  writeFileSync(`${h.root}/config.yaml`, stringify({ agents: { claude: fixtureAgentSetting('claude') } }));
  const server = await h.start(), brief = `${h.root}/revision.txt`, opId = randomUUID();
  writeFileSync(brief, 'Please revise the result');
  const invoke = () => cliRun(server.url, ['task', 'request', '--task', h.task.id, '--instruction-file', brief,
    '--op-id', opId, '--new-conversation', '--expected-task-hash', h.expectedTaskHash,
    '--expected-placement-revision', String(h.expectedPlacementRevision)]);
  const accepted = await invoke();
  assert.equal(accepted.code, 0, accepted.stderr);
  const db = new DatabaseSync(controlDatabasePath(h.root), { readOnly: true });
  try {
    const row = db.prepare('SELECT purpose,about_run_id FROM requests WHERE id=?').get(opId)!;
    assert.deepEqual({ ...row }, { purpose: 'review_send_back', about_run_id: h.reviewRun });
    const task = await new ControlTaskStore(h.root).get(h.task.id), event = task.meta.log.find(entry => entry.id === opId)!;
    assert.equal(event.kind, 'review_sent_back');
    assert.equal(event.runId, h.reviewRun);
    await h.commands.update({ id: h.task.id, values: { notes: 'Changed after admission' }, expectedTaskHash: task.hash });
    assert.deepEqual(await invoke(), accepted, 'replay keeps the admitted review after its Task state and hash change');
    const replay = await new TaskRequestService(h.root).request({ task: h.task.id, opId, body: 'Please revise the result',
      newConversation: true, expectedTaskHash: h.expectedTaskHash,
      expectedPlacementRevision: h.expectedPlacementRevision }, human, human);
    assert.deepEqual(replay.outcome, JSON.parse(accepted.stdout).outcome,
      'admission replay also preserves the classified review without an HTTP receipt cache');
    assert.equal(db.prepare('SELECT count(*) n FROM task_log WHERE request_id=?').get(opId)!.n, 1);
  } finally { db.close(); }

  for (const variant of ['question', 'member', 'placement'] as const) {
    const other = await setupReview(t, { userRequested: true });
    const placements = new PlacementStore(other.root);
    let target = other.placement;
    try { if (variant === 'member') target = placements.createAndPlace({ taskId: other.task.id,
      profileKey: 'claude', responsible: false }).placement; }
    finally { placements.close(); }
    const requestId = randomUUID();
    if (variant === 'question') {
      questionFact(other.root, other.task.id, 'closed-question');
      questionFact(other.root, other.task.id, 'withdraw-question', { closes: 'closed-question' });
      await new TaskRequestService(other.root).request({ task: other.task.id, opId: requestId,
        answers: 'closed-question', body: 'A later answer' }, human, human);
    } else await new RequestService(other.root).request({ taskId: other.task.id,
      targetPlacementId: target.id, requestId, expectedTaskHash: (await new ControlTaskStore(other.root).get(other.task.id)).hash,
      expectedPlacementRevision: target.revision, mode: 'new', body: 'More work' }, variant === 'placement'
      ? { purpose: 'instruction', actor: { kind: 'placement', placementId: other.placement.id }, actorRunId: other.reviewRun }
      : { purpose: 'instruction', actor: human });
    const store = new RunStore(other.root, { busyTimeoutMs: 1000 }, true);
    try {
      assert.equal(store.getRequest(requestId)!.purpose, 'instruction', variant);
      assert.equal(store.getRequest(requestId)!.aboutRunId, null, variant);
    } finally { store.close(); }
  }
});
