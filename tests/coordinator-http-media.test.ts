/** Real coordinator HTTP media cases; independent private fixtures. */
import { coordinatorSnapshotSchema } from '@alpacawork/contract/coordinator';
import { httpStatus } from './helpers/http-cli.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, linkSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coordinatorCwd } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { messagePart, type View, eventually, records, fixture } from './helpers/coordinator-http-fixture.ts';

test('card API runs a real server child without a credential in its own folder, resumes, clears and passes an attachment', async t => {
  const h = await fixture(t);
  const first = await h.get();
  // The screen names recipient Tasks, never its currently displayed panel. (An ID with no Task is admitted and links
  // nothing: coordinator-http-context.)
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: first.id, id: crypto.randomUUID(), text: 'first',
    tasks: ['default/T13'], attachments: [] })).status, 400);
  assert.equal((await h.get()).turns.length, 0);
  assert.deepEqual(h.records(first.id), [], 'a refused message records nothing');
  const id1 = crypto.randomUUID();
  const sent1 = await h.post('/api/coordinator/messages', { conversationId: first.id, id: id1, text: 'first', tasks: [h.project], attachments: [] });
  assert.equal(sent1.status, 200);
  const one = await h.done(id1);
  assert.equal(one.status, 'succeeded');
  const answer1 = JSON.parse(one.answer!);
  assert.equal(answer1.mode, 'start');
  assert.equal(messagePart(answer1.prompt), 'first');
  // It calls as the person's coordinator, with no Run identity, from its own empty folder below the workspace.
  const cwd = coordinatorCwd(h.root);
  assert.equal(answer1.run, null); assert.equal(answer1.workspace, h.root);
  assert.equal(answer1.cwd, cwd); assert.equal(statSync(cwd).mode & 0o777, 0o700); assert.deepEqual(readdirSync(cwd), []);
  assert.equal(h.records(first.id)[0]?.launch?.credential, null);
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: first.id, id: id1, text: 'first', tasks: [h.project], attachments: [] })).status, 200);
  assert.equal((await h.get()).turns.length, 1);
  assert.equal(h.records(first.id).length, 1, 'the same message ID with the same input is the same Request');
  const id2 = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: first.id, id: id2, text: 'second', attachments: [] })).status, 200);
  const two = JSON.parse((await h.done(id2)).answer!);
  assert.equal(two.mode, 'resume'); assert.equal(two.session, answer1.session);
  assert.equal(messagePart(two.prompt), 'second');
  await h.restart();
  assert.equal((await h.get()).turns.length, 2);
  const cleared = await h.post('/api/coordinator/clear', { conversationId: first.id });
  assert.equal(cleared.status, 200);
  const next = (coordinatorSnapshotSchema.parse(await cleared.json()).conversation as View);
  assert.notEqual(next.id, first.id); assert.equal(next.turns.length, 0);
  assert.equal((await h.post('/api/coordinator/clear', { conversationId: first.id })).status, 409);
  const id3 = crypto.randomUUID();
  const image = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  const upload = await fetch(new URL(`/api/coordinator/attachments?conversationId=${next.id}&requestId=${id3}&name=sample.png`, h.url()), {
    method: 'POST', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID(), 'Content-Type': 'application/octet-stream' }, body: image });
  assert.equal(upload.status, 200, await upload.text());
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: next.id, id: id3, text: 'look', attachments: ['sample.png'] })).status, 200);
  const three = JSON.parse((await h.done(id3)).answer!);
  assert.equal(three.mode, 'start'); assert.notEqual(three.session, answer1.session);
  assert.equal(three.imageBytes, image.length);
  const folder = join(h.root, '.alpacawork/coordinator', next.id);
  assert.ok(three.prompt.includes(`![sample.png](${join(folder, 'attachments', id3, 'sample.png')})`));
  const oldFile = new URL(`/api/coordinator/file?requestId=${id3}&name=sample.png`, h.url());
  assert.equal(await httpStatus(oldFile), 200);
  assert.equal((await h.post('/api/coordinator/clear', { conversationId: next.id })).status, 200);
  assert.equal(await httpStatus(oldFile), 404, 'clear revokes the old image');
  await eventually(() => !existsSync(folder), 'serve sweeps the cleared conversation\'s files');
  assert.equal(await httpStatus(new URL(`/api/coordinator/attachments?conversationId=${next.id}&requestId=${id3}&name=sample.png`, h.url()), {
    method: 'POST', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() }, body: image }), 409);
});

