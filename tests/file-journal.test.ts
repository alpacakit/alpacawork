import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { ControlStore } from '@alpacawork/db';
import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { FileJournal, fileDigest } from '@alpacawork/backend/test-dist/control/file-journal.js';
import { taskFileRoute } from '@alpacawork/contract/task-file-route';

/** A new workspace (its root project P1) with one Task below the root project, whose files the test writes. */
async function fixture(run: (root: string, task: string) => void | Promise<void>) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'alpacawork-file-journal-'));
  try {
    await initializeWorkspace(root);
    const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: 'P1', userRequested: null,
      tasks: [{ title: 'Files' }] })).tasks[0].id;
    await run(root, task);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
/** Each Task keeps its files in tasks/<T>. */
const folderOf = (root: string, task: string) => join(root, 'tasks', task);

const receipt = <T>(result: ReturnType<FileJournal['putTaskFile']>) => {
  assert.equal(result.state, 'published');
  if (result.state !== 'published') throw new Error('not published');
  return result;
};
/**
 * A person's grant to write the Task's files, as server.ts asks authorize('file.write') for it where the write is
 * reserved; the journal checks its Task.
 */
const grant = (task: string) => () => ({ actor: { kind: 'human' as const }, task });

test('Task file bytes, digest, receipt and replay are one durable result', () => fixture((root, task) => {
  const journal = new FileJournal(root), opId = randomUUID(), bytes = Buffer.from([0, 255, 13, 10, 1]);
  const first = receipt(journal.putTaskFile({ task, name: 'nested/blob.bin', opId, bytes, result: { path: 'nested/blob.bin' },
    grant: grant(task) }));
  assert.equal(first.replayed, false);
  assert.deepEqual(journal.readTaskFile(task, 'nested/blob.bin'), bytes);
  assert.deepEqual(readFileSync(join(folderOf(root, task), 'nested/blob.bin')), bytes);
  assert.deepEqual(receipt(journal.putTaskFile({ task, name: 'nested/blob.bin', opId, bytes,
    result: { path: 'ignored on replay' }, grant: grant(task) })).body, first.body);
  assert.equal(journal.operationGet(opId).state, 'committed');
  assert.throws(() => journal.putTaskFile({ task, name: 'nested/blob.bin', opId,
    bytes: Buffer.from('different'), result: {}, grant: grant(task) }), { code: 'idempotency_conflict' });
  const store = new ControlStore(root);
  try {
    const row = store.read(db => db.prepare('SELECT * FROM file_operations WHERE op_id=?').get(opId)!);
    assert.equal(row.new_digest, fileDigest(bytes));
    assert.equal(row.state, 'published');
    assert.equal(store.read(db => db.prepare('SELECT count(*) AS n FROM file_path_reservations').get()!.n), 0);
    assert.equal(store.read(db => db.prepare('SELECT count(*) AS n FROM cli_operations WHERE op_id=?').get(opId)!.n), 1);
  } finally { store.close(); }
}));

test('a new write is authorized in the transaction that reserves it; a saved one is answered without asking again', () => fixture((root, task) => {
  const journal = new FileJournal(root), bytes = Buffer.from('reserved'), opId = randomUUID();
  let asked = 0;
  const asking = (refuse: boolean) => (db: { isTransaction: boolean }) => {
    asked++;
    assert.equal(db.isTransaction, true, 'asked on the reservation\'s own transaction');
    if (refuse) throw Object.assign(new Error('Run is not a current placement'), { code: 'forbidden' });
    return { actor: { kind: 'human' as const }, task };
  };
  assert.throws(() => journal.putTaskFile({ task, name: 'r.txt', opId, bytes, result: {}, grant: asking(true) }),
    { code: 'forbidden' });
  assert.deepEqual(journal.operationGet(opId), { state: 'not_found' });
  assert.equal(existsSync(join(folderOf(root, task), 'r.txt')), false);
  receipt(journal.putTaskFile({ task, name: 'r.txt', opId, bytes, result: { saved: true }, grant: asking(false) }));
  asked = 0;
  assert.equal(receipt(journal.putTaskFile({ task, name: 'r.txt', opId, bytes, result: {}, grant: asking(true) })).replayed, true);
  assert.equal(asked, 0);
}));

