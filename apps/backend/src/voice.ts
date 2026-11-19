import { z } from 'zod';
// import { readConfigValues } from './config.js'; // Initial release: voice settings stay disconnected.
import type { Hono } from 'hono';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';

const endpoint = (secureProtocol: string, localProtocol: string) => z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === secureProtocol ||
    ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.protocol === localProtocol);
}, 'Use TLS, or a loopback address for local tests');
const cloudSchema = z.object({
  provider: z.enum(['soniox', 'deepgram']),
  endpoint: endpoint('wss:', 'ws:'),
  token_endpoint: endpoint('https:', 'http:'),
  model: z.string().min(1),
  api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  language_hints: z.array(z.string().min(2)).default(['ja', 'en']),
  terms: z.array(z.string().min(1)).default([]),
}).strict();
const localSchema = z.object({
  provider: z.literal('local'),
  endpoint: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password;
  }, 'Local voice must use http://127.0.0.1'),
  model: z.string().min(1),
  language: z.string().min(2).default('ja'),
}).strict();
const voiceSchema = z.union([localSchema, cloudSchema]);
type VoiceSettings = z.infer<typeof voiceSchema>;

export function readVoiceSettings(_root: string): VoiceSettings | null {
  const voice = /* readConfigValues(root)?.voice */ undefined; // Initial release.
  return voice === undefined ? null : voiceSchema.parse(voice);
}

/**
 * The voice the screen offers. Settings it cannot read offer none: the screen they are repaired from must still open,
 * and readiness, the settings reader and the voice routes go on reporting them.
 */
export function offeredVoice(root: string): VoiceSettings | null {
  try { return readVoiceSettings(root); } catch { return null; }
}

/** The permanent key never leaves this boundary. Only a restricted short-lived credential is returned. */
export async function createVoiceToken(settings: VoiceSettings, env: NodeJS.ProcessEnv = process.env, request = fetch) {
  if (settings.provider === 'local') return { provider: 'local' as const };
  const key = env[settings.api_key_env];
  if (!key) throw new Problem(PROBLEM_CODE.unavailable, `Missing ${settings.api_key_env}`, undefined,
    { reason: { kind: 'voice_key_missing', env: settings.api_key_env } });
  const soniox = settings.provider === 'soniox';
  const response = await request(settings.token_endpoint, {
    method: 'POST',
    headers: { Authorization: `${soniox ? 'Bearer' : 'Token'} ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(soniox
      ? { usage_type: 'transcribe_websocket', expires_in_seconds: 60, single_use: true, max_session_duration_seconds: 600 }
      : { ttl_seconds: 30 }),
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
  });
  if (!response.ok) throw new Problem(PROBLEM_CODE.unavailable, `${settings.provider} token request failed (${response.status})`, undefined,
    { reason: { kind: 'voice_token_request_failed', provider: settings.provider, status: response.status } });
  const value = z.record(z.string(), z.unknown()).safeParse(await response.json().catch(cause => {
    throw new Problem(PROBLEM_CODE.unavailable, `${settings.provider} token response was invalid`, undefined,
      { cause, reason: { kind: 'voice_token_response_invalid', provider: settings.provider } });
  }));
  const token = value.success ? value.data[soniox ? 'api_key' : 'access_token'] : null;
  if (typeof token !== 'string' || !token) throw new Problem(PROBLEM_CODE.unavailable, `${settings.provider} token response was invalid`, undefined,
    { reason: { kind: 'voice_token_response_invalid', provider: settings.provider } });
  return { token, provider: settings.provider, endpoint: settings.endpoint, model: settings.model,
    language_hints: settings.language_hints, terms: settings.terms };
}

const VOICE_BYTES = 16 * 1024 * 1024;

/** Bound uploads before multipart parsing; recordings are never persisted by the application. */
export async function transcribeVoice(settings: VoiceSettings, input: Request, request = fetch) {
  if (settings.provider !== 'local') throw new Problem(PROBLEM_CODE.invalidInput, 'Local voice is not configured', undefined, { reason: { kind: 'local_voice_not_configured' } });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input.body ?? []) {
    size += chunk.length;
    if (size > VOICE_BYTES) throw new Problem(PROBLEM_CODE.voiceTooLarge, 'Audio must be at most 16 MiB');
    chunks.push(chunk);
  }
  const form = await new Response(Buffer.concat(chunks), { headers: input.headers }).formData();
  const audio = form.get('file');
  if (!(audio instanceof File) || !audio.size)
    throw new Problem(PROBLEM_CODE.voiceEmpty, 'No recorded audio was provided');
  const outgoing = new FormData();
  outgoing.set('file', audio, 'recording');
  outgoing.set('model', settings.model);
  outgoing.set('language', settings.language);
  const result = await request(settings.endpoint, { method: 'POST', body: outgoing, redirect: 'error',
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(180_000)]) });
  if (!result.ok) throw new Problem(PROBLEM_CODE.voiceRecognitionFailed, `Local speech recognition failed (${result.status})`, { status: result.status });
  const value = z.object({ text: z.string().max(100_000) }).parse(await result.json());
  return { text: value.text };
}

/** Voice input is the person's screen's: `authorize` refuses anyone else before anything is read or sent. */
export function installVoiceRoutes(api: Hono, root: string, authorize: (request: Request) => void) {
  api.post('/api/voice/token', async c => {
    authorize(c.req.raw);
    const settings = readVoiceSettings(root);
    if (!settings) return c.notFound();
    return c.json(await createVoiceToken(settings), 200, { 'Cache-Control': 'no-store' });
  });
  api.post('/api/voice/transcriptions', async c => {
    authorize(c.req.raw);
    const settings = readVoiceSettings(root);
    if (!settings) return c.notFound();
    return c.json(await transcribeVoice(settings, c.req.raw), 200, { 'Cache-Control': 'no-store' });
  });
}