test('coordinator attachments take files over 20 MiB by default and follow limits.attachment_mib', async t => {
  const MiB = 1024 * 1024;
  for (const [limits, size, status] of [['', 21 * MiB, 200], ['', 50 * MiB + 1, 413], ['limits: {attachment_mib: 1}\n', 2 * MiB, 413]] as const) {
    const h = await fixture(t, false, limits), conversation = await h.get(), requestId = crypto.randomUUID();
    const response = await fetch(new URL(`/api/coordinator/attachments?conversationId=${conversation.id}&requestId=${requestId}&name=clip.mp4`, h.url()), {
      method: 'POST', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() }, body: new Uint8Array(size) });
    const body = await response.json() as { error?: { message: string } };
    assert.equal(response.status, status, `${limits} ${size}`);
    if (status === 413) assert.equal(body.error?.message, `File exceeds ${limits ? 1 : 50} MiB`);
  }
});

test('a coordinator attachment of the same bytes keeps one file, and the same size with other bytes gains -2', async t => {
  const h = await fixture(t), conversation = await h.get(), requestId = crypto.randomUUID();
  const upload = async (body: string) => await (await fetch(new URL(`/api/coordinator/attachments?conversationId=${conversation.id}&requestId=${requestId}&name=note.txt`, h.url()), {
    method: 'POST', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() }, body })).json() as { path: string; size: number };
  assert.equal((await upload('abcd')).path, `attachments/${requestId}/note.txt`);
  assert.equal((await upload('abcd')).path, `attachments/${requestId}/note.txt`);
  assert.deepEqual(await upload('abce'), { path: `attachments/${requestId}/note-2.txt`, size: 4,
    absolutePath: `/api/coordinator/file?requestId=${requestId}&name=note-2.txt` });
});

test('clear removes attachments that were uploaded but never sent', async t => {
  const h = await fixture(t), conversation = await h.get(), requestId = crypto.randomUUID();
  const file = new URL(`/api/coordinator/file?requestId=${requestId}&name=draft.png`, h.url());
  assert.equal(await httpStatus(new URL(`/api/coordinator/attachments?conversationId=${conversation.id}&requestId=${requestId}&name=draft.png`, h.url()), {
    method: 'POST', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() }, body: 'draft image' }), 200);
  assert.equal(await httpStatus(file), 200);
  assert.equal((await h.post('/api/coordinator/clear', { conversationId: conversation.id })).status, 200);
  assert.equal(await httpStatus(file), 404);
  await eventually(() => !existsSync(join(h.root, '.alpacawork/coordinator', conversation.id)), 'serve sweeps the draft');
  await h.restart();
  assert.equal(await httpStatus(new URL(file.pathname + file.search, h.url())), 404);
});

test('coordinator attachments share durable upload, move and delete receipts', async t => {
  const h = await fixture(t), conversation = await h.get(), first = crypto.randomUUID(), second = crypto.randomUUID();
  const uploadId = crypto.randomUUID(), moveId = crypto.randomUUID(), removeId = crypto.randomUUID();
  const uploadUrl = new URL(`/api/coordinator/attachments?conversationId=${conversation.id}&requestId=${first}&name=one.png`, h.url());
  const upload = () => fetch(uploadUrl, { method: 'POST', headers: { 'X-Alpacawork-Op-Id': uploadId }, body: 'bytes' });
  assert.equal((await upload()).status, 200);
  const moved = () => fetch(new URL('/api/coordinator/attachments/move', h.url()), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Alpacawork-Op-Id': moveId },
    body: JSON.stringify({ conversationId: conversation.id, from: first, to: second }) });
  assert.equal((await moved()).status, 200);
  assert.equal((await moved()).status, 200, 'the same move receipt replays');
  assert.equal((await upload()).status, 200, 'a lost upload reply replays after its folder moved');
  // Every stale operation has the same machine reason; the UI can recover a delete without reading diagnostic prose.
  for (const [url, init] of [
    [uploadUrl, { method: 'POST', body: 'late bytes' }],
    [uploadUrl, { method: 'DELETE' }],
    [new URL('/api/coordinator/attachments/move', h.url()), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: conversation.id, from: first, to: crypto.randomUUID() }) }],
  ] satisfies [URL, RequestInit][]) {
    const response = await fetch(url, { ...init, headers: { ...init.headers, 'X-Alpacawork-Op-Id': crypto.randomUUID() } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'attachment_request_replaced');
  }
  const file = new URL(`/api/coordinator/file?requestId=${second}&name=one.png`, h.url());
  assert.equal(await (await fetch(file)).text(), 'bytes');
  const remove = () => fetch(new URL(`/api/coordinator/attachments?conversationId=${conversation.id}&requestId=${second}&name=one.png`, h.url()), {
    method: 'DELETE', headers: { 'X-Alpacawork-Op-Id': removeId } });
  assert.equal((await remove()).status, 200);
  assert.equal((await remove()).status, 200, 'the same delete receipt replays');
  assert.equal(await httpStatus(file), 404);
});

