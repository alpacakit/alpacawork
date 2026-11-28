import { commandFetchWith } from './helpers/command-fetch.ts';
import { fetchBuffered } from './helpers/buffered-http.ts';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { test } from 'node:test';
import { get as httpGet } from 'node:http';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { readTaskFile, openTaskFile, saveTaskAttachment, TaskFileIndex } from '@alpacawork/backend/test-dist/control/task-files.js';
import { attachmentBytes, DEFAULT_LIMITS } from '@alpacawork/contract';
import { RunStore } from '@alpacawork/runs';
import { attachmentResultSchema } from '@alpacawork/contract/control';
import { validTaskFileName } from '@alpacawork/contract/inputs';
import { readControlTree } from './helpers/control-tree.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { FileJournal } from '@alpacawork/backend/test-dist/control/file-journal.js';
import { fileDigest } from '@alpacawork/backend/test-dist/control/file-journal.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { createFixtureRun } from './helpers/run-fixture.ts';

/** The test project (`project`) and a Task below it whose folder, tasks/<T>, the test fills. */
async function fixture(t: { after: (fn: () => Promise<void> | void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-task-files-')));
  const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];
  t.after(async () => {
    const closed = await Promise.allSettled(servers.map(server => server.close()));
    rmSync(root, { recursive: true, force: true });
    const failed = closed.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });
  const writer = new FileWriter(root);
  writeFileSync(join(root, 'config.yaml'), 'agents: {}\n');
  let project: string;
  try { project = initializeControlFixture(root); } finally { writer.close(); }
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: null, tasks: [{ title: 'Files' }] })).tasks[0];
  const folder = join(root, new FileJournal(root).taskLocation(task.id).folder);
  assert.equal(folder, join(root, 'tasks', task.id));
  mkdirSync(folder, { recursive: true });
  const start = async (options?: Parameters<typeof startServer>[2]) => {
    const server = await startServer(root, 0, options);
    servers.push(server);
    return server;
  };
  return { root, project, task, folder, start };
}
/** The fixture Task's files, as the tree lists them. */
const filesOf = async (root: string, task: { id: string }) =>
  (await readControlTree(root)).tasks.find(item => item.id === task.id)!.files!;

const fileUrl = (base: string, task: string, name: string) =>
  new URL(`/api/tasks/${task}/file?path=${encodeURIComponent(name)}`, base);
const operation = () => ({ 'X-Alpacawork-Op-Id': globalThis.crypto.randomUUID() });
const MAX_ATTACHMENT_BYTES = attachmentBytes(DEFAULT_LIMITS);
const MiB = 1024 * 1024;

/** A running responsible Run of `task`, placed before serve starts, and its credential's header. */
function runningOn(root: string, task: string) {
  const placements = new PlacementStore(root);
  const agent = placements.createAgent('File agent');
  const placement = placements.place({ taskId: task, agentId: agent.id, profileKey: 'codex', responsible: true });
  placements.close();
  const runs = new RunStore(root, { busyTimeoutMs: 0 });
  const run = runs.write(tx => {
    const created = createFixtureRun(runs, tx, { task, placementId: placement.id,
      requestId: globalThis.crypto.randomUUID(), agent: 'codex', role: 'owner', resumes: null,
      continues: false, session: null, caller: null, cwd: root,
      launch: { adapter: 'codex', env: [], argv: ['unused'],
        path: '/bin', values: {} } }, 'prompt');
    const running = { ...created, state: 'running' as const, started_at: new Date().toISOString() };
    tx.update(running);
    return running;
  });
  runs.close();
  return { id: run.id,
    auth: { authorization: `Alpacawork-Run ${run.id}:${issueRunCredential(root, run.id)}` } };
}

test('a Run credential changes files only on its current Task', async t => {
  const { root, project, task: own, start } = await fixture(t);
  const other = (await new ControlTaskCommands(root, { kind: 'human' }).create({
    parentId: project, userRequested: null, tasks: [{ title: 'Other Task' }],
  })).tasks[0];
  const { auth } = runningOn(root, own.id);
  const server = await start();
  const put = (id: string, headers: Record<string, string>) => fetch(fileUrl(server.url, id, 'result.txt'), {
    method: 'PUT', headers: { ...operation(), 'X-Alpacawork-Content-Digest': fileDigest(Buffer.from('result')), ...headers },
    body: 'result',
  });
  assert.equal((await put(own.id, auth)).status, 200);
  assert.equal((await put(other.id, auth)).status, 403);
  assert.equal((await put(other.id, {})).status, 200, 'a person writes the files of any Task');
  const attachment = (id: string) => new URL(`/api/tasks/${id}/attachments?requestId=draft1&name=a.txt`, server.url);
  assert.equal((await fetch(attachment(other.id), { method: 'POST', headers: operation(), body: 'attached' })).status, 200);
  for (const [url, method, body] of [
    [attachment(other.id), 'POST', 'another'],
    [new URL('/api/commands/task/attachment/remove', server.url), 'POST', JSON.stringify({ task: other.id, requestId: 'draft1', name: 'a.txt' })],
    [new URL('/api/commands/task/attachment/move', server.url), 'POST', JSON.stringify({ task: other.id, from: 'draft1', to: 'draft2' })],
  ] as const) {
    const response = await fetch(url, { method, headers: { ...operation(), ...auth, 'Content-Type': url.pathname.startsWith('/api/commands/') ? 'application/json' : 'application/octet-stream' }, body });
    assert.equal(response.status, 403, `${method} ${url.pathname}`);
  }
  assert.equal((await fetch(fileUrl(server.url, other.id, 'attachments/draft1/a.txt'))).status, 200);
});

