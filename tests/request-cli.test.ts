import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { taskRequestInput } from '@alpacawork/contract/inputs';
import { assignResponsible, initializeControlFixture } from './helpers/control-fixture.ts';
import type { TestContext } from 'node:test';
import { evidenceTest as test, rememberEvidenceWorkspace } from './helpers/failure-workspace.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunStore } from '@alpacawork/runs';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { cliRun } from './helpers/http-cli.ts';

const human = { kind: 'human' } as const;

/** A Task with its responsible in the test project; the server starts when the test has set up what it serves. */
async function setup(t: TestContext, userRequested: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-request-cli-')));
  rememberEvidenceWorkspace(t,root);
  const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];
  t.after(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const writer = new FileWriter(root);
  // The public CLI may settle an already accepted Request on retry: never give this fixture a real agent profile.
  const fakeConfig = stringify({ agents: { "codex": fixtureAgentSetting('codex') } });
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(fakeConfig)); project = initializeControlFixture(root); }
  finally { writer.close(); }
  const created = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested,
    tasks: [{ title: 'Request' }] })).tasks[0];
  const owner = await assignResponsible(root, created, 'codex');
  const task = await new ControlTaskStore(root).get(created.id);
  return { root, task, owner, async start() {
    const server = await startServer(root, 0);
    servers.push(server);
    return server;
  } };
}

test('CLI task request reads a UTF-8 brief file and refuses a person\'s instruction to a member', async t => {
  const h = await setup(t, false), path = join(h.root, 'brief.txt');
  writeFileSync(path, 'First line\nSecond line\n');
  const people = new PlacementStore(h.root);
  const member = people.createAndPlace({ taskId: h.task.id, profileKey: 'codex', responsible: false }).placement;
  people.close();
  const server = await h.start();
  const result = await cliRun(server.url, ['task', 'request', '--task', h.task.id, '--instruction-file', path,
    '--op-id', randomUUID(), '--expected-task-hash', h.task.hash,
    '--expected-placement-revision', String(member.revision), '--agent', member.id]);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stderr).error.code, 'forbidden');
});

test('CLI task request returns the original instruction after review waiting and body edits', async t => {
  const h = await setup(t, true), commands = new ControlTaskCommands(h.root, { kind: 'human' });
  const operationId = randomUUID(), body = 'Original instruction';
  const first = await new TaskRequestService(h.root).request({ task: h.task.id, body, opId: operationId,
    expectedTaskHash: h.task.hash, expectedPlacementRevision: h.owner.revision }, human, human);
  assert.equal(first.outcome.kind, 'request_accepted');
  // Its Run reports done and ends: the Task the user asked for waits for the user's review.
  const runId = first.outcome.request.runId;
  const started = new RunStore(h.root, { busyTimeoutMs: 0 });
  try { started.write(tx => tx.update({ ...tx.get(runId)!, state: 'running', started_at: new Date().toISOString() })); }
  finally { started.close(); }
  const waiting = await new TaskReportService(h.root).report({ task: h.task.id, state: 'done', title: 'Ready for review', description: 'The result is ready for review.',
    opId: randomUUID(), expectedTaskHash: first.task.hash }, { kind: 'placement', placementId: h.owner.id },
  { kind: 'run', runId, placementId: h.owner.id, taskId: h.task.id, role: 'owner', responsible: true });
  const ended = new RunStore(h.root, { busyTimeoutMs: 0 });
  try { ended.write(tx => tx.finish({ ...tx.get(runId)!, state: 'succeeded', ended_at: new Date().toISOString() },
    { state: 'present', text: 'fixture reply' })); }
  finally { ended.close(); }
  assert.equal(waiting.task.state, 'waiting');
  // Finish the fixture's Task/Run reconciliation before serve can race it against a CLI read or edit.
  await new ReturnRouter(h.root).pass();
  const settled = await new ControlTaskStore(h.root).get(h.task.id);
  assert.equal(settled.meta.log.filter(entry => entry.id === `LEND${runId}`).length, 1);
  const server = await h.start();
  const path = join(h.root, 'instruction.txt'); writeFileSync(path, body);
  const invoke = (opId = operationId) => cliRun(server.url,
    ['task', 'request', '--task', h.task.id, '--instruction-file', path, '--op-id', opId,
      '--expected-task-hash', h.task.hash, '--expected-placement-revision', String(h.owner.revision)]);
  const checkReplay = async (current: typeof waiting.task) => {
    const result = await invoke();
    assert.equal(result.code, 0, result.stderr);
    const replay = JSON.parse(result.stdout);
    assert.deepEqual(replay.outcome, first.outcome);
    assert.equal(replay.task.body, first.task.body, 'idempotent replay returns the original receipt');
    const live = await cliRun(server.url, ['task', 'get', '--task', h.task.id, '--log', '100']);
    assert.equal(live.code, 0, live.stderr);
    const liveTask = JSON.parse(live.stdout).task as typeof waiting.task & { log: { id: string }[] };
    assert.equal(liveTask.body, current.body);
    assert.equal('log' in replay.task, false, 'a receipt carries no History');
    assert.equal(liveTask.log.filter(entry => entry.id === operationId).length, 1);
    return liveTask;
  };
  const afterWaitingReplay = await checkReplay(waiting.task);
  const edited = await commands.update({ id: h.task.id, values: { notes: 'Later notes' },
    expectedTaskHash: afterWaitingReplay.hash });
  await checkReplay(edited.task);
  // A stale instruction is refused by the same version check in every Task state.
  const fresh = await invoke(randomUUID());
  assert.equal(fresh.code, 2);
  assert.equal(JSON.parse(fresh.stderr).error.code, 'conflict');
  writeFileSync(path, 'Different instruction');
  const changed = await invoke();
  assert.equal(changed.code, 2);
  assert.equal(JSON.parse(changed.stderr).error.code, 'idempotency_conflict');
});

 test('the adopted task request input keeps annotations out of its public instruction contract', () => {
  const base = { task: 'T1', instruction: 'Sent body', expectedTaskHash: 'a'.repeat(64), expectedPlacementRevision: 1 };
  assert.equal(taskRequestInput.safeParse(base).success,true);
  assert.equal(taskRequestInput.safeParse({ ...base, title: 'History', description: 'Summary' }).success, false);
  assert.equal(taskRequestInput.safeParse({ ...base, description: 'Summary' }).success, false);
  for (const note of [{ title: 'Ignored' }, { description: 'Ignored' }])
    assert.equal(taskRequestInput.safeParse({ task: 'T1', instruction: 'Answer', answers: 'question',
      expectedTaskHash: base.expectedTaskHash, ...note }).success, false);
 });


