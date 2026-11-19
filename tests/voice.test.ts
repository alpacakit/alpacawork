import test from 'node:test';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createVoiceToken, transcribeVoice } from '../apps/backend/test-dist/voice.js';
import { recognizer } from '../scripts/voice/recognizer.ts';

test('temporary Soniox credential use only the configured local endpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-config-'));
  const calls: { authorization?: string; body?: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ api_key: 'temporary-only' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    writeFileSync(join(root, 'config.yaml'), `voice:\n  provider: soniox\n  endpoint: ws://127.0.0.1:${address.port}/stream\n  token_endpoint: http://127.0.0.1:${address.port}/token\n  model: stt-rt-v5\n  api_key_env: FAKE_VOICE_KEY\n`);
    const settings = { provider: 'soniox' as const, endpoint: `ws://127.0.0.1:${address.port}/stream`, token_endpoint: `http://127.0.0.1:${address.port}/token`, model: 'stt-rt-v5', api_key_env: 'FAKE_VOICE_KEY', language_hints: ['ja', 'en'], terms: [] };
    assert.ok(settings);
    await assert.rejects(createVoiceToken(settings, {}), /Missing FAKE_VOICE_KEY/);
    const result = await createVoiceToken(settings, { FAKE_VOICE_KEY: 'long-lived-secret' });
    assert.ok('token' in result);
    assert.equal(result.token, 'temporary-only');
    assert.equal(JSON.stringify(result).includes('long-lived-secret'), false);
    assert.deepEqual(calls, [{ authorization: 'Bearer long-lived-secret', body: {
      usage_type: 'transcribe_websocket', expires_in_seconds: 60, single_use: true, max_session_duration_seconds: 600,
    } }]);
  } finally {
    server.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('Deepgram grant uses Token auth and returns only its short-lived JWT', async () => {
  let authorization: string | undefined;
  let body: unknown;
  const server = createServer(async (req, res) => {
    authorization = req.headers.authorization;
    let text = '';
    for await (const chunk of req) text += chunk;
    body = JSON.parse(text);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ access_token: 'jwt-fake', expires_in: 30 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const settings = { provider: 'deepgram' as const, endpoint: 'ws://127.0.0.1/stream',
      token_endpoint: `http://127.0.0.1:${address.port}/token`, model: 'nova-3',
      api_key_env: 'DEEPGRAM_API_KEY', language_hints: ['ja'], terms: [] };
    const token = await createVoiceToken(settings, { DEEPGRAM_API_KEY: 'private-fake' });
    assert.ok('token' in token);
    assert.equal(token.token, 'jwt-fake');
    assert.equal(authorization, 'Token private-fake');
    assert.deepEqual(body, { ttl_seconds: 30 });
  } finally { server.close(); }
});

test('local voice forwards the configured model, never client supplied destinations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-local-'));
  try {
    const settings = { provider: 'local' as const, endpoint: 'http://127.0.0.1:5723/v1/audio/transcriptions', model: 'local-model', language: 'ja' };
    assert.deepEqual(await createVoiceToken(settings), { provider: 'local' });
    const form = new FormData();
    form.set('file', new File(['test audio'], 'sound.m4a', { type: 'audio/mp4' }));
    form.set('model', 'client-model'); form.set('endpoint', 'https://external.invalid');
    let sent = false;
    const result = await transcribeVoice(settings, new Request('http://localhost/api/voice/transcriptions', { method: 'POST', body: form }), async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:5723/v1/audio/transcriptions');
      assert.equal(init?.redirect, 'error');
      const outgoing = init!.body as FormData;
      assert.equal(outgoing.get('model'), 'local-model'); assert.equal(outgoing.get('language'), 'ja');
      assert.equal(await (outgoing.get('file') as File).text(), 'test audio');
      assert.equal(outgoing.has('endpoint'), false); sent = true;
      return Response.json({ text: 'Transcription result' });
    });
    assert.equal(sent, true); assert.deepEqual(result, { text: 'Transcription result' });
    await assert.rejects(transcribeVoice(settings, new Request('http://localhost/api/voice/transcriptions', { method: 'POST', body: form }), async () => new Response(null, { status: 503 })), /503/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local recognizer rejects audio playlists without following their network references', async () => {
  let requests = 0;
  const external = createServer((_, res) => { requests++; res.end('not audio'); });
  external.listen(0, '127.0.0.1'); await once(external, 'listening');
  const target = external.address(); assert.ok(target && typeof target !== 'string');
  const server = recognizer('/usr/bin/true', '/unused-model');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const form = new FormData();
    form.set('model', 'Qwen/Qwen3-ASR-1.7B'); form.set('language', 'ja');
    form.set('file', new File([`#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:${target.port}/segment.ts\n#EXT-X-ENDLIST\n`], 'recording.webm'));
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/audio/transcriptions`, { method: 'POST', body: form });
    assert.equal(response.status, 502); assert.equal(requests, 0);
    const direct = await fetch(`http://127.0.0.1:${address.port}/v1/audio/transcriptions`, { method: 'POST', headers: { Origin: 'http://localhost' }, body: form });
    assert.equal(direct.status, 403);
  } finally { server.closeAllConnections(); server.close(); external.closeAllConnections(); external.close(); }
});


test('voice input failures expose stable machine codes, including upstream status', async () => {
  const settings = { provider: 'local' as const, endpoint: 'http://127.0.0.1:9/audio', model: 'test', language: 'ja' };
  const request = (body: BodyInit) => new Request('http://localhost/api/voice/transcriptions', { method: 'POST', body });
  await assert.rejects(transcribeVoice(settings, request(new FormData())),
    error => error instanceof Problem && error.code === PROBLEM_CODE.voiceEmpty);
  await assert.rejects(transcribeVoice(settings, request(new Uint8Array(16 * 1024 * 1024 + 1))),
    error => error instanceof Problem && error.code === PROBLEM_CODE.voiceTooLarge);
  const form = new FormData(); form.set('file', new File(['audio'], 'a.webm'));
  await assert.rejects(transcribeVoice(settings, request(form), async () => new Response(null, { status: 502 })),
    error => error instanceof Problem && error.code === PROBLEM_CODE.voiceRecognitionFailed && typeof error.detail === 'object' && error.detail !== null && 'status' in error.detail && error.detail.status === 502);
});