test('an upload whose caller stops being one while its bytes came writes nothing: it is identified again where it is reserved', async t => {
  const { root, task, start } = await fixture(t);
  const run = runningOn(root, task.id);
  const server = await start();
  const bytes = Buffer.from('late result');
  let send!: (chunk: Uint8Array | null) => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    send = chunk => chunk === null ? controller.close() : controller.enqueue(chunk);
  } });
  const response = fetch(fileUrl(server.url, task.id, 'late.txt'), { method: 'PUT', body, duplex: 'half',
    headers: { ...operation(), ...run.auth, 'X-Alpacawork-Content-Digest': fileDigest(bytes) } } as RequestInit);
  send(bytes.subarray(0, 4));
  // The write was let in before its bytes. While the rest is still to come, the workspace's Run credentials are
  // renewed, so that this one names no Run any more (as a Run that ended names no current placement).
  await new Promise(resolve => setTimeout(resolve, 200));
  rmSync(join(root, '.alpacawork', 'run-credential.key'));
  issueRunCredential(root, run.id);
  send(bytes.subarray(4));
  send(null);
  assert.equal((await response).status, 403);
  assert.equal(existsSync(join(root, 'tasks', task.id, 'late.txt')), false);
});

test('managed text files share gzip compression and keep safe response types and cache validators', async t => {
  const { task, folder, start } = await fixture(t);
  const text = '<h1>Untrusted text</h1><script>globalThis.fileScriptRan = true</script>\n'.repeat(80);
  const server = await start();
  for (const [name, type] of [
    ['change.diff', 'text/plain'], ['change.PATCH', 'text/plain'], ['data.json', 'application/json'],
    ['data.csv', 'text/csv'], ['data.tsv', 'text/tab-separated-values'], ['output.log', 'text/plain'],
    ['source.ts', 'text/plain'], ['source.tsx', 'text/plain'], ['script.js', 'text/plain'],
    ['page.HTML', 'text/plain'], ['image.svg', 'text/plain'], ['unknown.bin', 'application/octet-stream'],
  ]) {
    writeFileSync(join(folder, name), text);
    const binary = type === 'application/octet-stream';
    const url = fileUrl(server.url, task.id, name);
    const response = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), binary ? type : `${type}; charset=utf-8`, name);
    assert.equal(response.headers.get('content-encoding'), binary ? null : 'gzip', name);
    assert.match(response.headers.get('etag')!, binary ? /^"[^"]+"$/ : /^W\/"[^"]+"$/, name);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', name);
    assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'", name);
    assert.equal(response.headers.get('cache-control'), 'private, no-cache', name);
    assert.equal(await response.text(), text, name);
    assert.equal(readFileSync(join(folder, name), 'utf8'), text, name);
  }

  const log = fileUrl(server.url, task.id, 'output.log');
  const identity = await fetch(log, { headers: { 'Accept-Encoding': 'identity' } });
  const compressed = await fetch(log, { headers: { 'Accept-Encoding': 'gzip' } });
  const etag = identity.headers.get('etag');
  assert.match(etag!, /^"[^"]+"$/);
  assert.equal(identity.headers.get('content-length'), String(Buffer.byteLength(text)));
  assert.equal(compressed.headers.get('etag'), `W/${etag}`);
  const vary = compressed.headers.get('vary')!;
  assert.deepEqual(vary.toLowerCase().split(/,\s*/).sort(), [
    'accept-encoding', 'authorization', 'x-alpacawork-conversation', 'x-alpacawork-provider',
  ]);

  const unchanged = await fetch(log, { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': `W/${etag}` } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get('etag'), etag);
  assert.equal(unchanged.headers.get('vary'), vary);

  log.searchParams.set('download', '1');
  const partial = await fetch(log, { headers: { 'Accept-Encoding': 'gzip', Range: 'bytes=0-2047', 'If-Range': etag! } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-encoding'), null);
  assert.equal(partial.headers.get('etag'), etag);
  assert.equal(await partial.text(), text.slice(0, 2048));
});

test('Task file URLs use the listing revision to cache originals and revalidate only that version', async t => {
  const { task, folder, start } = await fixture(t);
  const original = 'original bytes', changed = 'modified bytes';
  for (const name of ['note.txt', 'clip.mp4']) writeFileSync(join(folder, name), original);
  const server = await start();
  const view = await fetch(new URL(`/api/task/view?task=${task.id}`, server.url));
  assert.equal(view.status, 200);
  const { task: { files } } = await view.json() as { task: { files: Array<{ name: string; revision: string }> } };
  assert.deepEqual(files.map(file => file.name), ['clip.mp4', 'note.txt']);
  for (const { name, revision } of files) {
    const url = fileUrl(server.url, task.id, name);
    url.searchParams.set('v', revision);
    for (const download of [false, true]) {
      if (download) url.searchParams.set('download', '1');
      const response = await fetch(url);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('etag'), `"${revision}"`, name);
      assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable', name);
      assert.equal(await response.text(), original, name);

      const unchanged = await fetch(url, { headers: { 'If-None-Match': `"${revision}"` } });
      assert.equal(unchanged.status, 304, name);
      assert.equal(await unchanged.text(), '', name);
      assert.equal(unchanged.headers.get('etag'), `"${revision}"`, name);
      assert.equal(unchanged.headers.get('cache-control'), response.headers.get('cache-control'), name);
      for (const header of ['content-type', 'content-disposition', 'content-security-policy', 'content-length'])
        assert.equal(unchanged.headers.get(header), null, `${name} ${header}`);
    }
    url.searchParams.delete('download');
    writeFileSync(join(folder, name), changed);
    const current = await fetch(url, { headers: { 'If-None-Match': `"${revision}"` } });
    assert.equal(current.status, 200, name);
    assert.notEqual(current.headers.get('etag'), `"${revision}"`, name);
    assert.equal(current.headers.get('cache-control'), 'private, no-cache', name);
    assert.equal(await current.text(), changed, name);
  }
});

test('streaming a Task video finishes the opened file after its path is replaced', async t => {
  const { root, task, folder, start } = await fixture(t);
  const path = join(folder, 'clip.mp4'), replacement = join(folder, 'replacement.mp4');
  // Keep the file larger than the socket buffers so replacement happens before the last read.
  const original = Buffer.alloc(8 * MiB, 0x61);
  writeFileSync(path, original);
  writeFileSync(replacement, 'replacement');
  const revision = (await filesOf(root, task)).find(file => file.name === 'clip.mp4')!.revision;
  const server = await start();
  const url = fileUrl(server.url, task.id, 'clip.mp4');
  url.searchParams.set('v', revision);

  const response = await globalThis.fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), `"${revision}"`);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  try {
    const first = await reader.read();
    assert.ok(first.value?.length);
    chunks.push(first.value);
    renameSync(replacement, path);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  assert.deepEqual(Buffer.concat(chunks), original);

  const next = await fetch(url);
  assert.notEqual(next.headers.get('etag'), `"${revision}"`);
  assert.equal(await next.text(), 'replacement');
});