test('a file write goes only by a grant for its own Task, and a refused one leaves nothing', () => fixture(async (root, task) => {
  const { saveTaskAttachment, removeTaskAttachment, moveTaskAttachments } =
    await import('@alpacawork/backend/test-dist/control/task-files.js');
  const other = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: 'P1', userRequested: null,
    tasks: [{ title: 'Other' }] })).tasks[0].id;
  const journal = new FileJournal(root), bytes = Buffer.from('granted');
  // authorize grants a write for one Task (AuthorizedWriter); the journal writes no other Task's files by it.
  const refusedId = randomUUID();
  assert.throws(() => journal.putTaskFile({ task, name: 'granted.txt', opId: refusedId, bytes, result: {}, grant: grant(other) }),
    { code: 'forbidden' });
  assert.deepEqual(journal.operationGet(refusedId), { state: 'not_found' });
  assert.equal(existsSync(join(folderOf(root, task), 'granted.txt')), false);
  await assert.rejects(saveTaskAttachment(root, task, 'draft1', 'a.txt', bytes, randomUUID(), grant(other)), { code: 'forbidden' });
  // The grant for the Task writes, whoever it was decided for: a person, or a Run of its current placement.
  receipt(journal.putTaskFile({ task, name: 'granted.txt', opId: randomUUID(), bytes, result: {}, grant: grant(task) }));
  const run = () => ({ actor: { kind: 'placement' as const, placementId: 'P1' }, task });
  receipt(journal.putTaskFile({ task, name: 'by-run.txt', opId: randomUUID(), bytes, result: {}, grant: run }));
  await saveTaskAttachment(root, task, 'draft1', 'a.txt', bytes, randomUUID(), run);
  assert.throws(() => journal.deleteTaskFile({ task, name: 'granted.txt', opId: randomUUID(), expectedDigest: fileDigest(bytes),
    result: {}, grant: grant(other) }), { code: 'forbidden' });
  await assert.rejects(removeTaskAttachment(root, task, 'draft1', 'a.txt', randomUUID(), grant(other)), { code: 'forbidden' });
  await assert.rejects(moveTaskAttachments(root, task, 'draft1', 'draft2', randomUUID(), grant(other)), { code: 'forbidden' });
  assert.deepEqual(journal.readTaskFile(task, 'granted.txt'), bytes);
  assert.deepEqual(journal.readTaskFile(task, 'attachments/draft1/a.txt'), bytes);
  assert.equal(existsSync(join(folderOf(root, task), 'attachments/draft2')), false);
}));

test('reservation blocks same path, parent folder and read until recovery', () => fixture((root, task) => {
  const opId=randomUUID(), bytes=Buffer.from('first');
  assert.throws(() => new FileJournal(root, phase => { if (phase === 'reserved') throw new Error('crash'); })
    .putTaskFile({task,name:'attachments/R1/a.txt',opId,bytes,result:{ok:true},grant: grant(task)}), /crash/);
  const journal=new FileJournal(root);
  assert.deepEqual(journal.operationGet(opId),{state:'pending'});
  assert.throws(() => journal.putTaskFile({task,name:'attachments/R1/a.txt',opId:randomUUID(),bytes:Buffer.from('second'),result:{},grant: grant(task)}),
    {code:'conflict'});
  assert.throws(() => journal.readTaskFile(task,'attachments/R1/a.txt'),{code:'busy'});
  assert.deepEqual(journal.recover(),{published:1,needsReview:0});
  assert.deepEqual(journal.readTaskFile(task,'attachments/R1/a.txt'),bytes);
  assert.equal(receipt(journal.putTaskFile({task,name:'attachments/R1/a.txt',opId,bytes,result:{},grant: grant(task)})).replayed,true);
}));

