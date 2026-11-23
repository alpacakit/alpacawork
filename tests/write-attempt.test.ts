import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Socket } from 'node:net';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { operationId, writeAttempt } from '../apps/cli/test-dist/write-attempt.js';
import { actorHeaders, LostAnswer, prepareRequest, RemoteProblem, sendPrepared } from '../apps/cli/test-dist/transport.js';
import { cliRun } from './helpers/http-cli.ts';
import { cliCommand } from './helpers/cli-session.ts';

const prepared = () => prepareRequest('http://127.0.0.1:1', '/api/commands/task/new', 'POST', { title: 'one' }, new Headers());
const remote = (code: 'busy' | 'invalid_input' | 'conflict' | 'publication_pending' | 'publication_needs_review', detail?: unknown) =>
  new RemoteProblem({ error: { code, message: code, retry: code.startsWith('publication_') ? 'check' : code === 'busy' ? 'later' : code === 'conflict' ? 'reread' : 'fix', detail } });
function runtime() {
  let now = 0; const waits: number[] = [];
  return { now: () => now, wait: async (ms: number) => { waits.push(ms); now += ms; }, advance: (ms: number) => { now += ms; }, waits };
}

test('ID is generated once or explicit, empty is refused, and prepared input/headers/bytes are snapshots', () => {
  assert.notEqual(operationId(undefined), operationId(undefined));
  assert.equal(operationId('explicit-$()`'), 'explicit-$()`');
  for (const id of ['', ' \n ']) assert.throws(() => operationId(id), { code: 'invalid_input' });
  const env = { ALPACAWORK_RUN: 'R1', ALPACAWORK_RUN_TOKEN: 'a'.repeat(64) };
  const headers = actorHeaders(env), bytes = Buffer.from([1,2,3]);
  const request = prepareRequest('http://127.0.0.1:1', '/file?q=x', 'PUT', bytes, headers);
  env.ALPACAWORK_RUN_TOKEN = 'b'.repeat(64); headers.set('Authorization','changed'); bytes[0] = 9;
  assert.deepEqual([...request.body as Uint8Array], [1,2,3]);
  assert.equal(new Headers(request.headers as [string,string][]).get('Authorization'), 'Alpacawork-Run R1:' + 'a'.repeat(64));
  const input = { expectedTaskHash: 'old', body: 'stdin' };
  const json = prepareRequest('http://127.0.0.1:1', '/report', 'POST', input, headers);
  input.body = 'changed';input.expectedTaskHash = 'new';assert.equal(json.body, '{"expectedTaskHash":"old","body":"stdin"}');
});

// The attempt loop asks one thing of an answer: whether it says check, and whether it is a publication under review.
for (const code of ['busy','publication_needs_review'] as const)
  test(`${code} stops at one write and preserves original detail`, async () => {
    let count=0;
    await assert.rejects(writeAttempt(prepared(),'id','http://127.0.0.1:1',runtime(),async()=>{count++;throw remote(code,{original: true});}), (error: any) => {
      assert(error instanceof RemoteProblem); assert.equal(error.body.error.code,code);
      assert.equal((error.body.error.detail as any).original,true);assert.equal((error.body.error.detail as any).operation.attempts,1);return true;
    }); assert.equal(count,1);
  });

for (const later of ['busy','invalid_input','conflict'] as const) test(`an unresolved first write survives later ${later}`, async () => {
  let count=0;
  await assert.rejects(writeAttempt(prepared(),'id','http://127.0.0.1:1',runtime(),async()=>{
    if(++count===1) throw new Problem(PROBLEM_CODE.unavailable,'unknown'); throw remote(later,{original:'last'});
  }),(error: any)=>{
    assert(error instanceof RemoteProblem);assert.equal(error.body.error.code,'save_unconfirmed');
    const detail=error.body.error.detail as any;
    assert.equal(detail.lastFailure.code,later);assert.deepEqual(detail.lastFailure.detail,{original:'last'});assert.equal(detail.operation.attempts,2);return true;
  });assert.equal(count,2);
});

test('three pending attempts keep same request, no GET, exact wait schedule and stop unconfirmed', async () => {
  const rt=runtime(), request=prepared();const timeouts:number[]=[];
  await assert.rejects(writeAttempt(request,'id','http://127.0.0.1:1',rt,async(r,timeout)=>{
    assert.equal(r,request);assert.equal(r.method,'POST');timeouts.push(timeout!);throw remote('publication_pending');
  }),(error: any)=>{
    assert(error instanceof RemoteProblem);assert.equal(error.body.error.retry,'check');assert.equal((error.body.error.detail as any).operation.attempts,3);return true;
  });assert.deepEqual(rt.waits,[250,1000]);assert.deepEqual(timeouts,[30000,30000,30000]);
});