test('a file route takes only its own query: an old ?project= is refused, never read past', async t => {
  const { root, task, start } = await fixture(t);
  writeFileSync(join(root, 'tasks', task.id, 'kept.txt'), 'kept');
  const server = await start();
  const file = (query: string) => new URL(`/api/tasks/${task.id}/file?path=kept.txt${query}`, server.url);
  assert.equal((await fetch(file('&v=1'))).status, 200, 'a reader\'s revision is its own parameter');
  // `part=head` is a diff's header alone, and is taken for a diff file only.
  writeFileSync(join(root, 'tasks', task.id, 'a.diff'), '# alpacawork-diff 1\n# source {}\ndiff --git a/x b/x\n');
  const head = await fetch(new URL(`/api/tasks/${task.id}/file?path=a.diff&part=head`, server.url));
  assert.deepEqual([head.status, await head.text()], [200, '# alpacawork-diff 1\n# source {}\n']);
  assert.equal(head.headers.get('cache-control'), 'no-store');
  assert.equal(head.headers.get('etag'), null);
  for (const query of ['&part=head', '&part=rows']) assert.equal((await fetch(file(query))).status, 400, query);
  const refused = await fetch(file('&project=web'));
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error.message, /project/);
  const put = await fetch(file('&project=web'), { method: 'PUT', body: 'other',
    headers: { ...operation(), 'X-Alpacawork-Content-Digest': fileDigest(Buffer.from('other')) } });
  assert.equal(put.status, 400);
  assert.equal(readFileSync(join(root, 'tasks', task.id, 'kept.txt'), 'utf8'), 'kept');
  const attachment = await fetch(new URL(`/api/tasks/${task.id}/attachments?requestId=draft1&name=a.txt&project=web`, server.url),
    { method: 'POST', headers: operation(), body: 'attached' });
  assert.equal(attachment.status, 400);
  assert.equal(existsSync(join(root, 'tasks', task.id, 'attachments')), false);
});