test('the coordinator fixture reports all attachment sizes and counts an image after a non-image file', async t => {
  const h = await fixture(t), conversationId = (await h.get()).id, id = crypto.randomUUID();
  for (const [name, bytes] of [['notes.txt', Buffer.from('text first')], ['sample.png', Buffer.from([137, 80, 78, 71, 1])]] as const) {
    const response = await fetch(new URL(`/api/coordinator/attachments?conversationId=${conversationId}&requestId=${id}&name=${name}`, h.url()), {
      method: 'POST', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() }, body: bytes });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  assert.equal((await h.post('/api/coordinator/messages', { conversationId, id, text: 'both', attachments: ['notes.txt', 'sample.png'] })).status, 200);
  const answer = JSON.parse((await h.done(id)).answer!);
  assert.deepEqual(answer.attachmentBytes, { 'notes.txt': 10, 'sample.png': 5 });
  assert.equal(answer.imageBytes, 5);
});

test('coordinator media share Task byte ranges, keep sent bytes immutable, and revoke reads on clear', async t => {
  const h = await fixture(t), conversation = await h.get(), requestId = crypto.randomUUID();
  const webm = readFileSync(new URL('../e2e/fixture/swipe-clip.webm', import.meta.url));
  const mp4 = Buffer.from('0000ftypisom0123');
  for (const [name, bytes, type] of [['clip.webm', webm, 'video/webm'], ['clip.mp4', mp4, 'video/mp4'],
    ['clip.m4a', Buffer.from('0000ftypM4A 0123'), 'audio/mp4']] as const) {
    const response = await fetch(new URL(`/api/coordinator/attachments?conversationId=${conversation.id}&requestId=${requestId}&name=${name}`, h.url()), {
      method: 'POST', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() }, body: bytes });
    assert.equal(response.status, 200);
    const file = new URL(`/api/coordinator/file?requestId=${requestId}&name=${name}`, h.url());
    const first = await fetch(file, { headers: { range: 'bytes=0-3' } });
    assert.equal(first.status, 206);
    assert.equal(first.headers.get('content-type'), type);
    assert.equal(first.headers.get('accept-ranges'), 'bytes');
    assert.equal(first.headers.get('content-range'), `bytes 0-3/${bytes.length}`);
    assert.equal(first.headers.get('content-length'), '4');
    assert.equal(first.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes.subarray(0, 4));
    // A tab cannot play from the sandboxed address; the screen's link to the original saves it under its name.
    const original = new URL(file); original.searchParams.set('download', '1');
    const saved = await fetch(original);
    assert.match(saved.headers.get('content-disposition')!, new RegExp(`^attachment; filename="${name}"`));
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), bytes);
    const tail = await fetch(file, { headers: { range: 'bytes=-7' } });
    assert.equal(tail.status, 206); assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(-7));
    const rest = await fetch(file, { headers: { range: 'bytes=4-' } });
    assert.equal(rest.status, 206); assert.deepEqual(Buffer.from(await rest.arrayBuffer()), bytes.subarray(4));
    const clamped = await fetch(file, { headers: { range: `bytes=4-${bytes.length + 50}` } });
    assert.equal(clamped.status, 206); assert.deepEqual(Buffer.from(await clamped.arrayBuffer()), bytes.subarray(4));
    const whole = await fetch(file);
    assert.equal(whole.status, 200); assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
    for (const range of [`bytes=${bytes.length}-`, 'bytes=3-2', 'bytes=0-1,3-4', 'bytes=-0', 'bytes=-', 'invalid']) {
      const rejected = await fetch(file, { headers: { range } });
      assert.equal(rejected.status, 416, range); assert.equal(rejected.headers.get('content-range'), `bytes */${bytes.length}`);
    }
  }
  assert.equal(await httpStatus(new URL(`/api/coordinator/file?requestId=${crypto.randomUUID()}&name=clip.webm`, h.url()), { headers: { range: 'bytes=0-3' } }), 404);
  assert.equal(await httpStatus(new URL(`/api/coordinator/file?requestId=${requestId}&name=..%2Fclip.webm`, h.url()), { headers: { range: 'bytes=0-3' } }), 400);
  const asked = await h.post('/api/coordinator/messages', { conversationId: conversation.id, id: requestId, text: 'Read videos', attachments: ['clip.webm', 'clip.mp4'] });
  assert.equal(asked.status, 200); await h.done(requestId);
  const file = new URL(`/api/coordinator/file?requestId=${requestId}&name=clip.webm`, h.url());
  const sent = await fetch(file, { headers: { range: 'bytes=4-7' } });
  assert.equal(sent.status, 206); assert.deepEqual(Buffer.from(await sent.arrayBuffer()), webm.subarray(4, 8));
  assert.equal((await fetch(new URL(`/api/coordinator/attachments?conversationId=${conversation.id}&requestId=${requestId}&name=clip.webm`, h.url()), {
    method: 'DELETE', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() } })).status, 409);
  assert.equal((await h.post('/api/coordinator/clear', { conversationId: conversation.id })).status, 200);
  assert.equal(await httpStatus(file, { headers: { range: 'bytes=0-3' } }), 404);
});

