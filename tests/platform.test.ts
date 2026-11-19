/** Platform configuration, task reads, live updates and HTTP boundaries. */
import { bodyHash } from '@alpacawork/contract/control';
import { canonicalValues } from '@alpacawork/contract';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { request as nodeRequest } from 'node:http';
import { DEFAULT_LIMITS, DEFAULT_SCHEMA } from '@alpacawork/contract';
import { digest } from '@alpacawork/raw';
import { parse } from 'yaml';
import { area, root, run, cli, start, stop, request, sse } from './helpers/platform-http.ts';

/** Saves the root project P1's own fields (null: inherit) the way the screen does, against the Task hash it read. */
function saveSchema(app: Awaited<ReturnType<typeof start>>, fields: readonly string[] | null, expected: string) {
  return request(app, 'field/use', { task: 'P1', ...(fields === null ? { inherit: true } : { fields }), expectedTaskHash: expected });
}
/** DEFAULT_SCHEMA in another order: a project's own fields. */
const REORDERED = [...DEFAULT_SCHEMA].reverse();
/** Saves the screen's part of config.yaml as it does: the limits and agents block just read, against a config.yaml hash. */
async function saveConfig(app: Awaited<ReturnType<typeof start>>, expected: string) {
  const current = (await request(app, 'config/get')).body;
  return request(app, 'config/set', { config: JSON.stringify({ limits: current.limits }),
    agents: current.agentsText, expectedConfigHash: expected });
}
const projectHash = async () => (await cli('task', 'get', '--task', 'P1')).task.hash;

test('task list reads the initialized control database through the HTTP CLI', async () => {
  assert.deepEqual((await cli('task', 'list')).tasks.map((task: { id: string }) => task.id), ['P1', 'T2']);
  assert.equal(existsSync(join(root, '.alpacawork/alpacawork.sqlite')), true);
});

test('a project\'s fields save to the project and leave config.yaml as written; a hand edit still refuses the old screen', async () => {
  const file = join(root, 'config.yaml');
  const original = '# Launch settings\n' + readFileSync(file, 'utf8');
  writeFileSync(file, original);
  const app = await start();
  // A project's own value is its policy; the fields it chooses, and field get at it, are those of its Tasks.
  const task = (await request(app, 'task/new', { title: 'Uses the project fields', parent: 'P1' })).body.task.id;
  assert.deepEqual((await request(app, 'field/get?task=P1')).body.fields, [...DEFAULT_SCHEMA]);
  const initial = (await request(app, `field/get?task=${task}`)).body;
  assert.deepEqual([initial.from, initial.fields], [null, [...DEFAULT_SCHEMA]]);
  const screen = (await request(app, 'config/get')).body.hash;
  const saved = await saveSchema(app, REORDERED, await projectHash());
  assert.equal(saved.status, 200);
  assert.equal(readFileSync(file, 'utf8'), original, 'fields belong to the project, not to this PC');
  const read = (await request(app, `field/get?task=${task}`)).body;
  assert.deepEqual([read.from, read.fields], ['P1', REORDERED]);
  assert.deepEqual((await request(app, 'workspace/live')).body.profiles.map((profile: { key: string }) => profile.key), ['claude', 'codex']);
  // A hand edit to any section must prevent the old screen from overwriting it.
  const edited = original.replace('parallel: 8', 'parallel: 2');
  writeFileSync(file, edited);
  const stale = await saveConfig(app, screen);
  assert.equal(stale.status, 409);
  assert.equal(readFileSync(file, 'utf8'), edited);
  const updated = await saveConfig(app, (await request(app, 'config/get')).body.hash);
  assert.equal(updated.status, 200);
  assert.equal(parse(readFileSync(file, 'utf8')).limits.parallel, 2);
  assert.equal((await saveSchema(app, null, saved.body.task.hash)).status, 200);
  assert.equal((await request(app, `field/get?task=${task}`)).body.from, null);
});

