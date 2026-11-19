import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { RECOVERY_PROTOCOL, INITIAL_RESTORE_ID } from '@alpacawork/contract/recovery';
import { DEFAULT_SERVER_ORIGIN } from '@alpacawork/contract/default-server';
import { cleanCliEnv } from './helpers/http-cli.ts';

const cli = resolve('apps/cli/dist/cli.js');
const home = await mkdtemp(join(tmpdir(), 'alpacawork-cli-home-'));
const cwd = await mkdtemp(join(tmpdir(), 'alpacawork-cli-cwd-'));
const requests: { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];
let reply: { status: number; body: unknown; raw?: string } = {
  status: 200, body: { task: { id: 'T1', folder: '/api/tasks/T1/file?path=' }, errors: [] },
};
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  requests.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
  if (req.url === '/api/runtime/recovery') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ protocol: RECOVERY_PROTOCOL, restoreId: INITIAL_RESTORE_ID }));
    return;
  }
  if (req.url === '/api/identity') {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.raw ?? JSON.stringify(reply.body));
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/tasks/T1/file?')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([0, 255, 13, 10]));
    return;
  }
  res.writeHead(reply.status, { 'content-type': 'application/json' });
  res.end(reply.raw ?? JSON.stringify(reply.body));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;

async function run(args: string[], env: Record<string, string | undefined> = {}, input = '') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env: cleanCliEnv({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ALPACAWORK_SERVER: origin, ...env }),
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveRun({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const sent = () => JSON.parse(requests.at(-1)!.body.toString());

test('different cwd and HOME use only selected HTTP server; URLs become absolute', async () => {
  const result = await run(['task', 'get', '--task', 'T1']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.at(-1)?.url, '/api/task/get?task=T1');
  assert.equal(JSON.parse(result.stdout).task.folder, `${origin}/api/tasks/T1/file?path=`);
  assert.equal(result.stderr, '');
  assert.equal(requests.at(-1)?.headers[CONTRACT_HEADER.toLowerCase()], String(CLI_CONTRACT));
  // A person's command names where it runs, for the cwd rule; a Run works in its own Task and names none.
  assert.equal(requests.at(-1)?.headers['x-alpacawork-cwd'], encodeURIComponent(realpathSync(cwd)));
  await run(['task', 'list']);
  assert.equal(requests.at(-1)?.url, '/api/task/list');
  await run(['task', 'list', '--state', 'todo,doing', '--state', 'waiting']);
  assert.equal(requests.at(-1)?.url, '/api/task/list?state=todo&state=doing&state=waiting');
  await run(['task', 'get', '--task', 'T1', '--log', '2', '--runs', '3']);
  assert.equal(requests.at(-1)?.url, '/api/task/get?task=T1&log=2&runs=3');
  await run(['task', 'list', '--depth', '1', '--kind', 'project']);
  assert.equal(requests.at(-1)?.url, '/api/task/list?depth=1&kind=project');
  assert.equal((await run(['task', 'list'], { ALPACAWORK_RUN: 'R1', ALPACAWORK_RUN_TOKEN: 'a'.repeat(64) })).code, 0);
  assert.equal(requests.at(-1)?.headers['x-alpacawork-cwd'], undefined);
});

test('a Task is its T number alone: --project, ALPACAWORK_PROJECT and <key>/T42 are not read', async () => {
  const before = requests.length;
  for (const args of [['task', 'list', '--project', 'default'], ['--project', 'default', 'task', 'list'],
    ['task', 'get', '--task', 'T1', '--project', 'default']]) {
    const refused = await run(args);
    assert.equal(refused.code, 2, args.join(' '));
    // commander prints its own line first; the Problem is the last line.
    assert.match(JSON.parse(refused.stderr.trim().split('\n').at(-1)!).error.message, /unknown option '--project'/, args.join(' '));
  }
  const reference = await run(['task', 'get', '--task', 'default/T1']);
  assert.equal(reference.code, 2);
  assert.deepEqual(JSON.parse(reference.stderr).error.issues.map((issue: { path: string }) => issue.path), ['task']);
  assert.equal(requests.length, before, 'nothing is sent');
  // The environment variable is no option at all: the command goes as if it were not set.
  assert.equal((await run(['task', 'list'], { ALPACAWORK_PROJECT: 'default' })).code, 0);
  assert.equal(requests.at(-1)?.url, '/api/task/list');
});

test('source precedence and malformed selected source fail without fallback', async () => {
  const selected = await run(['--server', origin, 'field', 'get'], { ALPACAWORK_SERVER: 'ftp://bad' });
  assert.equal(selected.code, 0);
  const before = requests.length;
  const invalid = await run(['field', 'get'], { ALPACAWORK_SERVER: 'http://remote.example' });
  assert.equal(invalid.code, 2);
  assert.equal(requests.length, before);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'invalid_input');
});

test('server show identifies all four sources without contacting a server', async () => {
  const xdg = await mkdtemp(join(tmpdir(), 'alpacawork-cli-xdg-'));
  const config = join(xdg, 'alpacawork');
  await mkdir(config);
  await writeFile(join(config, 'client.json'), JSON.stringify({ server: origin }));
  const env = { XDG_CONFIG_HOME: xdg, ALPACAWORK_SERVER: undefined };
  const before = requests.length;
  assert.deepEqual(JSON.parse((await run(['server', 'show'], env)).stdout),
    { server: origin, source: 'client.json' });
  assert.deepEqual(JSON.parse((await run(['server', 'show'], { ...env, ALPACAWORK_SERVER: 'https://example.com' })).stdout),
    { server: 'https://example.com', source: 'ALPACAWORK_SERVER' });
  assert.deepEqual(JSON.parse((await run(['--server', origin, 'server', 'show'],
    { ...env, ALPACAWORK_SERVER: 'not-a-url' })).stdout), { server: origin, source: '--server' });
  const fresh = await mkdtemp(join(tmpdir(), 'alpacawork-cli-xdg-'));
  assert.deepEqual(JSON.parse((await run(['server', 'show'], { ...env, XDG_CONFIG_HOME: fresh })).stdout),
    { server: DEFAULT_SERVER_ORIGIN, source: 'default' });
  assert.equal(requests.length, before);
  const invalid = await run(['server', 'show'], { ...env, ALPACAWORK_SERVER: 'http://example.com' });
  assert.equal(invalid.code, 2);
  assert.equal(requests.length, before);
});

test('server set verifies identity before saving, respects XDG, and unset removes saved value', async () => {
  const xdg = await mkdtemp(join(tmpdir(), 'alpacawork-cli-xdg-'));
  const env = { XDG_CONFIG_HOME: xdg, ALPACAWORK_SERVER: undefined };
  const config = join(xdg, 'alpacawork', 'client.json');
  const originalReply = reply;
  try {
    const unreachableBeforeSave = await run(['server', 'set', 'http://127.0.0.1:1'], env);
    assert.equal(unreachableBeforeSave.code, 2);
    await assert.rejects(stat(config), { code: 'ENOENT' });
    reply = { status: 200, body: { generation: 'd0ef4ad7-fda1-4c0c-aa02-231bbfd7dfba', root: '/tmp/example' } };
    const set = await run(['server', 'set', origin], env);
    assert.equal(set.code, 0, set.stderr);
    assert.equal(requests.at(-1)?.url, '/api/identity');
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { server: origin });
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    assert.equal((await stat(join(xdg, 'alpacawork'))).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse((await run(['server', 'show'], env)).stdout), { server: origin, source: 'client.json' });
    reply = { status: 200, body: { unrelated: true } };
    const wrong = await run(['server', 'set', 'http://127.0.0.1:' + new URL(origin).port], env);
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /invalid alpacawork identity/);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { server: origin });
    const malformed = await run(['server', 'set', 'http://example.com'], env);
    assert.equal(malformed.code, 2);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { server: origin });
    const unreachable = await run(['server', 'set', 'http://127.0.0.1:1'], env);
    assert.equal(unreachable.code, 2);
    assert.match(unreachable.stderr, /Server not reached/);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { server: origin });
    const unset = await run(['server', 'unset'], env);
    assert.equal(unset.code, 0, unset.stderr);
    assert.deepEqual(JSON.parse((await run(['server', 'show'], env)).stdout),
      { server: DEFAULT_SERVER_ORIGIN, source: 'default' });
  } finally { reply = originalReply; }
});

