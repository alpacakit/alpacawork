import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_FORMATS, fileFormat, fileKind, fileMediaType, fileStreams } from '@alpacawork/contract';
import { reportEmbed } from '@alpacawork/contract/report-media';
import { profiles, createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { currentTaskHash, currentTaskLog } from './helpers/control-fixture.ts';
import { commandFetchWith } from './helpers/command-fetch.ts';
import { fetchBuffered } from './helpers/buffered-http.ts';

// Two synthetic 1x1 frames. Comment extensions grow the animation without changing its frames.
const still = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex');
const delay = Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]);
const gif = Buffer.concat([still.subarray(0, 19), delay, still.subarray(19, -1), delay, still.subarray(19, -1), still.subarray(-1)]);
const comment = Buffer.concat([Buffer.from([0x21, 0xfe, 255]), Buffer.alloc(255, 65), Buffer.from([0])]);
const largeGif = Buffer.concat([gif.subarray(0, -1), ...Array<Buffer>(16300).fill(comment), gif.subarray(-1)]);

test('filename policy unifies embeds, MIME types and streaming without treating active or unsupported formats as media', () => {
  for (const [name, kind, type] of [
    ['scene.GIF', 'image', 'image/gif'], ['scene.apng', 'image', 'image/apng'], ['scene.avif', 'image', 'image/avif'],
    ['scene.bmp', 'image', 'image/bmp'], ['scene.ico', 'image', 'image/x-icon'], ['scene.jfif', 'image', 'image/jpeg'],
    ['clip.MOV', 'video', 'video/quicktime'], ['clip.m4v', 'video', 'video/mp4'], ['clip.ogv', 'video', 'video/ogg'],
    ['sound.mp3', 'audio', 'audio/mpeg'], ['sound.m4a', 'audio', 'audio/mp4'], ['sound.aac', 'audio', 'audio/aac'],
    ['sound.wav', 'audio', 'audio/wav'], ['sound.flac', 'audio', 'audio/flac'], ['sound.ogg', 'audio', 'audio/ogg'],
    ['sound.opus', 'audio', 'audio/ogg'], ['patch.diff', 'diff', 'text/plain; charset=utf-8'],
  ] as const) {
    assert.equal(fileKind(name), kind, name);
    assert.equal(fileMediaType(name), type, name);
    assert.deepEqual(reportEmbed(name), { path: name, kind });
    assert.equal(fileStreams(name), kind === 'image' || kind === 'video' || kind === 'audio', name);
  }
  for (const name of ['file.svg', 'file.html', 'file.ts', 'file.heic', 'file.tiff', 'file.jxl', 'file.mkv', 'file.avi', 'file.gif.exe', 'file.gif/notes'])
    assert.equal(fileKind(name), null, name);
  assert.equal(fileFormat('dir.with.gif/no-extension'), null);
  const extensions = FILE_FORMATS.flatMap(format => [...format.extensions]);
  assert.equal(new Set(extensions).size, extensions.length);
});

test('formal reports accept small and large GIFs and reject forgery, incomplete data and images above the configured limit without saving', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'media-reports-'));
  const original = createOriginal({ ...profiles.small, seed: 'media-reports' }, join(temp, 'cache'));
  const root = join(temp, 'workspace'); copyWorkspace(original.root, root);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await server?.close(); removeWorkspace(root); removeWorkspace(original.root); rmSync(temp, { recursive: true, force: true }); });
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: 'P1', userRequested: false,
    tasks: [{ title: 'Media report fixture' }] })).tasks[0]!;
  const folder = join(root, 'tasks', task.id); mkdirSync(folder, { recursive: true });
  const png = readFileSync('e2e/fixture/wide-report.png');
  for (const [name, bytes] of [
    ['small.gif', gif], ['large.gif', largeGif], ['forged.gif', png], ['no-trailer.gif', gif.subarray(0, -1)],
    ['broken-block.gif', Buffer.concat([gif.subarray(0, -3), gif.subarray(-1)])],
    ['forged.png', gif], ['cut.png', png.subarray(0, -12)],
  ] as const) writeFileSync(join(folder, name), bytes);
  assert(largeGif.length > 4 * 1024 * 1024);
  const report = (description: string) => new TaskReportService(root).report({ task: task.id, state: 'stopped',
    title: 'Media evidence', description, opId: crypto.randomUUID(), expectedTaskHash: currentTaskHash(root, task.id) },
  { kind: 'human' }, { kind: 'human' });
  const before = currentTaskLog(root, task.id).length;
  for (const name of ['forged.gif', 'no-trailer.gif', 'broken-block.gif', 'forged.png', 'cut.png']) {
    await assert.rejects(report(`![Evidence](${name})`), { code: 'invalid_input' }, name);
    assert.equal(currentTaskLog(root, task.id).length, before, name);
  }
  writeFileSync(join(root, 'config.yaml'), 'agents: {}\nlimits: {attachment_mib: 1}\n');
  await assert.rejects(report('![Evidence](large.gif)'), { code: 'invalid_input' });
  assert.equal(currentTaskLog(root, task.id).length, before);
  writeFileSync(join(root, 'config.yaml'), 'agents: {}\n');
  const description = '![Small animation](small.gif)\n![Large animation](large.gif)';
  assert.equal((await report(description)).task.state, 'stopped');
  assert.equal(currentTaskLog(root, task.id).at(-1)!.description, description);

  server = await startServer(root, 0);
  const url = (name: string) => new URL(`/api/tasks/${task.id}/file?path=${encodeURIComponent(name)}`, server!.url);
  for (const name of ['small.gif', 'large.gif']) {
    const response = await fetch(url(name));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/gif');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), name === 'small.gif' ? gif : largeGif);
  }
  writeFileSync(join(root, 'config.yaml'), 'agents: {}\nlimits: {attachment_mib: 1}\n');
  // Every screen entry loads an image from this one address, whatever its size against the limit.
  const large = await fetch(url('large.gif'));
  assert.equal(large.status, 200);
  assert.match(large.headers.get('content-disposition')!, /^inline;/);
  assert.deepEqual(Buffer.from(await large.arrayBuffer()), largeGif);
  writeFileSync(join(folder, 'large.txt'), Buffer.alloc(2 * 1024 * 1024, 0x61));
  assert.equal((await fetch(url('large.txt'))).status, 413);
  const download = url('large.gif'); download.searchParams.set('download', '1');
  const response = await fetch(download, { headers: { range: 'bytes=-1' } });
  assert.equal(response.status, 206);
  assert.match(response.headers.get('content-disposition')!, /^attachment;/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0x3b]));
  writeFileSync(join(folder, 'voice.wav'), Buffer.alloc(2 * 1024 * 1024, 7));
  const audio = await fetch(url('voice.wav'), { headers: { range: 'bytes=10-13' } });
  assert.equal(audio.status, 206, 'audio streaming does not load an oversized file into the document reader');
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), Buffer.alloc(4, 7));
  const denied = await fetch(download, { headers: { authorization: 'Alpacawork-Run invalid:invalid' } });
  assert.equal(denied.status, 403);
});

