/** What a request says about its caller and how its JSON answers, shared by the server and its read thread. */
import { mcpRelayHeader, mcpSourceHeader } from '@alpacawork/contract/mcp';
import { DIGEST_PATTERN, RUN_ID_PATTERN } from '@alpacawork/raw';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { ACTIONS, decide, runMayDo, type Action, type Act, type Caller } from '../control/authorize.js';
import { resolveCaller, type CallerClaim } from '../control/credentials.js';

const RUN_CREDENTIAL = new RegExp(`^Alpacawork-Run (${RUN_ID_PATTERN}):(${DIGEST_PATTERN})$`);
/**
 * What a request's headers claim about its caller, for resolveCaller: a Run's credential (`Authorization`) or the agent
 * conversation it comes from (`X-Alpacawork-Provider` with `X-Alpacawork-Conversation`), never both. A CLI `task report`
 * also names its operation (`X-Alpacawork-Op-Id`), so that a report sent again after its Run ended goes through.
 */
export function claimOf(headers: Headers, report = false, internalMcp = false): CallerClaim {
  if ((!internalMcp && headers.has(mcpSourceHeader)) || headers.has(mcpRelayHeader))
    throw new Problem(PROBLEM_CODE.forbidden, 'Invalid direct conversation headers', undefined,
      { reason: { kind: 'invalid_direct_conversation_headers' } });
  const authorization = headers.get('authorization');
  const credential = authorization ? RUN_CREDENTIAL.exec(authorization) : null;
  if (authorization && !credential)
    throw new Problem(PROBLEM_CODE.forbidden, 'Invalid Run authorization header', undefined, { reason: { kind: 'invalid_run_authorization_header' } });
  const provider = headers.get('x-alpacawork-provider');
  const conversationId = headers.get('x-alpacawork-conversation');
  if ((provider === null) !== (conversationId === null) ||
      provider !== null && provider !== 'claude' && provider !== 'codex' ||
      conversationId !== null && (!conversationId || conversationId.length > 256) ||
      credential && provider !== null)
    throw new Problem(PROBLEM_CODE.forbidden, 'Invalid direct conversation headers', undefined, { reason: { kind: 'invalid_direct_conversation_headers' } });
  const replayOpId = report ? headers.get('x-alpacawork-op-id') : null;
  return {
    ...(internalMcp ? { mcp: true as const } : {}),
    ...(credential ? { run: { runId: credential[1]!, token: credential[2]! } } : {}),
    ...((provider === 'claude' || provider === 'codex') && conversationId ? { direct: { provider, conversationId } } : {}),
    ...(replayOpId ? { replayOpId } : {}),
  };
}
/** What one request claims about its caller and the working directory its CLI sent (`X-Alpacawork-Cwd`). */
export function requestScope(headers: Headers, cli: boolean, replayFromRun = false, internalMcp = false):
  { claim: CallerClaim; cwd: string | null } {
  const claim = claimOf(headers, replayFromRun, internalMcp);
  const sent = cli ? headers.get('x-alpacawork-cwd') : null;
  try { return { claim, cwd: sent === null ? null : decodeURIComponent(sent) }; }
  catch { throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid X-Alpacawork-Cwd', undefined, { reason: { kind: 'invalid_x_alpacawork_cwd' } }); }
}
/**
 * resolveCaller on a read of the control database, where a Run's session may still be imported; inside a write it is
 * asked again on the write's own connection (`identifyIn`).
 */
export function identify(root: string, claim: CallerClaim): Caller {
  const store = RunStore.openReadable(root, { busyTimeoutMs: 1000 });
  try { return resolveCaller(root, claim, store); } finally { store?.close(); }
}

export const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** An already decisive direct refusal must not import an unrelated Run while identifying the conversation. */
export function preflightEntryClaim(root: string, act: Action | null | undefined, claim: CallerClaim): void {
  if (!act || !claim.direct || !(act.name in ACTIONS) || runMayDo(act.name as Act)) return;
  const caller = resolveCaller(root, claim, null, false);
  const decision = decide(caller, act, { task: null, runProject: null, runState: null, quote: null });
  if (decision instanceof Problem) throw decision;
}