test('a Run reaches no entry of the screen, and reads a saved operation only of its own project\'s Tasks', async t => {
  const { root, task: own, start } = await fixture(t);
  // P1 is the root project: a Task right below it belongs to another project than the Run's.
  const outside = (await new ControlTaskCommands(root, { kind: 'human' }).create({
    parentId: 'P1', userRequested: null, tasks: [{ title: 'Elsewhere' }] })).tasks[0];
  const run = runningOn(root, own.id);
  const server = await start();
  const call = (path: string, headers: Record<string, string>, body?: unknown) => fetch(new URL(path, server.url),
    body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
  const settings = await (await call('/api/commands/settings/get', {})).json();
  for (const [path, body] of [['/api/commands/settings/get', undefined],
    ['/api/commands/settings/set', { key: 'push.awayAfter', value: '10', expectedRevision: settings.revision }],
    ['/api/person/notices', undefined], ['/api/person/notices/save', { state: {}, expectedRevision: null }],
    ['/api/notify/devices', undefined], ['/api/notify/unsubscribe', { id: 'device' }], ['/api/presence/away', {}]] as const)
    assert.equal((await call(path, run.auth, body)).status, 403, path);
  assert.equal((await call('/api/commands/settings/get', {})).status, 200, 'a person\'s screen reads them');
  const putOn = async (task: string, headers: Record<string, string>) => {
    const opId = globalThis.crypto.randomUUID();
    const response = await fetch(fileUrl(server.url, task, 'saved.txt'), { method: 'PUT', body: 'saved',
      headers: { 'X-Alpacawork-Op-Id': opId, 'X-Alpacawork-Content-Digest': fileDigest(Buffer.from('saved')), ...headers } });
    assert.equal(response.status, 200);
    return opId;
  };
  const elsewhere = await putOn(outside.id, {}), mine = await putOn(own.id, run.auth);
  const receipt = (opId: string, headers: Record<string, string>) => call(`/api/commands/operation/get?opId=${opId}`, headers);
  assert.equal((await receipt(elsewhere, run.auth)).status, 403, 'another project\'s Task is read by no Run of this one');
  assert.equal((await (await receipt(mine, run.auth)).json()).state, 'committed');
  assert.equal((await (await receipt(elsewhere, {})).json()).state, 'committed', 'a person reads every receipt');
});

test('existing file URLs remain readable through archive, restore and delete', async t => {
  const { root, task, start } = await fixture(t);
  const server = await start();
  const url = fileUrl(server.url, task.id, 'result.txt');
  const put = () => fetch(url, { method: 'PUT', headers: {
    ...operation(), 'X-Alpacawork-Content-Digest': fileDigest(Buffer.from('kept')),
  }, body: 'kept' });
  assert.equal((await put()).status, 200);
  const video = fileUrl(server.url, task.id, 'clip.mp4');
  const videoBytes = Buffer.from('0000ftypisom0123');
  assert.equal((await fetch(video, { method: 'PUT', headers: {
    ...operation(), 'X-Alpacawork-Content-Digest': fileDigest(videoBytes),
  }, body: new Uint8Array(videoBytes) })).status, 200);
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const archived = (await commands.lifecycle({ id: task.id, action: 'archive', expectedTaskHash: task.hash })).task;
  assert.equal(await (await fetch(url)).text(), 'kept');
  const ranged = await fetch(video, { headers: { range: 'bytes=4-7' } });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), 'ftyp');
  assert.notEqual((await put()).status, 200, 'archive still blocks writes');
  const restored = (await commands.lifecycle({ id: task.id, action: 'restore', expectedTaskHash: archived.hash })).task;
  assert.equal(await (await fetch(url)).text(), 'kept');
  await commands.lifecycle({ id: task.id, action: 'delete', expectedTaskHash: restored.hash });
  assert.equal(await (await fetch(url)).text(), 'kept');
  assert.notEqual((await put()).status, 200, 'deleted Task still blocks writes');
});

test('files placed in a Task folder appear without a report, including nested and old files/ copies', async t => {
  const { root, task, folder, start } = await fixture(t);
  mkdirSync(join(folder, 'notes'));
  mkdirSync(join(folder, 'files'));
  writeFileSync(join(folder, 'notes', 'plan.md'), '# Plan');
  writeFileSync(join(folder, 'notes', 'index.md'), '# Notes');
  writeFileSync(join(folder, 'files', 'old.png'), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(folder, 'data.csv'), 'one,two');
  const tree = await readControlTree(root);
  const listed = tree.tasks.find(item => item.id === task.id)!;
  assert.deepEqual(listed.files!.map(file => file.name), ['data.csv', 'files/old.png', 'notes/index.md', 'notes/plan.md']);
  assert.equal(listed.log.some(entry => entry.kind === 'reported'), false);
  assert.equal((await readTaskFile(root, task.id, 'notes/plan.md')).toString(), '# Plan');
  assert.equal((await readTaskFile(root, task.id, 'notes/index.md')).toString(), '# Notes');
  const server = await start();
  const url = fileUrl(server.url, task.id, 'notes/plan.md');
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '# Plan');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(fileUrl(server.url, task.id, 'data.csv'))).headers.get('content-type'), 'text/csv; charset=utf-8');
  writeFileSync(join(folder, 'notes', 'plan.md'), '# Revised');
  assert.notEqual((await filesOf(root, task)).find(file => file.name === 'notes/plan.md')!.revision,
    listed.files!.find(file => file.name === 'notes/plan.md')!.revision);
  assert.equal((await readTaskFile(root, task.id, 'notes/plan.md')).toString(), '# Revised');
});