test('managed file responses keep safe names and headers for audio ranges, unknown binary and inert markup', async () => {
  const { fileBytesResponse, fileResponsePlan } = await import('@alpacawork/backend/test-dist/receiver/file-response.js');
  const bytes = Buffer.from('RIFF0000WAVEdata');
  const response = fileBytesResponse('folder/音声 "試聴".wav', bytes, { range: 'bytes=0-3' });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'RIFF');
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.match(response.headers.get('content-disposition')!, /filename\*=UTF-8''%E9%9F%B3/);
  for (const range of ['bytes=99-', 'bytes=-0', 'bytes=0-1,4-5']) {
    const refused = fileResponsePlan('voice.opus', bytes.length, { range });
    assert.equal(refused.status, 416);
    assert.equal(refused.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(refused.headers['Cache-Control'], 'no-store');
  }
  const binary = fileBytesResponse('folder/原本\r\n.bin', bytes);
  assert.equal(binary.headers.get('content-type'), 'application/octet-stream');
  assert.match(binary.headers.get('content-disposition')!, /^attachment;/);
  assert.doesNotMatch(binary.headers.get('content-disposition')!, /[\r\n]/);
  const svg = fileBytesResponse('drawing.svg', Buffer.from('<svg onload="alert(1)"/>'));
  assert.equal(svg.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(svg.headers.get('content-security-policy'), "sandbox; default-src 'none'");
});

test('managed file validators select cache freshness and take precedence over byte ranges', async () => {
  const { fileBytesResponse } = await import('@alpacawork/backend/test-dist/receiver/file-response.js');
  const bytes = Buffer.from('synthetic video bytes');
  const revision = '15-123-456', etag = `"${revision}"`;
  const respond = (options: { requestedRevision?: string; ifNoneMatch?: string; ifRange?: string; range?: string } = {}) =>
    fileBytesResponse('clip.mp4', bytes, { ...options, revision });

  assert.equal(respond({ requestedRevision: revision }).headers.get('cache-control'),
    'private, max-age=31536000, immutable');
  for (const requestedRevision of [undefined, 'old']) {
    const response = respond({ requestedRevision });
    assert.equal(response.headers.get('cache-control'), 'private, no-cache');
    assert.equal(response.headers.get('etag'), etag);
  }

  for (const ifNoneMatch of [etag, `"other", W/${etag}`, '*']) {
    const unchanged = respond({ ifNoneMatch, range: 'bytes=0-3' });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body, null);
    assert.equal(unchanged.headers.get('etag'), etag);
    assert.equal(unchanged.headers.get('cache-control'), 'private, no-cache');
    assert.equal(unchanged.headers.get('content-range'), null);
  }

  const partial = respond({ ifRange: etag, range: 'bytes=0-3' });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), 'synt');

  for (const ifRange of ['"old"', `W/${etag}`]) {
    const changed = respond({ ifRange, range: 'bytes=0-3' });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get('content-range'), null);
    assert.deepEqual(Buffer.from(await changed.arrayBuffer()), bytes);
  }
});

const fetch = commandFetchWith(fetchBuffered);
