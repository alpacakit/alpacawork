/** Server-only System One boundary. Saving settings never calls this API. No retries or policy decisions. */
import { z } from 'zod';
import { jevSettingsSchema, type JevSettings } from '@alpacawork/contract';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
// import { readConfigValues } from './config.js'; // Initial release: Jev settings stay disconnected.

export function parseJevSettings(value: unknown): JevSettings {
  const result = jevSettingsSchema.safeParse(value === undefined ? {} : value);
  if (!result.success) throw new Problem(PROBLEM_CODE.invalidSettings, 'Invalid Jev settings', undefined,
    { reason: { kind: 'validation_error', issues: result.error.issues.map(issue => ({
      code: issue.code, path: ['jev', ...issue.path].join('.'), diagnostic: issue.message })) } });
  return result.data;
}

/** Reread on every call: setting or removing a URL takes effect without a server restart. */
export function readJevSettings(_root: string): JevSettings | null {
  // const values = readConfigValues(root);
  // if (values === null) return null;
  const settings = parseJevSettings(/* values.jev */ undefined); // Initial release.
  return settings.endpoint ? settings : null;
}

const content = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]);
const instructions = content.nullable().optional();
const question = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions,
    criteria: z.object({ true: content.nullable().optional(), false: content.nullable().optional() }).strict().nullable().optional() }).strict(),
  z.object({ type: z.literal('choice'), instructions,
    criteria: z.record(z.string(), content.nullable()).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 255) }).strict(),
  z.object({ type: z.literal('score'), instructions, criteria: z.array(content).min(1).max(10) }).strict(),
]);
const requestSchema = z.object({ state: content, questions: z.record(z.string(), question)
  .refine(value => Object.keys(value).length > 0) }).strict();
export type JevRequest = z.infer<typeof requestSchema>;
const probability = z.number().finite().min(0).max(1);
const probabilities = z.record(z.string(), probability);
const answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({ type: z.literal('choice'), choice: z.string(), confidence: probability, probabilities }),
  z.object({ type: z.literal('score'), score: z.number().finite(), confidence: probability,
    legend: z.record(z.string(), content), probabilities }),
]);
const responseSchema = z.object({ model: z.string().min(1), answers: z.record(z.string(), answer),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }) });
export type JevResponse = z.infer<typeof responseSchema>;
export type JevFailure = 'disabled' | 'key_missing' | 'invalid_request' | 'http' | 'timeout' | 'cancelled' | 'network' | 'invalid_response';
/** Safe context only: upstream bodies, state and credentials are never attached to an error. */
export class JevError extends Error {
  constructor(readonly code: JevFailure, readonly status?: number, options?: ErrorOptions) {
    super(`Jev ${code}${status === undefined ? '' : ` (${status})`}`, options);
    this.name = 'JevError';
  }
}
const sameKeys = (left: object, right: object) => {
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.hasOwn(right, key));
};
function matchesQuestions(response: JevResponse, input: JevRequest): boolean {
  if (!sameKeys(response.answers, input.questions)) return false;
  return Object.entries(input.questions).every(([name, q]) => {
    const a = response.answers[name]!;
    if (q.type !== a.type) return false;
    if (q.type === 'choice' && a.type === 'choice')
      return Object.hasOwn(q.criteria, a.choice) && sameKeys(q.criteria, a.probabilities);
    if (q.type === 'score' && a.type === 'score')
      return a.score >= 0 && a.score <= q.criteria.length - 1 && sameKeys(q.criteria, a.legend) && sameKeys(q.criteria, a.probabilities);
    return true;
  });
}
export type JevCallOptions = { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; request?: typeof fetch };

/**
 * Reusable entry for later backend features. Endpoint/model/auth come only from server settings.
 * Supports the official text/JSON Noul, Choice and Score contract; image/Box extensions are out of scope.
 * Confidence is returned unchanged; callers own interpretation and actions.
 */
export async function evaluateJev(root: string, input: JevRequest, options: JevCallOptions = {}): Promise<JevResponse> {
  const settings = readJevSettings(root);
  if (!settings) throw new JevError('disabled');
  const parsed = requestSchema.safeParse(input);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!parsed.success || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new JevError('invalid_request');
  const key = (options.env ?? process.env)[settings.api_key_env];
  if (!key?.trim()) throw new JevError('key_missing');
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    signal.throwIfAborted();
    const result = await (options.request ?? fetch)(settings.endpoint, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.model, ...parsed.data }), signal, redirect: 'error' });
    if (!result.ok) {
      let cleanupCause: Error | undefined;
      try { await result.body?.cancel(); }
      catch {
        // The received HTTP rejection stays authoritative. Surface cleanup separately without upstream details.
        cleanupCause = new Error('HTTP response body cleanup failed');
      }
      throw new JevError('http', result.status, cleanupCause ? { cause: cleanupCause } : undefined);
    }
    const text = await result.text();
    signal.throwIfAborted();
    let body: unknown;
    try { body = JSON.parse(text); }
    catch { throw new JevError('invalid_response'); }
    const value = responseSchema.safeParse(body);
    if (!value.success || !matchesQuestions(value.data, parsed.data)) throw new JevError('invalid_response');
    return value.data;
  } catch (cause) {
    if (options.signal?.aborted) throw new JevError('cancelled');
    if (deadline.aborted) throw new JevError('timeout');
    if (cause instanceof JevError) throw cause;
    throw new JevError('network');
  }
}