test('renamed file is reconciled without publishing twice; ambiguous state retains reservation', () => fixture((root, task) => {
  const opId=randomUUID(), bytes=Buffer.from('renamed');
  assert.throws(() => new FileJournal(root, phase => { if (phase === 'renamed') throw new Error('crash'); })
    .putTaskFile({task,name:'x.txt',opId,bytes,result:{ok:true},grant: grant(task)}),/crash/);
  assert.equal(existsSync(join(folderOf(root,task),'x.txt')),true);
  const journal=new FileJournal(root);
  assert.deepEqual(journal.recover(),{published:1,needsReview:0});
  assert.deepEqual(journal.readTaskFile(task,'x.txt'),bytes);
  const deleteId=randomUUID();
  assert.throws(() => new FileJournal(root, phase => { if (phase === 'reserved') throw new Error('crash'); })
    .deleteTaskFile({task,name:'x.txt',opId:deleteId,expectedDigest:fileDigest(bytes),result:null,grant: grant(task)}),/crash/);
  assert.deepEqual(journal.recover(),{published:1,needsReview:0});
  assert.throws(()=>journal.readTaskFile(task,'x.txt'),{code:'not_found'});
  assert.equal(journal.operationGet(deleteId).state,'committed');
}));

test('config file publishes with one receipt', () => fixture((root) => {
  const journal=new FileJournal(root),old=readFileSync(join(root,'config.yaml'));
  const bytes=Buffer.from('agents: {}\nlimits: {parallel: 2}\n');
  const opId=randomUUID();
  const result=receipt(journal.putConfig({opId,bytes,expectedDigest:fileDigest(old),result:{hash:fileDigest(bytes)}}));
  assert.equal(result.body.hash,fileDigest(bytes));
  assert.deepEqual(readFileSync(join(root,'config.yaml')),bytes);
  const restarted=new FileJournal(root);
  assert.equal(restarted.operationGet(opId).state,'committed');
  assert.deepEqual(receipt(restarted.putConfig({opId,bytes,expectedDigest:fileDigest(old),
    result:{hash:'changed'}})).body,result.body);
  assert.throws(()=>restarted.putConfig({opId,bytes:Buffer.from('different'),expectedDigest:fileDigest(old),
    result:{}}),{code:'idempotency_conflict'});
}));

test('attachment upload dedupes, renames collisions, removes and moves through journal', () => fixture(async (root, task) => {
  const { saveTaskAttachment, removeTaskAttachment, moveTaskAttachments } =
    await import('@alpacawork/backend/test-dist/control/task-files.js');
  await assert.rejects(saveTaskAttachment(root,task,'draft1','a.txt',Buffer.from('one'),'',grant(task)),
    {code:'invalid_input'});
  await assert.rejects(removeTaskAttachment(root,task,'draft1','a.txt','',grant(task)),{code:'invalid_input'});
  await assert.rejects(moveTaskAttachments(root,task,'draft1','draft2','',grant(task)),{code:'invalid_input'});
  const uploadId=randomUUID();
  const first=await saveTaskAttachment(root,task,'draft1','a.txt',Buffer.from('one'),uploadId,grant(task));
  assert.equal(first.absolutePath,`/api/tasks/${task}/file?path=attachments%2Fdraft1%2Fa.txt`);
  assert.deepEqual(await saveTaskAttachment(root,task,'draft1','a.txt',Buffer.from('one'),uploadId,grant(task)),first);
  const dedupe=await saveTaskAttachment(root,task,'draft1','b.txt',Buffer.from('one'),randomUUID(),grant(task));
  assert.equal(dedupe.path,first.path);
  const second=await saveTaskAttachment(root,task,'draft1','a.txt',Buffer.from('two'),randomUUID(),grant(task));
  assert.equal(second.path,'attachments/draft1/a-2.txt');
  const removeId=randomUUID();
  await removeTaskAttachment(root,task,'draft1','a-2.txt',removeId,grant(task));
  await removeTaskAttachment(root,task,'draft1','a-2.txt',removeId,grant(task));
  const absentId=randomUUID();
  assert.deepEqual(await removeTaskAttachment(root,task,'draft1','missing.txt',absentId,grant(task)),{removed:true});
  assert.deepEqual(await removeTaskAttachment(root,task,'draft1','missing.txt',absentId,grant(task)),{removed:true});
  assert.equal(new FileJournal(root).operationGet(absentId).state,'committed');
  const moveId=randomUUID();
  const moved=await moveTaskAttachments(root,task,'draft1','draft2',moveId,grant(task));
  assert.deepEqual(await moveTaskAttachments(root,task,'draft1','draft2',moveId,grant(task)),moved);
  assert.deepEqual(moved.map(file=>file.path),['attachments/draft2/a.txt']);
  await assert.rejects(saveTaskAttachment(root,task,'draft1','new.txt',Buffer.from('new'),randomUUID(),grant(task)),
    {code:'attachment_request_replaced'});
  assert.deepEqual(new FileJournal(root).readTaskFile(task,'attachments/draft2/a.txt'),Buffer.from('one'));
}));