test('client config is used after env and malformed config blocks default', async () => {
  const dir = join(home, '.config', 'alpacawork');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'client.json'), JSON.stringify({ server: origin }));
  const before = requests.length;
  assert.equal((await run(['field', 'get'], { ALPACAWORK_SERVER: undefined })).code, 0);
  assert.equal(requests.length, before + 1);
  await writeFile(join(dir, 'client.json'), '{');
  assert.equal((await run(['field', 'get'], { ALPACAWORK_SERVER: undefined })).code, 2);
  assert.equal(requests.length, before + 1);
});

test('report reads local UTF-8 bytes but sends text with automatic or explicit op-id', async () => {
  const path = join(home, 'description.md');
  await writeFile(path, Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('あ\r\n')]));
  const noId = await run(['task', 'report', '--task', 'T1', '--state', 'doing', '--title', 'In progress',
    '--description-file', path, '--expected-task-hash', 'a'.repeat(64)]);
  assert.equal(noId.code, 0, noId.stderr);
  assert.match(String(requests.at(-1)?.headers['x-alpacawork-op-id']), /^[0-9a-f-]{36}$/);
  assert.equal(sent().opId, requests.at(-1)?.headers['x-alpacawork-op-id']);
  const result = await run(['task', 'report', '--task', 'T1', '--state', 'doing', '--title', 'In progress',
    '--description-file', path, '--expected-task-hash', 'a'.repeat(64), '--op-id', 'same-operation']);
  assert.equal(result.code, 0, result.stderr);
  const received = requests.at(-1)!;
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/api/task/report');
  assert.equal(received.headers['x-alpacawork-op-id'], 'same-operation');
  const body = JSON.parse(received.body.toString());
  assert.equal(body.description, '\ufeffあ\r\n');
  assert.equal(body.opId, 'same-operation');
  assert.equal(body.descriptionFile, undefined);
});