test('config saves reject input outside limits, and malformed shared YAML, without overwriting it', async () => {
  const app = await start(), file = join(root, 'config.yaml');
  const limits = `limits: ${JSON.stringify(DEFAULT_LIMITS)}\n`;
  const save = (config: string, source: string) => request(app, 'config/set',
    { config, agents: 'agents: {}\n', expectedConfigHash: digest(Buffer.from(source)) });
  for (const source of ['agents: [', 'agents: {}\nagents: {}', 'other: true', 'agents: !unknown {}', 'agents: &agents {}\nextracts: *agents']) {
    writeFileSync(file, source);
    const result = await save(limits, source);
    assert.equal(result.status, 400);
    assert.equal(readFileSync(file, 'utf8'), source);
  }
  const source = 'agents: {}\n';
  writeFileSync(file, source);
  for (const yaml of [`${limits}agents: {}`, 'limits: {}', `${limits}extracts: []`, `${limits}other: true`,
    '{}', '[]', `${limits}other: [`, `${limits}${limits}`, `${limits}other: !unknown []`,
    `${limits}other: &items [*items]`]) {
    const result = await save(yaml, source);
    assert.equal(result.status, 400, yaml);
    assert.equal(result.body.error.code, 'invalid_input', yaml);
    assert(result.body.error.issues.length > 0, yaml);
    assert.equal(readFileSync(file, 'utf8'), source);
  }
});