test('answer links publish bounded owned snapshots, survive source removal and restart, and retire with the conversation', async t => {
  const h = await fixture(t);
  const source = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-answer-source-')));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const png = readFileSync(new URL('../e2e/fixture/wide-report.png', import.meta.url));
  writeFileSync(join(source, 'screen.png'), png);
  writeFileSync(join(source, 'note.txt'), 'persistent answer file');
  writeFileSync(join(source, 'invalid.png'), 'not an image');
  symlinkSync(join(source, 'note.txt'), join(source, 'symlink.txt'));
  writeFileSync(join(source, 'hard-source.txt'), 'hard link');
  linkSync(join(source, 'hard-source.txt'), join(source, 'hard.txt'));
  mkdirSync(join(source, 'directory.txt'));
  const reply = `![Screen](${source}/screen.png)\n[Description](${source}/note.txt)\n![Invalid image](${source}/invalid.png)\n[Missing](${source}/missing.txt)\n[Link](${source}/symlink.txt)\n[Hard link](${source}/hard.txt)\n[Directory](${source}/directory.txt)\n[Internal configuration](${h.root}/config.yaml)\n\n\`[Code](${source}/not-snapshotted.txt)\`\n\n\`\`\`\n![In code](${source}/not-snapshotted.png)\n\`\`\``;
  const replyPath = join(h.root, 'reply.md'); writeFileSync(replyPath, reply);
  const conversation = await h.get(), id = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id,
    text: `answer-from:${replyPath}`, attachments: [] })).status, 200);
  const turn = await h.done(id) as Awaited<ReturnType<typeof h.done>> & { answerFiles: import('@alpacawork/contract').AnswerFile[] };
  assert.equal(turn.status, 'succeeded'); assert.equal(turn.answer, reply);
  assert.equal(turn.answerFiles.length, 7);
  const image = turn.answerFiles.find(file => file.href.endsWith('/screen.png'))!;
  const note = turn.answerFiles.find(file => file.href.endsWith('/note.txt'))!;
  assert.equal(image.state, 'ready'); assert.equal(note.state, 'ready');
  for (const name of ['invalid.png', 'missing.txt', 'directory.txt'])
    assert.equal(turn.answerFiles.find(file => file.href.endsWith('/' + name))!.state, 'unavailable', name);
  const linkedNotes = ([['symlink.txt', 'persistent answer file'], ['hard.txt', 'hard link']] as const).map(([name, expected]) => {
    const file = turn.answerFiles.find(file => file.href.endsWith('/' + name))!;
    assert.equal(file.state, 'ready', name);
    if (file.state !== 'ready') throw new Error('Expected linked file snapshot');
    return { file, expected };
  });
  if (image.state !== 'ready' || note.state !== 'ready') throw new Error('Expected snapshots');
  const fileUrl = (name: string) => new URL(`/api/coordinator/file?requestId=${id}&name=${encodeURIComponent(name)}&area=answers`, h.url());
  assert.deepEqual(Buffer.from(await (await fetch(fileUrl(image.name))).arrayBuffer()), png);
  for (const { file, expected } of linkedNotes) assert.equal(await (await fetch(fileUrl(file.name))).text(), expected);
  assert.equal(await httpStatus(fileUrl('not-in-manifest.txt')), 404);
  assert.equal(await httpStatus(new URL(`/api/coordinator/file?requestId=${id}&name=${image.name}`, h.url())), 404);
  rmSync(source, { recursive: true, force: true });
  await h.restart();
  assert.equal(await (await fetch(fileUrl(note.name))).text(), 'persistent answer file');
  for (const { file, expected } of linkedNotes) assert.equal(await (await fetch(fileUrl(file.name))).text(), expected,
    'the owned snapshot survives removal of its linked source and restart');
  assert.deepEqual(Buffer.from(await (await fetch(fileUrl(image.name))).arrayBuffer()), png);
  // Restart replay never rereads a deleted source for an already committed snapshot.
  const { captureAnswerFiles } = await import('@alpacawork/backend/test-dist/coordinator/answer-files.js');
  assert.equal(captureAnswerFiles(h.root, conversation.id, id, `![Screen](${source}/screen.png)`)[0]!.state, 'ready');
  assert.equal((await h.post('/api/coordinator/clear', { conversationId: conversation.id })).status, 200);
  assert.equal(await httpStatus(fileUrl(note.name)), 404);
  await eventually(() => !existsSync(join(h.root, '.alpacawork/coordinator', conversation.id, 'answers', id)),
    'serve sweeps the cleared conversation\'s answer files');
});