test('an instruction goes by task request and keeps its op-id during shared validation', async () => {
  const path = join(home, 'instruction.md');
  await writeFile(path, 'Start now');
  const result = await run(['task', 'request', '--task', 'T1', '--instruction-file', path,
    '--expected-task-hash', 'a'.repeat(64), '--expected-placement-revision', '1', '--op-id', 'request-1']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.at(-1)?.url, '/api/task/request');
  assert.equal(requests.at(-1)?.headers['x-alpacawork-op-id'], 'request-1');
  assert.deepEqual([sent().body, sent().opId], ['Start now', 'request-1']);
});

test('values, an instruction and a description each read stdin for -, and two options cannot both read it', async () => {
  const hash = ['--expected-task-hash', 'a'.repeat(64)];
  for (const [args, field] of [
    [['task', 'request', '--task', 'T1', '--instruction-file', '-', ...hash, '--expected-placement-revision', '1',
      '--op-id', 'stdin-instruction'], 'body'],
    [['task', 'report', '--task', 'T1', '--state', 'doing', '--title', 'Progress', '--description-file', '-', ...hash,
      '--op-id', 'stdin-description'], 'description'],
  ] as const) {
    const result = await run([...args], {}, `From stdin: ${field}\n`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(sent()[field], `From stdin: ${field}\n`, args.join(' '));
  }
  const values = await run(['task', 'update', '--task', 'T1', '--values-file', '-', ...hash, '--op-id', 'stdin-values'], {},
    '{"notes":"From stdin"}');
  assert.equal(values.code, 0, values.stderr);
  assert.deepEqual(sent().values, { notes: 'From stdin' });
  const before = requests.length;
  const both = await run(['task', 'new', '--title', 'Two stdins', '--parent', 'T1', '--values-file', '-', '--plan-file', '-',
    '--op-id', 'stdin-both'], {}, 'text');
  assert.equal(both.code, 2);
  assert.match(JSON.parse(both.stderr).error.message, /Only one option can read stdin/);
  assert.equal(requests.length, before);
});

test('Run token pair, direct actor, and workspace rejection', async () => {
  const token = 'a'.repeat(64);
  assert.equal((await run(['run', 'get', '--run', 'R1'], { ALPACAWORK_RUN: 'R1' })).code, 2);
  assert.equal((await run(['run', 'get', '--run', 'R1'], { ALPACAWORK_RUN: 'R1', ALPACAWORK_RUN_TOKEN: token })).code, 0);
  assert.equal(requests.at(-1)?.headers.authorization, `Alpacawork-Run R1:${token}`);
  assert.equal((await run(['field', 'get'], { CODEX_THREAD_ID: 'abc' })).code, 0);
  assert.equal(requests.at(-1)?.headers['x-alpacawork-provider'], 'codex');
  assert.equal((await run(['--workspace', '/tmp/x', 'field', 'get'])).code, 2);
});

test('file put sends exact bytes; get writes exact bytes', async () => {
  const input = join(home, 'input.bin'), output = join(home, 'output.bin');
  const bytes = Buffer.from([0, 255, 13, 10]);
  await writeFile(input, bytes);
  const put = await run(['task', 'file', 'put', '--task', 'T1', '--path', 'work/image.bin',
    '--file', input, '--op-id', 'put-1']);
  assert.equal(put.code, 0);
  assert.equal(requests.at(-1)?.method, 'PUT');
  assert.equal(requests.at(-1)?.url, '/api/tasks/T1/file?path=work%2Fimage.bin');
  assert.deepEqual(requests.at(-1)?.body, bytes);
  const get = await run(['task', 'file', 'get', '--task', 'T1', '--path', 'work/image.bin', '--output', output]);
  assert.equal(get.code, 0);
  assert.deepEqual(await readFile(output), bytes);
  const before = requests.length;
  assert.equal((await run(['task', 'file', 'put', '--task', 'T1', '--path', '../bad',
    '--file', input, '--op-id', 'bad-path'])).code, 2);
  assert.equal(requests.length, before);
});

test('attachment put sends bytes and request identity to its separate route', async () => {
  const input = join(home, 'attach.bin');
  const bytes = Buffer.from([1, 0, 255]);
  await writeFile(input, bytes);
  const put = await run(['task', 'attachment', 'put', '--task', 'T1', '--request-id', 'Q1',
    '--name', 'attach.bin', '--file', input, '--op-id', 'attach-1']);
  assert.equal(put.code, 0, put.stderr);
  assert.equal(requests.at(-1)?.url, '/api/tasks/T1/attachments?requestId=Q1&name=attach.bin');
  assert.deepEqual(requests.at(-1)?.body, bytes);
  assert.equal(requests.at(-1)?.headers['x-alpacawork-op-id'], 'attach-1');
});

test('server Problem, partial success and incomplete result map to 2, 4 and 3', async () => {
  reply = { status: 409, body: { error: { code: 'conflict', message: 'Changed', retry: 'reread' } } };
  assert.equal((await run(['field', 'get'])).code, 2);
  reply = { status: 200, body: { errors: [{ code: 'x' }] } };
  assert.equal((await run(['field', 'get'])).code, 4);
  reply = { status: 200, body: null, raw: '{' };
  const incomplete = await run(['field', 'get']);
  assert.equal(incomplete.code, 3);
  assert.equal(JSON.parse(incomplete.stderr).error.retry, 'check');
  reply = { status: 200, body: { errors: [] } };
});