test('formal CLI retries a lost committed HTTP reply with identical bytes and one canonical Request reference', async t => {
 const h=await setup(t,false),server=await h.start(),operationId=randomUUID(),brief=join(h.root,'lost-brief.txt');
 writeFileSync(brief,'Original UTF-8 instruction\n日本語');
 const received:{body:string;operation:string|undefined;status:number;response:string}[]=[];
 const proxy=createServer(async(req,res)=>{
  try{
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString();
   const upstream=await fetch(new URL(req.url!,server.url),{method:req.method,headers:req.headers as Record<string,string>,...(body?{body}:{})});
   const response=await upstream.text();
   if(req.url==='/api/commands/task/request'){
    received.push({body,operation:req.headers['x-alpacawork-op-id'] as string|undefined,status:upstream.status,response});
    if(received.length===1){req.socket.destroy();return;}
   }
   res.writeHead(upstream.status,{'content-type':'application/json'});res.end(response);
  }catch(error){res.destroy(error as Error);}
 });
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 const stop=()=>{proxy.closeAllConnections();proxy.close();},timer=setTimeout(stop,60000);t.after(()=>{clearTimeout(timer);stop();});
 const address=proxy.address();assert.ok(address&&typeof address==='object');
 const reply=await cliRun(`http://127.0.0.1:${address.port}`,['task','request','--task',h.task.id,'--instruction-file',brief,'--op-id',operationId,
  '--expected-task-hash',h.task.hash,'--expected-placement-revision',String(h.owner.revision)]);
 assert.equal(reply.code,0,reply.stderr);assert.equal(received.length,2);assert.deepEqual(received[1],received[0]);assert.equal(received[0]!.status,200);
 assert.deepEqual(JSON.parse(reply.stdout),JSON.parse(received[0]!.response));
 const db=new DatabaseSync(controlDatabasePath(h.root),{readOnly:true});try{
  assert.equal(db.prepare('SELECT count(*) n FROM requests WHERE id=?').get(operationId)!.n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM task_log WHERE request_id=?').get(operationId)!.n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM runs WHERE request_id=?').get(operationId)!.n,1);
  const saved=db.prepare('SELECT purpose,body,about_run_id FROM requests WHERE id=?').get(operationId)!;
  assert.equal(saved.purpose,'instruction');assert.equal(saved.about_run_id,null);assert.equal(saved.body,'Original UTF-8 instruction\n日本語');
 }finally{db.close();}
});

test('result choices require exactly one cause for rework and keep the notes with their own reasons', () => {
  const base = { task: 'T1', instruction: 'Revise the result', expectedTaskHash: '0'.repeat(64), expectedPlacementRevision: 1 };
  for (const [options, valid] of [
    [{ taken: 'fix' }, false],
    [{ taken: 'redo', cause: 'shortfall', aspects: ['behavior', 'scope'] }, true],
    [{ taken: 'dropped', cause: 'other' }, false],
    [{ taken: 'dropped', cause: 'other', causeNote: 'The work is no longer needed', placedAs: 'exception', placedNote: 'Use the model already in context' }, true],
    [{ taken: 'fix', cause: ['misread', 'shortfall'] }, false],
    [{ taken: 'adopted', cause: 'shortfall' }, false],
    [{ taken: 'adopted', aspects: ['scope'] }, false],
    [{ taken: 'addition', causeNote: 'An unrelated note' }, false],
    [{ taken: 'new_request', placedAs: 'exception' }, false],
    [{ taken: 'new_request', placedAs: 'policy', placedNote: 'An unrelated note' }, false],
  ] as const) assert.equal(taskRequestInput.safeParse({ ...base, ...options }).success, valid, JSON.stringify(options));
});