test('an HTML page is only a page in a sandboxed frame: as a file it stays text, as a frame it runs with no origin', async t => {
  const { root, task, folder, start } = await fixture(t);
  mkdirSync(join(folder, 'review'));
  writeFileSync(join(folder, 'review', 'index.html'), '<p>page</p>');
  const server = await start();
  const file = fileUrl(server.url, task.id, 'review/index.html');
  const plain = await fetch(file);
  assert.equal(plain.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(plain.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  file.searchParams.set('frame', '1');
  const framed = await fetch(file);
  assert.equal(framed.headers.get('content-type'), 'text/html; charset=utf-8');
  const policy = framed.headers.get('content-security-policy')!;
  assert.match(policy, /^sandbox allow-scripts;/);
  assert.doesNotMatch(policy, /allow-same-origin|connect-src|'self';? img-src|img-src[^;]*'self'/);
  assert.match(policy, /form-action 'none'/);
  const text = await framed.text();
  assert.ok(text.endsWith('<p>page</p>'));
  assert.match(text, /^<script>.*alpacaworkFrame.*height.*<\/script>/s);
  const screen = await fetch(new URL('/', server.url));
  assert.match(screen.headers.get('content-security-policy') ?? '', /frame-src 'self'/);
});

test('HTTP video serves WebM and MP4 with byte ranges, while ordinary files keep the attachment limit', async t => {
  const { root, task, folder, start } = await fixture(t);
  const webm = Buffer.alloc(MAX_ATTACHMENT_BYTES + 9);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(webm);
  Buffer.from('video-end').copy(webm, webm.length - 9);
  writeFileSync(join(folder, 'movie.webm'), webm);
  writeFileSync(join(folder, 'movie.mp4'), Buffer.from('0000ftypisom0123'));
  writeFileSync(join(folder, 'large.txt'), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
  const server = await start();
  const url = (name: string) => fileUrl(server.url, task.id, name);
  const first = await fetch(url('movie.webm'), { headers: { range: 'bytes=0-3' } });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-type'), 'video/webm');
  assert.equal(first.headers.get('content-range'), `bytes 0-3/${webm.length}`);
  assert.equal(first.headers.get('content-length'), '4');
  assert.equal(first.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), webm.subarray(0, 4));
  const tail = await fetch(url('movie.webm'), { headers: { range: 'bytes=-9' } });
  assert.equal(tail.status, 206);
  assert.equal(await tail.text(), 'video-end');
  const mp4 = await fetch(url('movie.mp4'), { headers: { range: 'bytes=4-' } });
  assert.equal(mp4.status, 206);
  assert.equal(mp4.headers.get('content-type'), 'video/mp4');
  assert.equal(await mp4.text(), 'ftypisom0123');
  const full = await fetch(url('movie.mp4'));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '16');
  assert.equal(await full.text(), '0000ftypisom0123');
  for (const range of [`bytes=${webm.length}-`, 'bytes=3-2', 'bytes=0-1,3-4', 'bytes=-0']) {
    const response = await fetch(url('movie.webm'), { headers: { range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${webm.length}`);
  }
  assert.equal((await fetch(url('large.txt'))).status, 413);
  const screen = await fetch(new URL('/', server.url));
  assert.match(screen.headers.get('content-security-policy') ?? '', /media-src 'self'/);
});

test('HTTP video rejects traversal and the wrong Task folder', async t => {
  const { root, task, folder, start } = await fixture(t);
  writeFileSync(join(folder, 'safe.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const server = await start();
  for (const name of ['..%2Foutside.webm']) {
    const response = await fetch(fileUrl(server.url, task.id, name));
    assert.notEqual(response.status, 200, name);
  }
  await assert.rejects(openTaskFile(root, 'T99999', 'safe.webm'),
    (error: { code: string }) => error.code === 'not_found');
});

test('a child Task serves files by its T number from its own folder', async t => {
  const { root, task: parent, start } = await fixture(t);
  // A task with children keeps its responsible.
  const people = new PlacementStore(root);
  try { people.createAndPlace({ taskId: parent.id, profileKey: 'codex', responsible: true }); } finally { people.close(); }
  const created = (await new ControlTaskCommands(root, { kind: 'human' }).create({
    parentId: parent.id, userRequested: false, tasks: [{ title: 'Child files' }], expectedParentHash: parent.hash,
  })).tasks[0];
  const childFolder = new FileJournal(root).taskLocation(created.id).folder;
  mkdirSync(join(root, childFolder), { recursive: true });
  writeFileSync(join(root, childFolder, 'note.txt'), 'Child note');
  const tree = await readControlTree(root);
  const child = tree.tasks.find(task => task.id === created.id)!;
  assert.match(child.id, /^T[1-9][0-9]*$/);
  assert.equal(child.path, childFolder);
  assert.deepEqual(tree.tasks.find(task => task.id === child.id)?.files?.map(file => file.name), ['note.txt']);
  assert.equal((await readTaskFile(root, child.id, 'note.txt')).toString(), 'Child note');
  const server = await start();
  const response = await fetch(fileUrl(server.url, child.id, 'note.txt'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'Child note');
});

test('task file reading rejects traversal, index.md and oversized content', async t => {
  const { root, task, folder } = await fixture(t);
  const outside = join(root, 'outside.md');
  writeFileSync(outside, 'secret');
  mkdirSync(join(folder, 'nested'));
  writeFileSync(join(folder, 'nested', 'good.md'), 'safe');
  symlinkSync(outside, join(folder, 'link.md'));
  symlinkSync(root, join(folder, 'escape'));
  writeFileSync(join(folder, 'large.md'), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
  for (const name of ['index.md', '../outside.md', '/outside.md', 'nested/../index.md'])
    await assert.rejects(readTaskFile(root, task.id, name), name);
  await assert.rejects(readTaskFile(root, task.id, 'large.md'), (error: { code: string }) => error.code === 'too_large');
  assert.deepEqual((await filesOf(root, task)).map(file => file.name), ['large.md', 'nested/good.md']);
});

test('HTTP attachments share a request folder, deduplicate bytes, resolve names, and remove only before send', async t => {
  const { root, task, folder, start } = await fixture(t);
  const publicHost = 'fixture.tailnet.example';
  const server = await start({ publicHost });
  const requestId = 'draft-request-1';
  const upload = (name: string, bytes: Buffer, id = operation()) => fetch(new URL(`/api/tasks/${task.id}/attachments?requestId=${requestId}&name=${encodeURIComponent(name)}`, server.url),
    { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...id }, body: new Uint8Array(bytes) });
  const bytes = Buffer.from([0, 1, 255, 42]);
  const identity = operation();
  const first = await upload('shot.png', bytes, identity);
  assert.equal(first.status, 200);
  const saved = attachmentResultSchema.parse(await first.json());
  assert.equal(saved.path, `attachments/${requestId}/shot.png`);
  assert.equal(saved.absolutePath, fileUrl(server.url, task.id, saved.path).href);
  assert.equal(saved.size, bytes.length);
  assert.deepEqual(readFileSync(join(folder, saved.path)), bytes);

  const lookup = new URL('/api/commands/operation/get', server.url);
  lookup.searchParams.set('opId', identity['X-Alpacawork-Op-Id']);
  const receipt = await new Promise<unknown>((resolve, reject) => {
    httpGet(lookup, { headers: { Host: publicHost } }, async response => {
      try {
        assert.equal(response.statusCode, 200);
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (error) { reject(error); }
    }).on('error', reject);
  });
  assert.deepEqual(receipt, { state: 'committed', status: 200,
    body: { ...saved, absolutePath: fileUrl('https://' + publicHost, task.id, saved.path).href } });
  const second = attachmentResultSchema.parse(await (await upload('shot.png', bytes)).json());
  assert.equal(saved.path, second.path);
  const collision = attachmentResultSchema.parse(await (await upload('shot.png', Buffer.from('different'))).json());
  assert.equal(collision.path, `attachments/${requestId}/shot-2.png`);
  const view = await (await fetch(new URL(`/api/task/view?task=${task.id}`, server.url))).json() as { task: { files?: { name: string }[] } };
  assert.deepEqual(view.task.files?.map(item => item.name).sort(),
    [saved.path, collision.path].sort());
  assert.deepEqual((await filesOf(root, task)).map(item => item.name).sort(),
    [saved.path, collision.path].sort());
  assert.deepEqual(Buffer.from(await (await fetch(fileUrl(server.url, task.id, saved.path))).arrayBuffer()), bytes);
  const removed = await fetch(new URL('/api/commands/task/attachment/remove', server.url), { method: 'POST',
    headers: { ...operation(), 'Content-Type': 'application/json' }, body: JSON.stringify({ task: task.id, requestId, name: 'shot-2.png' }) });
  assert.equal(removed.status, 200);
  assert.equal(existsSync(join(folder, collision.path)), false);
  assert.equal(existsSync(join(folder, saved.path)), true);
  // The same size is not the same file: only files of the new one's size are read and compared.
  const sameSize = attachmentResultSchema.parse(await (await upload('shot.png', Buffer.from([0, 1, 255, 43]))).json());
  assert.equal(sameSize.path, `attachments/${requestId}/shot-2.png`);
  assert.deepEqual(readFileSync(join(folder, saved.path)), bytes);
});

test('HTTP attachment names are safe, oversized uploads leave nothing, and origin and Task checks apply', async t => {
  const { root, task, folder, start } = await fixture(t);
  const server = await start();
  const upload = (id: string, name: string, bytes: Buffer, origin?: string) =>
    fetch(new URL(`/api/tasks/${id}/attachments?requestId=draft-request-2&name=${encodeURIComponent(name)}`, server.url),
      { method: 'POST', headers: { ...operation(), ...(origin ? { origin } : {}) }, body: new Uint8Array(bytes) });
  for (const [input, expected] of [['../x', 'x'], ['some\u0001name.txt', 'some_name.txt'],
    ['.' + 'あ'.repeat(70) + '.png', null]] as const) {
    const response = await upload(task.id, input, Buffer.from(input));
    assert.equal(response.status, 200);
    const saved = attachmentResultSchema.parse(await response.json());
    const name = saved.path.split('/').at(-1)!;
    if (expected) assert.equal(name, expected);
    else { assert(name.startsWith('_')); assert(name.endsWith('.png')); assert(Buffer.byteLength(name) <= 100); }
    assert(validTaskFileName(name));
  }
  const before = (await filesOf(root, task)).map(file => file.name);
  const oversized = await upload(task.id, 'too-large.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
  assert.equal(oversized.status, 413);
  assert.equal((await filesOf(root, task)).map(file => file.name).join('|'), before.join('|'));
  assert.equal((await upload('T999999', 'absent.txt', Buffer.from('a'))).status, 404);
  assert.equal((await upload(task.id, 'foreign.txt', Buffer.from('a'), 'https://other.example')).status, 403);
  assert.equal(existsSync(join(folder, 'attachments', 'foreign.txt')), false);
});

test('the attachment limit is limits.attachment_mib: 50 MiB by default, and a changed setting applies to the next file', async t => {
  const { root, task, folder, start } = await fixture(t);
  const server = await start();
  assert.equal(MAX_ATTACHMENT_BYTES, 50 * MiB);
  const attach = (name: string, bytes: Buffer) => fetch(new URL(`/api/tasks/${task.id}/attachments?requestId=draft-limit&name=${name}`, server.url),
    { method: 'POST', headers: operation(), body: new Uint8Array(bytes) });
  const put = (name: string, bytes: Buffer) => fetch(fileUrl(server.url, task.id, name), { method: 'PUT',
    headers: { ...operation(), 'X-Alpacawork-Content-Digest': fileDigest(bytes) }, body: new Uint8Array(bytes) });
  const refusal = async (response: Response) =>
    ({ status: response.status, message: ((await response.json()) as { error: { message: string } }).error.message });
  // Every route reads the setting's limit as the refusals below show, so files just over the lower setting stand for
  // the default's large ones without sending tens of MiB.
  const recording = Buffer.alloc(2 * MiB, 7);
  assert.equal((await attach('recording.bin', recording)).status, 200);
  assert.equal((await put('notes/recording.bin', recording)).status, 200);
  assert.equal((await fetch(fileUrl(server.url, task.id, 'notes/recording.bin'))).status, 200);
  assert.equal((await readControlTree(root)).attachmentBytes, 50 * MiB);

  writeFileSync(join(root, 'config.yaml'), 'limits: {attachment_mib: 1}\nagents: {}\n');
  assert.equal((await readControlTree(root)).attachmentBytes, MiB);
  assert.deepEqual(await refusal(await attach('two.bin', Buffer.alloc(2 * MiB))), { status: 413, message: 'File exceeds 1 MiB' });
  assert.deepEqual(await refusal(await put('notes/two.bin', Buffer.alloc(2 * MiB))), { status: 413, message: 'File exceeds 1 MiB' });
  await assert.rejects(saveTaskAttachment(root, task.id, 'draft-limit', 'two.bin', Buffer.alloc(2 * MiB),
    globalThis.crypto.randomUUID(), () => ({ actor: { kind: 'human' }, task: task.id })),
  { code: 'too_large', message: 'File exceeds 1 MiB' });
  // The screen opens no more than the setting; a lower one never blocks removing a file saved under a higher one.
  assert.deepEqual(await refusal(await fetch(fileUrl(server.url, task.id, 'notes/recording.bin'))), { status: 413, message: 'File exceeds 1 MiB' });
  assert.equal((await fetch(new URL('/api/commands/task/attachment/remove', server.url), { method: 'POST',
    headers: { ...operation(), 'Content-Type': 'application/json' }, body: JSON.stringify({ task: task.id, requestId: 'draft-limit', name: 'recording.bin' }) })).status, 200);
  assert.equal(existsSync(join(folder, 'attachments/draft-limit/recording.bin')), false);

  writeFileSync(join(root, 'config.yaml'), 'limits: {attachment_mib: 3}\nagents: {}\n');
  assert.equal((await attach('two.bin', Buffer.alloc(2 * MiB))).status, 200);
});

test('a refused draft moves its attachment folder to a fresh request ID', async t => {
  const { root, task, folder, start } = await fixture(t);
  const server = await start();
  const bytes = Buffer.from('draft content');
  const saved = attachmentResultSchema.parse(await (await fetch(new URL(`/api/tasks/${task.id}/attachments?requestId=old-draft&name=note.txt`, server.url),
    { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...operation() }, body: new Uint8Array(bytes) })).json());
  const moveOperation = operation();
  const response = await fetch(new URL('/api/commands/task/attachment/move', server.url), { method: 'POST',
    headers: { 'content-type': 'application/json', ...moveOperation }, body: JSON.stringify({ task: task.id, from: 'old-draft', to: 'new-draft' }) });
  assert.equal(response.status, 200);
  const [moved] = attachmentResultSchema.array().parse(await response.json());
  assert.equal(moved!.path, 'attachments/new-draft/note.txt');
  assert.equal(existsSync(join(folder, saved.path)), false);
  assert.deepEqual(readFileSync(join(folder, moved!.path)), bytes);
  assert.equal(existsSync(join(folder, 'attachments', 'old-draft')), false);
  const replay = await fetch(new URL('/api/commands/task/attachment/move', server.url), { method: 'POST',
    headers: { 'content-type': 'application/json', ...moveOperation }, body: JSON.stringify({ task: task.id, from: 'old-draft', to: 'new-draft' }) });
  assert.equal(replay.status, 200);
  assert.deepEqual(attachmentResultSchema.array().parse(await replay.json()), [moved]);
  const staleUpload = await fetch(new URL(`/api/tasks/${task.id}/attachments?requestId=old-draft&name=late.txt`, server.url),
    { method: 'POST', headers: operation(), body: new Uint8Array(Buffer.from('late')) });
  assert.equal(staleUpload.status, 400);
  assert.equal((await staleUpload.json()).error.code, 'attachment_request_replaced');
  assert.equal(existsSync(join(folder, 'attachments', 'old-draft')), false);
  const removed = await fetch(new URL('/api/commands/task/attachment/remove', server.url), { method: 'POST',
    headers: { ...operation(), 'Content-Type': 'application/json' }, body: JSON.stringify({ task: task.id, requestId: 'new-draft', name: 'note.txt' }) });
  assert.equal(removed.status, 200);
  assert.equal(existsSync(join(folder, 'attachments', 'new-draft', 'note.txt')), false);
});

test('attaching before the first Run leaves the Run table empty', async t => {
  const { root, task } = await fixture(t);
  const before = new RunStore(root, { busyTimeoutMs: 0 });
  try { assert.deepEqual(before.read(), []); } finally { before.close(); }
  const saved = await saveTaskAttachment(root, task.id,
    'first-request', 'note.txt', Buffer.from('draft'), globalThis.crypto.randomUUID(), () => ({ actor: { kind: 'human' }, task: task.id }));
  assert.equal(saved.path, 'attachments/first-request/note.txt');
  const after = new RunStore(root, { busyTimeoutMs: 0 });
  try { assert.deepEqual(after.read(), []); } finally { after.close(); }
});

test('file list includes 105 files without adding names to report logs', async t => {
  const { root, task, folder } = await fixture(t);
  for (let i = 0; i < 105; i++) writeFileSync(join(folder, `note-${i}.txt`), String(i));
  // A person's report: the user's proxy stops the Task.
  const report = await new TaskReportService(root).report({ task: task.id, state: 'stopped',
    title: 'Stopped with its notes', opId: globalThis.crypto.randomUUID(), expectedTaskHash: task.hash },
  { kind: 'human' }, { kind: 'human' });
  assert.equal(report.task.state, 'stopped');
  const stopped = (await readControlTree(root)).tasks.find(item => item.id === task.id)!.log.at(-1)!;
  assert.equal(stopped.title, 'Stopped with its notes');
  assert.equal(stopped.description, null);
  assert.equal((await filesOf(root, task)).length, 105);
});

test('video reads follow ordinary linked files and report a directory as a typed refusal', async t => {
  const { root, task, folder } = await fixture(t);
  const original = join(folder, 'original.mp4'), bytes = Buffer.from('synthetic video bytes');
  writeFileSync(original, bytes);
  symlinkSync('original.mp4', join(folder, 'linked.mp4'));
  linkSync(original, join(folder, 'hard.mp4'));
  for (const name of ['original.mp4', 'linked.mp4', 'hard.mp4']) {
    const file = await openTaskFile(root, task.id, name);
    try { assert.equal(file.size, bytes.length); assert.deepEqual(readFileSync(file.fd), bytes); }
    finally { closeSync(file.fd); }
  }
  mkdirSync(join(folder, 'directory.mp4'));
  await assert.rejects(openTaskFile(root, task.id, 'directory.mp4'),
    { code: 'invalid_input', reason: { kind: 'expected_regular_file' } });
});

test('one unreadable regular file is listed without hiding its readable neighbors', async t => {
  const { root, task, folder } = await fixture(t);
  writeFileSync(join(folder, 'good.txt'), 'good');
  const denied = join(folder, 'unreadable.txt');
  writeFileSync(denied, 'secret');
  chmodSync(denied, 0);
  const files = await filesOf(root, task);
  assert.deepEqual(files.map(file => file.name), ['good.txt', 'unreadable.txt']);
  assert.equal(files[1]!.readable, false);
  assert.equal((await readTaskFile(root, task.id, 'good.txt')).toString(), 'good');
  await assert.rejects(readTaskFile(root, task.id, 'unreadable.txt'));
});

test('file index reuses its scan until invalidated for a nested addition', async t => {
  const { root, task, folder } = await fixture(t);
  const writer = new FileWriter(root);
  const index = new TaskFileIndex();
  t.after(() => writer.close());
  mkdirSync(join(folder, 'nested'));
  writeFileSync(join(folder, 'nested', 'a.txt'), 'A');
  const taskFolder = new FileJournal(root).taskLocation(task.id).folder;
  const listed = () => index.read(writer, [taskFolder]).get(taskFolder)!;
  const first = listed();
  assert.strictEqual(listed(), first);
  writeFileSync(join(folder, 'nested', 'b.txt'), 'B');
  assert.strictEqual(listed(), first);
  index.invalidate();
  const second = listed();
  assert.notStrictEqual(second, first);
  assert.deepEqual(second.map(file => file.name), ['nested/a.txt', 'nested/b.txt']);
});

const fetch = commandFetchWith(fetchBuffered);