test('HTTP adapter receives exact bytes and requires caller authorization', () => fixture(async (root, task) => {
  const { Hono }=await import('../apps/backend/node_modules/hono/dist/index.js');
  const { installTaskFileRoutes,installAttachmentFileRoutes }=await import('@alpacawork/backend/test-dist/receiver/file-routes.js');
  const app=new Hono(); let calls=0;
  app.onError((error,c)=>c.json({error:error.message},400));
  installTaskFileRoutes(app,root,{authorizeRead:(_request,id)=>{assert.equal(id,task); calls+=1;},
    authorizeWrite:(_request,id)=>{assert.equal(id,task); calls+=2; return grant(id);},changed:()=>{}});
  installAttachmentFileRoutes(app,root,{authorizeRead:(_request,id)=>{assert.equal(id,task); calls+=1;},
    authorizeWrite:(_request,id)=>{assert.equal(id,task); calls+=2; return grant(id);},changed:()=>{}});
  const bytes=Buffer.from([0,255,1]);
  const url=`http://localhost/api/tasks/${task}/file?path=${encodeURIComponent('bytes.bin')}`;
  const response=await app.request(url,{method:'PUT',headers:{'X-Alpacawork-Op-Id':randomUUID(),
    'X-Alpacawork-Content-Digest':fileDigest(bytes)},body:bytes});
  assert.equal(response.status,200);
  const read=await app.request(url);
  assert.equal(read.status,200);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()),bytes);
  assert.equal(calls,3);
  const video=Buffer.from('0000ftypisom0123');
  receipt(new FileJournal(root).putTaskFile({task,name:'movie.mp4',opId:randomUUID(),bytes:video,result:{},grant: grant(task)}));
  const ranged=await app.request(`http://localhost/api/tasks/${task}/file?path=movie.mp4`,
    {headers:{Range:'bytes=4-7'}});
  assert.equal(ranged.status,206);
  assert.equal(ranged.headers.get('content-range'),`bytes 4-7/${video.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),video.subarray(4,8));
  const attachmentUrl=`http://localhost/api/tasks/${task}/attachments?requestId=draft1&name=a.txt`;
  const attachmentId=randomUUID();
  const upload=()=>app.request(attachmentUrl,{method:'POST',headers:{'X-Alpacawork-Op-Id':attachmentId},body:'attached'});
  const uploaded=await upload();
  assert.equal(uploaded.status,200);
  assert.deepEqual(await (await upload()).json(),await uploaded.json());
  assert.equal((await app.request(attachmentUrl,{method:'DELETE'})).status,400);
}));

test('unprovable recovery keeps needs_review and holds the path', () => fixture((root, task) => {
  const opId=randomUUID();
  assert.throws(()=>new FileJournal(root, phase=>{if(phase==='reserved') throw new Error('crash');})
    .putTaskFile({task,name:'uncertain.txt',opId,bytes:Buffer.from('expected'),result:{},grant: grant(task)}),/crash/);
  const store=new ControlStore(root);
  const stage=store.read(db=>String(db.prepare('SELECT stage_path FROM file_operations WHERE op_id=?').get(opId)!.stage_path));
  store.close();
  rmSync(join(root,stage));
  const journal=new FileJournal(root);
  assert.deepEqual(journal.recover(),{published:0,needsReview:1});
  assert.deepEqual(journal.operationGet(opId),{state:'needs_review'});
  assert.throws(()=>journal.putTaskFile({task,name:'uncertain.txt',opId:randomUUID(),bytes:Buffer.from('other'),result:{},grant: grant(task)}),
    {code:'conflict'});
}));