test('65 second total budget bounds each attempt and response consumption, then stops', async()=>{
  const rt=runtime(),timeouts:number[]=[];
  await assert.rejects(writeAttempt(prepared(),'id','http://127.0.0.1:1',rt,async(_r,timeout)=>{
    timeouts.push(timeout!);rt.advance(timeout!);throw new Problem('unavailable','timeout');
  }),RemoteProblem);
  assert.deepEqual(timeouts,[30000,30000,3750]);assert.equal(rt.now(),65000);
});

test('a successful partial result settles earlier uncertainty without extra retry', async()=>{
  let calls=0;const partial={errors:[{code:'read_failed'}]};
  const result=await writeAttempt(prepared(),'id','http://127.0.0.1:1',runtime(),async()=>{
    if(++calls===1)throw remote('publication_pending');return partial;
  });assert.equal(result,partial);assert.equal(calls,2);
});

test('copying checkCommand passes hostile op-id literally to a shell command', async()=>{
  const opId="literal-$(printf injected)`printf injected`'quote";
  await assert.rejects(writeAttempt(prepared(),opId,'http://127.0.0.1:1',runtime(),async()=>{throw remote('publication_needs_review');}),(error: any)=>{
    assert(error instanceof RemoteProblem);const command=(error.body.error.detail as any).operation.checkCommand;
    const output=execFileSync('/bin/sh',['-c',`alpacawork() { printf '%s\\n' "$@"; }; ${command}`],{encoding:'utf8'}).trim().split('\n');
    assert.equal(output.at(-1),opId);assert.equal(output[1],'http://127.0.0.1:1');return true;
  });
});

test('transport timeout remains active while reading a response body', async t=>{
  const { createServer }=await import('node:http');
  const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address();assert(address&&typeof address==='object');
  const start=performance.now();
  await assert.rejects(sendPrepared(prepareRequest(`http://127.0.0.1:${address.port}`,'/write','POST',{},new Headers()),50),{code:'unavailable'});
  assert(performance.now()-start<2000,'body read must obey attempt deadline');
});

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string; fault: boolean };
const IDENTITY = { protocol: 2, restoreId: '19a59de6-3758-4284-8368-a61f7f9bbc02' };
/** The identity preflight can succeed while the original transport fault still reaches every POST. */
async function failing(t: TestContext, answer: (socket: Socket) => void, identity?: typeof IDENTITY) {
  const seen: Seen[] = [];
  const selected = process.env.ALPACAWORK_WRITE_ATTEMPT_EVIDENCE;
  const folder = selected && join(selected, createHash('sha256').update(t.fullName).digest('hex').slice(0, 16));
  if (folder) mkdirSync(folder); // An earlier case/variant/attempt must never be overwritten.
  const capture = (name: string, value: unknown) => {
    t.diagnostic(JSON.stringify({ name, value }));
    if (folder) writeFileSync(join(folder, name + '.json'), JSON.stringify(value, null, 2), { flag: 'wx' });
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const preflight = !!identity && req.method === 'GET' && req.url === '/api/runtime/recovery';
    const item = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('base64'), fault: !preflight };
    seen.push(item); capture('request-' + seen.length, item);
    req.socket.on('error', () => {});
    if (preflight) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(identity)); }
    else answer(req.socket);
  });
  const close = () => { server.closeAllConnections(); server.close(); };
  const lifetime = setTimeout(close, 30_000); lifetime.unref();
  t.after(() => { clearTimeout(lifetime); close(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, seen, capture };
}
function writeState(t: TestContext, capture: (name: string, value: unknown) => void) {
  const state = mkdtempSync(join(tmpdir(), 'write-attempt-'));
  const pins = () => readdirSync(state, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
    .map(item => ({ path: join(item.parentPath, item.name), raw: readFileSync(join(item.parentPath, item.name), 'utf8') }));
  t.after(() => { capture('pins', pins()); rmSync(state, { recursive: true, force: true }); });
  return { env: { XDG_STATE_HOME: state, ALPACAWORK_RUN: 'R1', ALPACAWORK_RUN_TOKEN: 'a'.repeat(64) }, pins };
}
const HASH = 'a'.repeat(64);
for (const [name, answer, read, write, speaksOfASave] of [
  ['resets the connection', (socket: Socket) => socket.resetAndDestroy(), 'The server gave no answer', 'Save result unknown; check operation with the same op-id', true],
  ['closes without an answer', (socket: Socket) => socket.end(), 'The server gave no answer', 'Save result unknown; check operation with the same op-id', false],
  ['cuts the body short', (socket: Socket) => { socket.write('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n{'); setTimeout(() => socket.destroy(), 20); },
    'The server gave no answer', 'Save result unknown; check operation with the same op-id', false],
  ['answers with something else', (socket: Socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx'),
    'Incomplete server response', 'Incomplete server response; check operation with the same op-id', true],
] as const) test(`when the server ${name}, only a write speaks of a save`, async t => {
  const server = await failing(t, answer, speaksOfASave ? IDENTITY : undefined);
  const result = await cliCommand(server.url, ['task', 'get', '--task', 'T1'], {});
  assert.equal(result.code, 3, result.stderr);
  assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'unavailable', message: read, retry: 'check' } });
  // A write's words depend only on what was lost (SAVE_WORDS), and each of its real attempts waits its real schedule.
  if (!speaksOfASave) return;
  const state = writeState(t, server.capture), opId = randomUUID();
  const written = await cliRun(server.url, ['task', 'update', '--task', 'T1', '--title', 'x', '--expected-task-hash', HASH, '--op-id', opId], state.env);
  server.capture('write-result', written);
  assert.equal(written.code, 3, written.stderr);
  const { error } = JSON.parse(written.stderr);
  assert.deepEqual([error.code, error.message, error.retry], ['unavailable', write, 'check']);
  assert.equal(error.detail.operation.attempts, 3);
  assert.equal(error.detail.operation.opId, opId);
  const requests = server.seen.slice(1); // The neutral read above is separate from this write.
  assert.deepEqual(requests.map(item => [item.method, item.url, item.fault]), [
    ['GET', '/api/runtime/recovery', false], ...Array.from({ length: 3 }, () => ['POST', '/api/commands/task/update', true]),
  ]);
  const posts = requests.slice(1), first = posts[0];
  assert.equal(first.headers['x-alpacawork-op-id'], opId);
  assert.equal(first.headers.authorization, 'Alpacawork-Run R1:' + 'a'.repeat(64));
  assert.equal(first.headers['x-alpacawork-restore-id'], IDENTITY.restoreId);
  const payload = JSON.parse(Buffer.from(first.body, 'base64').toString());
  assert.equal(payload.title, 'x'); assert.equal(payload.expectedTaskHash, HASH);
  for (const post of posts.slice(1)) assert.deepEqual(post, first, 'all POST bytes, credentials, op-id and restore pin stay frozen');
  assert.equal(state.pins().length, 1);
  assert.equal(JSON.parse(state.pins()[0].raw).restoreId, IDENTITY.restoreId);
});

