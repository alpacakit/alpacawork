#!/usr/bin/env node
/** Local-only OpenAI-shaped multipart endpoint over a pinned qwen-asr CPU binary. No audio files are saved. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SECONDS = 60;
/** ffmpeg's output below: 16 kHz, mono, s16le. */
const PCM_BYTES_PER_SECOND = 32000;
/** One second past the limit is decoded, to tell audio that runs over it from audio that runs just beyond it. */
const DECODED_SECONDS = MAX_SECONDS + 1;
export const MODEL = 'Qwen/Qwen3-ASR-1.7B';

async function run(command: string, args: string[], input: Uint8Array, signal: AbortSignal, maxBytes: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], signal });
    const chunks: Buffer[] = [];
    let bytes = 0, diagnostic = '';
    child.on('error', reject);
    child.stdin.on('error', () => {}); // The exit/error event owns an early process failure.
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { child.kill(); reject(new Error('Decoded audio or text exceeds its limit')); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${command} failed (${code}): ${diagnostic}`)));
    child.stdin.end(input);
  });
}

export function recognizer(binary: string, modelDirectory: string) {
  let busy = false;
  return createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/health') { reply(200, { model: MODEL, device: 'cpu', mode: 'batch', busy }); return; }
    if (req.method !== 'POST' || req.url !== '/v1/audio/transcriptions') { reply(404, { error: 'Not found' }); return; }
    if (req.headers.origin !== undefined) { reply(403, { error: 'Use the application proxy' }); return; }
    if (busy) { reply(429, { error: 'Another transcription is running' }); return; }
    busy = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 175_000);
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) { reply(413, { error: 'Audio exceeds 16 MiB' }); return; }
        chunks.push(chunk);
      }
      const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] ?? '' } }).formData();
      const file = form.get('file');
      if (!(file instanceof File) || !file.size || form.get('model') !== MODEL || form.get('language') !== 'ja') {
        reply(400, { error: 'Expected audio file, Qwen/Qwen3-ASR-1.7B model, and ja language' }); return;
      }
      const started = performance.now();
      const decoded = await run('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-t', String(DECODED_SECONDS), '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
        new Uint8Array(await file.arrayBuffer()), abort.signal, DECODED_SECONDS * PCM_BYTES_PER_SECOND + 1024);
      if (!decoded.length || decoded.length >= DECODED_SECONDS * PCM_BYTES_PER_SECOND) { reply(400, { error: `Audio must be between 0 and ${MAX_SECONDS} seconds` }); return; }
      // Browser stop/timeslice delivery can run just beyond its 60-second timer.
      const pcm = decoded.subarray(0, MAX_SECONDS * PCM_BYTES_PER_SECOND);
      const output = await run(binary, ['-d', modelDirectory, '--stdin', '-t', '8', '--language', 'Japanese', '--silent'], pcm, abort.signal, 400_000);
      const text = output.toString('utf8').trim();
      // Log timing only; neither waveform nor transcript belongs in service logs.
      console.error(JSON.stringify({ audioSeconds: pcm.length / PCM_BYTES_PER_SECOND, elapsedMs: Math.round(performance.now() - started) }));
      reply(200, { text });
    } catch (cause) {
      console.error(cause instanceof Error ? cause.message : String(cause));
      if (!res.destroyed) reply(502, { error: 'Local recognition failed or timed out' });
    } finally { clearTimeout(timer); busy = false; }
  });
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1]!)).href) {
  const { values } = parseArgs({ options: { binary: { type: 'string' }, model: { type: 'string' }, port: { type: 'string', default: '5723' } } });
  if (!values.binary || !values.model) throw new Error('Usage: recognizer.ts --binary <qwen_asr> --model <model directory> [--port 5723]');
  const server = recognizer(resolve(values.binary), resolve(values.model));
  server.requestTimeout = 190_000;
  server.listen(Number(values.port), '127.0.0.1', () => console.log(JSON.stringify({ port: values.port, model: MODEL, device: 'cpu' })));
}