test('attachment folder refusal names its reason and preserves the original files', () => fixture(async (root, task) => {
  const { saveTaskAttachment } = await import('@alpacawork/backend/test-dist/control/task-files.js');
  await saveTaskAttachment(root, task, 'draft1', 'a.txt', Buffer.from('a'), randomUUID(), grant(task));
  const source = join(folderOf(root, task), 'attachments/draft1');
  mkdirSync(join(source, 'nested'));
  assert.throws(() => new FileJournal(root).moveAttachmentFolder({ task, from: 'draft1', to: 'draft2',
    opId: randomUUID(), result: {}, grant: grant(task) }),
  { code: 'invalid_input', reason: { kind: 'unsafe_attachment_folder' } });
  assert.equal(readFileSync(join(source, 'a.txt'), 'utf8'), 'a');
  assert.equal(existsSync(join(folderOf(root, task), 'attachments/draft2')), false);
}));

test('folder move reserves descendants against put and delete', () => fixture(async (root, task) => {
  const { saveTaskAttachment }=await import('@alpacawork/backend/test-dist/control/task-files.js');
  await saveTaskAttachment(root,task,'draft1','a.txt',Buffer.from('a'),randomUUID(),grant(task));
  const moveId=randomUUID();
  assert.throws(()=>new FileJournal(root,phase=>{if(phase==='reserved') throw new Error('crash');})
    .moveAttachmentFolder({task,from:'draft1',to:'draft2',opId:moveId,result:{},grant: grant(task)}),/crash/);
  const journal=new FileJournal(root);
  assert.throws(()=>journal.putTaskFile({task,name:'attachments/draft2/x.txt',opId:randomUUID(),bytes:Buffer.from('x'),result:{},grant: grant(task)}),
    {code:'conflict'});
  assert.throws(()=>journal.deleteTaskFile({task,name:'attachments/draft1/a.txt',opId:randomUUID(),
    expectedDigest:fileDigest(Buffer.from('a')),result:{},grant: grant(task)}),{code:'conflict'});
  assert.deepEqual(journal.recover(),{published:1,needsReview:0});
  assert.deepEqual(journal.readTaskFile(task,'attachments/draft2/a.txt'),Buffer.from('a'));
}));

test('settings save replays an unchanged file and a file change', () => fixture(async root => {
  const { readServerSettings, saveServerSettings }=await import('@alpacawork/backend/test-dist/server-settings.js');
  const before=await readServerSettings(root);
  assert.equal(before.error,undefined);
  const unchanged={config:'unchanged',agents:before.agentsText,expectedConfigHash:before.hash!,
    edit:{limits:before.limits}};
  const firstId=randomUUID();
  const kept=await saveServerSettings(root,unchanged,firstId);
  assert.deepEqual(await saveServerSettings(root,unchanged,firstId),kept);
  assert.equal(new FileJournal(root).operationGet(firstId).state,'committed');
  const changed={config:'limits changed',agents:kept.agentsText,expectedConfigHash:kept.hash!,
    edit:{limits:{...kept.limits,parallel:2}}};
  const secondId=randomUUID();
  const saved=await saveServerSettings(root,changed,secondId);
  assert.deepEqual(await saveServerSettings(root,changed,secondId),saved);
  assert.equal(new FileJournal(root).operationGet(secondId).state,'committed');
}));

test('orphan stage and committed tombstone are cleaned on restart', () => fixture((root,task) => {
  assert.throws(()=>new FileJournal(root,phase=>{if(phase==='staged') throw new Error('crash');})
    .putTaskFile({task,name:'orphan.txt',opId:randomUUID(),bytes:Buffer.from('orphan'),result:{},grant: grant(task)}),/crash/);
  const meta=join(root,'.alpacawork');
  assert.equal(readdirSync(meta).some(name=>name.startsWith('file-stage-')),true);
  new FileJournal(root).recover();
  assert.equal(readdirSync(meta).some(name=>name.startsWith('file-stage-')),false);
  const journal=new FileJournal(root),bytes=Buffer.from('to delete');
  receipt(journal.putTaskFile({task,name:'delete.txt',opId:randomUUID(),bytes,result:{},grant: grant(task)}));
  const opId=randomUUID();
  assert.throws(()=>new FileJournal(root,phase=>{if(phase==='receipted') throw new Error('crash');})
    .deleteTaskFile({task,name:'delete.txt',opId,expectedDigest:fileDigest(bytes),result:{},grant: grant(task)}),/crash/);
  assert.equal(journal.operationGet(opId).state,'committed');
  assert.equal(readdirSync(meta).some(name=>name.startsWith('file-tomb-')),true);
  journal.recover();
  assert.equal(readdirSync(meta).some(name=>name.startsWith('file-tomb-')),false);
}));

