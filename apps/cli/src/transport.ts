import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { problemSchema } from '@alpacawork/contract/problem';

export function actorHeaders(env: NodeJS.ProcessEnv): Headers {
  const headers = new Headers();
  const run = env.ALPACAWORK_RUN, token = env.ALPACAWORK_RUN_TOKEN;
  if ((run === undefined) !== (token === undefined))
    throw new Problem(PROBLEM_CODE.invalidInput, 'ALPACAWORK_RUN and ALPACAWORK_RUN_TOKEN must be supplied together');
  if (run !== undefined && token !== undefined) {
    if (!/^R[1-9][0-9]*$/.test(run) || !/^[a-f0-9]{64}$/.test(token))
      throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid Run credential');
    headers.set('Authorization', `Alpacawork-Run ${run}:${token}`);
    return headers;
  }
  const claude = env.CLAUDE_CODE_SESSION_ID;
  const codex = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  if (claude && codex) throw new Problem(PROBLEM_CODE.invalidInput, 'Ambiguous direct conversation identity');
  if (claude || codex) {
    headers.set('X-Alpacawork-Provider', claude ? 'claude' : 'codex');
    headers.set('X-Alpacawork-Conversation', (claude || codex)!);
  }
  return headers;
}

function unavailable(message: string): Problem {
  return new Problem(PROBLEM_CODE.unavailable, message);
}

/** One attempt's budget, response body included. */
export const ATTEMPT_MS = 30_000;

/** A redirect is never followed: it could carry the credentials and the body to another place. */
function refuseRedirect(response: Response): void {
  if (response.status >= 300 && response.status < 400)
    throw new Problem(PROBLEM_CODE.invalidInput, 'Server redirect refused');
}
/**
 * A request went out and no whole answer came back, which is all the transport knows: a read saved nothing, and what
 * it means for a save is write-attempt's to say.
 */
export class LostAnswer extends Problem {
  constructor(readonly seen: 'no_answer' | 'incomplete') {
    super(PROBLEM_CODE.unavailable, seen === 'no_answer' ? 'The server gave no answer' : 'Incomplete server response');
  }
}
/** A refused response's body as the server's Problem; anything else is an incomplete answer. */
function refusal(body: unknown): Error {
  const parsed = problemSchema.safeParse(body);
  return parsed.success ? new RemoteProblem(parsed.data) : new LostAnswer('incomplete');
}

export async function request(origin: string, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  input: Record<string, unknown> | Uint8Array | undefined, headers: Headers, timeoutMs = 30_000): Promise<unknown> {
  return sendPrepared(prepareRequest(origin, path, method, input, headers),timeoutMs);
}

/** A private snapshot, made before sending: no input, environment or file is read by a retry. */
export type PreparedRequest = Readonly<{ url: string; method: string; headers: readonly (readonly [string, string])[];
  body: string | Uint8Array | undefined }>;
export function prepareRequest(origin: string, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  input: Record<string, unknown> | Uint8Array | undefined, originalHeaders: Headers): PreparedRequest {
  const headers = new Headers(originalHeaders);
  const url = new URL(path, origin);
  if (method === 'GET' && input && !(input instanceof Uint8Array))
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
  let body: string | Uint8Array | undefined;
  if (method !== 'GET' && input !== undefined) {
    if (input instanceof Uint8Array) body = Uint8Array.from(input);
    else { body = JSON.stringify(input); headers.set('Content-Type', 'application/json'); }
  }
  return Object.freeze({ url: url.href, method, headers: Object.freeze([...headers].map(pair => Object.freeze(pair))), body });
}

/** One attempt, including response body reading, under the caller's remaining budget. */
export async function sendPrepared(prepared: PreparedRequest, timeoutMs = ATTEMPT_MS): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(prepared.url, { method: prepared.method, headers: new Headers(prepared.headers.map(([key, value]): [string, string] => [key, value])),
      body: prepared.body as BodyInit | undefined, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    throw code === 'ECONNREFUSED' || code === 'ENOTFOUND' ? unavailable('Server not reached') : new LostAnswer('no_answer');
  }
  refuseRedirect(response);
  let text: string;
  try { text = await response.text(); }
  catch { throw new LostAnswer('no_answer'); }
  let result: unknown;
  try { result = JSON.parse(text); }
  catch { throw new LostAnswer('incomplete'); }
  if (!response.ok) throw refusal(result);
  return result;
}

export class RemoteProblem extends Error {
  constructor(readonly body: ReturnType<typeof problemSchema.parse>) { super(body.error.message); }
}

export async function requestBytes(origin: string, path: string, headers: Headers): Promise<Uint8Array> {
  let response: Response;
  try { response = await fetch(new URL(path, origin), { headers, redirect: 'manual', signal: AbortSignal.timeout(ATTEMPT_MS) }); }
  catch { throw unavailable('Server not reached'); }
  refuseRedirect(response);
  if (!response.ok) {
    let result: unknown;
    try { result = await response.json(); } catch { throw new LostAnswer('incomplete'); }
    throw refusal(result);
  }
  try { return new Uint8Array(await response.arrayBuffer()); }
  catch { throw new LostAnswer('incomplete'); }
}