test('list/get/search read the saved Task values through the HTTP CLI',async()=>{
  const task=(await cli('task','new','--title','Independent title','--parent','P1')).task;
  assert.equal(task.parentId,'P1');
  const source=join(area,'values.json');writeFileSync(source,JSON.stringify({notes:'# Independent body\nneedle-body'}));
  await cli('task','update','--task',task.id,'--values-file',source,'--expected-task-hash',task.hash);
  // A match is listed with the path to it: its project P1 first.
  for(const query of ['T3','Independent title','needle-body'])assert.deepEqual((await cli('task','list','--text',query)).tasks.map((row:{id:string})=>row.id),['P1','T3']);
  assert.deepEqual((await cli('task','get','--task','T3')).task.values,{notes:'# Independent body\nneedle-body'});
  assert.equal(existsSync(join(root,'.alpacawork/alpacawork.sqlite')),true);
});
test('REST rejects repeated or unknown input and stale task edits fail',async()=>{
  const app=await start();
  assert.equal((await request(app,'run/get?run=one&run=two')).status,400);
  assert.equal((await request(app,'task/new',{title:'x',parent:'P1',unknown:'x'})).status,400);
  const task=(await request(app,'task/new',{title:'HTTP task',parent:'P1'})).body.task;
  await request(app,'task/update',{task:task.id,values:{notes:'http-search-marker'},expectedTaskHash:task.hash});
  assert.deepEqual((await cli('task','list','--text','http-search-marker')).tasks.map((row:{id:string})=>row.id),['P1','T3']);
  assert.equal((await request(app,'task/update',{task:'T3',title:'stale',expectedTaskHash:task.hash})).status,409);
  assert.equal((await run(['search','--query','x'])).code,2);
});
test('SSE reconnect gets the current index after a task edit, the changes after its cursor, and the whole index after a restart',async()=>{
  // The edited row is the plain Task T2, below the root project P1.
  const edited=(index:{tasks:{id:string;hash:string;notice:{bodyHash:string}}[]})=>index.tasks.find(row=>row.id==='T2');
  const app=await start(),stream=await sse(app),first=await stream.next();stream.close();
  const saved=await request(app,'task/update',{task:'T2',values:{notes:'SSE update'},expectedTaskHash:edited(first)?.hash});assert.equal(saved.status,200);
  const reconnected=await sse(app);let next=await reconnected.next();reconnected.close();
  assert.equal(edited(next)?.hash,saved.body.task.hash);assert.equal(edited(next)?.notice.bodyHash,bodyHash(canonicalValues({notes:'SSE update'})));
  // Resuming includes the edited row and the ancestor whose subtree timestamp changed.
  const resumed=await sse(app,`${first.generation}:${first.rev}`);const delta=await resumed.next();resumed.close();
  assert.equal(delta.rev,first.rev+1);assert.deepEqual(delta.tasks.upsert.map((row:{id:string})=>row.id),['P1','T2']);
  assert.deepEqual((await request(app,'task/view?task=T2')).body.task.values,{notes:'SSE update'});
  await stop(app);const restarted=await start(),after=await sse(restarted,`${first.generation}:${first.rev}`);next=await after.next();after.close();
  assert.notEqual(next.generation,first.generation);assert.equal(edited(next)?.notice.bodyHash,bodyHash(canonicalValues({notes:'SSE update'})));
});
test('origin, host, size and path boundaries reject',async()=>{
  const app=await start();
  assert.equal((await request(app,'field/get',undefined,{Origin:'http://evil.invalid'})).status,403);
  assert.equal(await new Promise<number>((done,reject)=>{nodeRequest(app.base+'/api/field/get',{headers:{Host:'evil.invalid'}},res=>{res.resume();done(res.statusCode!);}).on('error',reject).end();}),403);
  assert.equal((await request(app,'task/update',{task:'../outside',title:'x',expectedTaskHash:'0'.repeat(64)})).status,400);
  // Each Entry owns its body limit: 16 KiB by default, 512 KiB for a request and 7 MiB for document writes.
  const within=async(path:string,body:object)=>assert.notEqual((await request(app,path,body)).status,413,path);
  assert.equal((await request(app,'task/request',{task:'T2',instruction:'x'.repeat(512 * 1024)})).status,413);
  await within('task/request',{task:'T2',instruction:'x'.repeat(64 * 1024)});
  await within('config/set',{config:'x'.repeat(64 * 1024),agents:'',expectedConfigHash:'missing'});
  assert.equal((await request(app,'config/set',{config:'x'.repeat(512 * 1024),agents:'',expectedConfigHash:'missing'})).status,400);
  assert.equal((await request(app,'config/set',{config:'x'.repeat(7 * 1024 * 1024),agents:'',expectedConfigHash:'missing'})).status,413);
  await within('task/new',{title:'x'.repeat(15 * 1024),parent:'P1'});
  assert.equal((await request(app,'task/new',{title:'Large values',parent:'P1',values:{notes:'x'.repeat(7 * 1024 * 1024)}})).status,413);
  assert.equal((await request(app,'task/move',{task:'T2',parent:'P1',expectedTaskHash:'x'.repeat(16 * 1024)})).status,413);
});
test('J1 a project\'s fields are read by CLI and REST alike, refuse a save over another change, and stay readable when config.yaml breaks', async () => {
  const app = await start();
  const task = (await request(app, 'task/new', { title: 'Uses the project fields', parent: 'P1' })).body.task.id;
  const screen = await projectHash();
  assert.equal((await saveSchema(app, REORDERED, screen)).status, 200);
  const read = (await request(app, `field/get?task=${task}`)).body;
  assert.equal(read.from, 'P1');
  assert.equal((await cli('field', 'get', '--task', task)).version, read.version);
  assert.equal((await saveSchema(app, REORDERED, screen)).status, 409, 'the project changed since that screen read it');
  const refused = await saveSchema(app, REORDERED.filter(id => id !== 'decide'), await projectHash());
  assert.equal(refused.status, 400, 'a system field cannot be left out');
  writeFileSync(join(root, 'config.yaml'), 'agents: [');
  assert.deepEqual((await request(app, `field/get?task=${task}`)).body, read);
});

test('list, get and workspace snapshots contain no ai or control placeholders', async () => {
  const check = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(key !== 'ai' && key !== 'control',`Unexpected key: ${key}`);
      check(child);
    }
  };
  check(await cli('task','list')); check(await cli('task','get','--task','T2'));
  const app = await start();
  check((await request(app,'workspace/live')).body);
  const stream = await sse(app);
  try { check(await stream.next()); } finally { stream.close(); }
});