test('answer capture bounds files and counts, ignores code and delivery URLs, and follows linked parents', async t => {
  const h = await fixture(t, false, 'limits: {attachment_mib: 1}\n');
  const source = realpathSync(mkdtempSync(join(tmpdir(), 'answer-limits-')));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const { captureAnswerFiles } = await import('@alpacawork/backend/test-dist/coordinator/answer-files.js');
  writeFileSync(join(source, 'large.txt'), Buffer.alloc(1024 * 1024 + 1));
  writeFileSync(join(source, 'ok.txt'), 'ok');
  mkdirSync(join(source, 'folder'));
  symlinkSync(source, join(source, 'folder', 'linked'));
  const conversation = (await h.get()).id, id = crypto.randomUUID();
  const files = captureAnswerFiles(h.root, conversation, id, `[large](${source}/large.txt)\n[linked parent](${source}/folder/linked/ok.txt)\n[URL](/api/tasks/T1/file?path=file.png)\n\
![URL](https://example.test/api/tasks/T1/file?path=file.png)\n\
\`[code](${source}/ok.txt)\`\n\
\`\`\`\n[code](${source}/ok.txt)\n\`\`\``);
  assert.equal(files.length, 2, 'code and delivery URLs are not captured');
  assert.deepEqual(files[0], { state: 'unavailable', href: join(source, 'large.txt'), reason: 'too_large' });
  const linked = files[1]!;
  assert.equal(linked.state, 'ready');
  if (linked.state !== 'ready') throw new Error('Expected linked parent snapshot');
  assert.equal(readFileSync(join(h.root, '.alpacawork/coordinator', conversation, 'answers', id, linked.name), 'utf8'), 'ok');
  const count = captureAnswerFiles(h.root, conversation, id, Array.from({ length: 21 }, (_, index) => {
    const file = join(source, `${index}.txt`); writeFileSync(file, String(index)); return `[${index}](${file})`;
  }).join('\n'));
  assert.equal(count.filter(file => file.state === 'ready').length, 20);
  assert.deepEqual(count.at(-1), { state: 'unavailable', href: join(source, '20.txt'), reason: 'limit' });
});