test('Task file paths reject traversal and read ordinary linked files', () => fixture((root,task) => {
  const journal=new FileJournal(root);
  assert.throws(()=>journal.taskPath(task,'../escape'),{code:'unsafe_path'});
  receipt(journal.putTaskFile({task,name:'plain.txt',opId:randomUUID(),bytes:Buffer.from('plain'),result:{},grant: grant(task)}));
  const folder=folderOf(root,task);
  symlinkSync('plain.txt',join(folder,'link.txt'));
  linkSync(join(folder,'plain.txt'),join(folder,'hard.txt'));
  assert.equal(journal.readTaskFile(task,'link.txt').toString(), 'plain');
  assert.equal(journal.readTaskFile(task,'hard.txt').toString(), 'plain');
}));

test('DB Task folder is listed in tree and task get files', () => fixture(async (root, task) => {
  const { taskFiles }=await import('@alpacawork/backend/test-dist/control/task-files.js');
  const { readControlSource,taskView }=await import('@alpacawork/backend/test-dist/control/task-views.js');
  const { readControlTree } = await import('./helpers/control-tree.ts');
  const { FileWriter }=await import('@alpacawork/backend/test-dist/raw/storage.js');
  const journal=new FileJournal(root),folder=journal.taskLocation(task).folder;
  receipt(journal.putTaskFile({task,name:'notes/proof.txt',opId:randomUUID(),bytes:Buffer.from('proof'),result:{},grant: grant(task)}));
  receipt(journal.putTaskFile({task,name:'index.md',opId:randomUUID(),bytes:Buffer.from('user file'),result:{},grant: grant(task)}));
  const writer=new FileWriter(root);
  try { assert.deepEqual(taskFiles(writer,[folder]).get(folder)?.map(file=>file.name),['index.md','notes/proof.txt']); }
  finally { writer.close(); }
  assert.equal(folder,`tasks/${task}`);
  const view=taskView(await readControlSource(root),task,{files:true});
  assert.deepEqual(view.task.files?.map(file=>file.path),
    [taskFileRoute(task,'index.md'),taskFileRoute(task,'notes/proof.txt')]);
  const tree=await readControlTree(root);
  assert.deepEqual(tree.tasks.find(item=>item.id===task)?.files.map(file=>file.name),['index.md','notes/proof.txt']);
}));