for (const [name, answer, message] of [
  ['reset', (socket: Socket) => socket.resetAndDestroy(), 'The server gave no answer'],
  ['502', (socket: Socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx'), 'Incomplete server response'],
] as const) test(`identity GET ${name} stops the real CLI before any POST or durable pin`, async t => {
  const server = await failing(t, answer), state = writeState(t, server.capture);
  const result = await cliRun(server.url, ['task', 'update', '--task', 'T1', '--title', 'x', '--expected-task-hash', HASH, '--op-id', randomUUID()], state.env);
  server.capture('write-result', result);
  assert.equal(result.code, 3, result.stderr);
  const { error } = JSON.parse(result.stderr);
  assert.deepEqual([error.code,error.message,error.retry], ['unavailable',message,'check']);
  assert.equal(error.detail.operation.attempts,3);
  assert.equal(error.detail.operation.postAttempts,0);
  assert.equal(error.detail.operation.server,server.url);
  assert.ok(error.detail.operation.checkCommand.includes(error.detail.operation.opId));
  assert.deepEqual(server.seen.map(item => [item.method, item.url, item.fault]), Array.from({length:3},()=>['GET','/api/runtime/recovery',true]));
  assert.deepEqual(state.pins(), []);
});

test('a timeout is the same lost answer: neutral from the transport, a save result unknown to a write', async t => {
  const server = await failing(t, () => {});
  const request = prepareRequest(server.url, '/read', 'GET', undefined, new Headers());
  await assert.rejects(sendPrepared(request, 50), (error: any) => error instanceof LostAnswer && error.message === 'The server gave no answer');
  await assert.rejects(writeAttempt(prepared(), 'id', server.url, runtime(), async () => { throw new LostAnswer('no_answer'); }),
    (error: any) => error.body.error.message === 'Save result unknown; check operation with the same op-id');
});


test('pin GET retries share identity and budget; the immutable winner is reused after a lost POST', async () => {
  const rt=runtime(), original=prepared(), pinned=Object.freeze({...original,url:original.url+'?pinned'});
  let gets=0, posts=0;
  const result=await writeAttempt(original,'one-id','http://127.0.0.1:1',rt,async (request) => {
    assert.equal(request,pinned); if(++posts===1) throw new LostAnswer('no_answer'); return 'saved';
  },async (request,id,server,timeout) => {
    assert.equal(request,original);assert.equal(id,'one-id');assert.equal(server,'http://127.0.0.1:1');assert.ok(timeout>0);
    if(++gets===1) throw new LostAnswer('no_answer'); return pinned;
  });
  assert.equal(result,'saved');assert.equal(gets,2);assert.equal(posts,2);assert.deepEqual(rt.waits,[250,1000]);
});
test('GET-only exhaustion has neutral failure and operation detail, never a POST or a save claim', async () => {
  const rt=runtime(), timeouts:number[]=[];let posts=0;
  await assert.rejects(writeAttempt(prepared(),'get-only','http://127.0.0.1:1',rt,async()=>{posts++;},async (_r,_id,_server,timeout)=>{
    timeouts.push(timeout);rt.advance(timeout);throw new LostAnswer('no_answer');
  }),(error:any)=>{
    assert.equal(error.body.error.message,'The server gave no answer');
    assert.deepEqual(error.body.error.detail.operation,{opId:'get-only',attempts:3,postAttempts:0,server:'http://127.0.0.1:1',checkCommand:"alpacawork --server 'http://127.0.0.1:1' operation get --op-id 'get-only'"});return true;
  });assert.equal(posts,0);assert.equal(rt.now(),65000);assert.deepEqual(timeouts,[30000,30000,3750]);
});
test('temporary real identity GET failure recovers with one operation ID and exactly one POST', async t => {
  const seen:{method:string,id:string|undefined,pin:string|undefined}[]=[];let gets=0;
  const server=createServer(async(req,res)=>{
    for await(const _ of req) {}
    seen.push({method:req.method!,id:req.headers['x-alpacawork-op-id'] as string,pin:req.headers['x-alpacawork-restore-id'] as string});
    if(req.method==='GET'&&++gets===1){req.socket.resetAndDestroy();return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(req.method==='GET'?IDENTITY:{saved:true}));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address();assert(address&&typeof address==='object');
  const state=writeState(t,()=>{}),id=randomUUID();
  const result=await cliRun(`http://127.0.0.1:${address.port}`,['task','update','--task','T1','--title','x','--expected-task-hash',HASH,'--op-id',id],state.env);
  assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{saved:true});
  assert.deepEqual(seen.map(r=>r.method),['GET','GET','POST']);assert.ok(seen.every(r=>r.id===id));assert.equal(seen[2].pin,IDENTITY.restoreId);assert.equal(state.pins().length,1);
});

test('closed identity endpoint retains the explicit operation ID, three attempts and zero POST attempts', { skip: process.platform !== 'linux' && 'a bound, non-listening port refuses connections only on Linux; macOS lets them time out' }, async t => {
  // A closed listener relinquishes its port and another parallel fixture can take it.
  // Native bind without listen keeps this endpoint refused and exclusively owned.
  const holder=spawn(process.execPath,[new URL('./fixtures/non-listening-port.ts',import.meta.url).pathname],{stdio:['pipe','pipe','inherit']});
  const ended=once(holder,'exit');
  t.after(async()=>{if(!holder.stdin.destroyed)holder.stdin.end();const [code,signal]=await ended;assert.equal(code,0,`port holder expired or failed: ${signal}`);});
  const lines=createInterface({input:holder.stdout});
  const [line]=await Promise.race([once(lines,'line'),ended.then(()=>{throw new Error('port holder exited before binding');})]);
  lines.close();const {port}=JSON.parse(line);assert.ok(port>0);
  const contender=createServer();const refused=once(contender,'error');contender.listen(port,'127.0.0.1');
  assert.equal((await refused)[0].code,'EADDRINUSE','the refusal fixture cannot be stolen by another listener');
  const state=writeState(t,()=>{}),id=randomUUID(),url=`http://127.0.0.1:${port}`;
  const result=await cliRun(url,['task','update','--task','T1','--title','x','--expected-task-hash',HASH,'--op-id',id],state.env);
  assert.equal(result.code,3,result.stderr);const {error}=JSON.parse(result.stderr);
  assert.equal(error.message,'Server not reached');assert.equal(error.detail.operation.opId,id);
  assert.equal(error.detail.operation.attempts,3);assert.equal(error.detail.operation.postAttempts,0);assert.equal(error.detail.operation.server,url);assert.deepEqual(state.pins(),[]);
});

test('restore_changed from a pinned POST stops without obtaining a new pin or changing the operation ID',async()=>{
  let pins=0,posts=0;const original=prepared();
  await assert.rejects(writeAttempt(original,'same-id','http://127.0.0.1:1',runtime(),async(request)=>{
    posts++;assert.equal(request,original);throw new RemoteProblem({error:{code:'restore_changed',message:'Workspace was restored',retry:'reread'}});
  },async(request,id)=>{pins++;assert.equal(id,'same-id');return request;}),(error:any)=>error.body.error.code==='restore_changed'&&error.body.error.detail.operation.attempts===1);
  assert.equal(pins,1);assert.equal(posts,1);
});