test('real HTTP file and attachment routes use DB location and restart replay', () => fixture(async (root,task) => {
  const { Hono }=await import('../apps/backend/node_modules/hono/dist/index.js');
  const { getRequestListener }=await import('../apps/backend/node_modules/@hono/node-server/dist/index.mjs');
  const { installTaskFileRoutes,installAttachmentFileRoutes }=await import('@alpacawork/backend/test-dist/receiver/file-routes.js');
  const journal=new FileJournal(root);
  async function listen() {
    const app=new Hono();
    app.onError((error,c)=>c.json({error:error.message},error.code==='idempotency_conflict'?409:400));
    const options={authorizeRead:(_request: Request,id: string)=>{assert.equal(id,task);},
      authorizeWrite:(_request: Request,id: string)=>{assert.equal(id,task); return grant(id);},changed:()=>{}};
    installTaskFileRoutes(app,root,options);
    installAttachmentFileRoutes(app,root,options);
    const server=createServer(getRequestListener(app.fetch,{overrideGlobalObjects:false}));
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();
    if (!address || typeof address==='string') throw new Error('Missing HTTP address');
    return {url:`http://127.0.0.1:${address.port}`,close:()=>new Promise<void>((resolve,reject)=>
      server.close(error=>error?reject(error):resolve()))};
  }
  let http=await listen();
  try {
    const bytes=Buffer.from([0,1,255,13]),opId=randomUUID();
    const url=`${http.url}/api/tasks/${task}/file?path=notes%2Fproof.bin`;
    const headers={'X-Alpacawork-Op-Id':opId,'X-Alpacawork-Content-Digest':fileDigest(bytes)};
    const put=await fetch(url,{method:'PUT',headers,body:bytes});
    assert.equal(put.status,200);
    const first=await put.json();
    assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()),bytes);
    assert.equal(journal.operationGet(opId).state,'committed');
    await http.close();
    http=await listen();
    assert.equal(new FileJournal(root).operationGet(opId).state,'committed');
    const replay=await fetch(url.replace(/127\.0\.0\.1:\d+/,new URL(http.url).host),{method:'PUT',headers,body:bytes});
    assert.equal(replay.status,200);
    assert.deepEqual(await replay.json(),first);
    const changed=Buffer.from('changed');
    const conflict=await fetch(url.replace(/127\.0\.0\.1:\d+/,new URL(http.url).host),{method:'PUT',
      headers:{...headers,'X-Alpacawork-Content-Digest':fileDigest(changed)},body:changed});
    assert.equal(conflict.status,409);
    const video=Buffer.from('0000ftypisom0123');
    receipt(journal.putTaskFile({task,name:'clip.mp4',opId:randomUUID(),bytes:video,result:{},grant: grant(task)}));
    const ranged=await fetch(`${http.url}/api/tasks/${task}/file?path=clip.mp4`,{headers:{Range:'bytes=4-7'}});
    assert.equal(ranged.status,206);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),video.subarray(4,8));
    const attachmentUrl=`${http.url}/api/tasks/${task}/attachments?requestId=draft1&name=image.png`;
    assert.equal((await fetch(attachmentUrl,{method:'POST',body:'image'})).status,400);
    const attachmentId=randomUUID();
    const upload=await fetch(attachmentUrl,{method:'POST',headers:{'X-Alpacawork-Op-Id':attachmentId},body:'image'});
    assert.equal(upload.status,200);
    const attached=await upload.json();
    assert.deepEqual(Buffer.from(await (await fetch(`${http.url}${attached.absolutePath}`)).arrayBuffer()),Buffer.from('image'));
    assert.equal(journal.operationGet(attachmentId).state,'committed');
    const repeated=await fetch(attachmentUrl,{method:'POST',headers:{'X-Alpacawork-Op-Id':attachmentId},body:'image'});
    assert.equal(repeated.status,200);
    assert.deepEqual(await repeated.json(),attached);
    const mismatch=await fetch(attachmentUrl,{method:'POST',headers:{'X-Alpacawork-Op-Id':attachmentId},body:'changed'});
    assert.equal(mismatch.status,409);
  } finally { await http.close(); }
}));

for (const kind of ['put', 'delete'] as const) test(`a ${kind} interrupted between link and unlink resumes the saved request once`, () => fixture((root, task) => {
  const journal = new FileJournal(root), bytes = Buffer.from('fixed request'), opId = randomUUID();
  if (kind === 'delete') receipt(journal.putTaskFile({ task, name: 'link-gap.txt', opId: randomUUID(), bytes, result: {}, grant: grant(task) }));
  const interrupted = new FileJournal(root, phase => { if (phase === 'linked') throw new Error('lost after link'); });
  const request = { task, name: 'link-gap.txt', opId, result: { kind }, grant: grant(task) };
  assert.throws(() => kind === 'put' ? interrupted.putTaskFile({ ...request, bytes })
    : interrupted.deleteTaskFile({ ...request, expectedDigest: fileDigest(bytes) }), /lost after link/);
  journal.recover();
  assert.equal(journal.operationGet(opId).state, 'committed');
  assert.equal(kind === 'put' ? journal.readTaskFile(task, request.name).equals(bytes)
    : !existsSync(join(folderOf(root, task), request.name)), true);
  const replay = kind === 'put' ? journal.putTaskFile({ ...request, bytes })
    : journal.deleteTaskFile({ ...request, expectedDigest: fileDigest(bytes) });
  assert.equal(receipt(replay).replayed, true);
}));
