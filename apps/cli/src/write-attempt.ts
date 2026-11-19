/** Owns a CLI write's identity, immutable request, budget and unresolved save result. */
import { randomUUID } from 'node:crypto';
import { errorBody, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { ATTEMPT_MS, LostAnswer, RemoteProblem, sendPrepared, type PreparedRequest } from './transport.js';

const SAVE_UNKNOWN = 'Save result unknown; check operation with the same op-id';
/** A lost answer may follow a completed save. */
const SAVE_WORDS = { no_answer: SAVE_UNKNOWN, incomplete: 'Incomplete server response; check operation with the same op-id' };

export function operationId(explicit: unknown): string {
  if (explicit === undefined) return randomUUID();
  if (typeof explicit !== 'string' || !explicit.trim())
    throw new Problem(PROBLEM_CODE.invalidInput, '--op-id must not be empty');
  return explicit;
}

type Clock = { now: () => number; wait: (ms: number) => Promise<void> };
const clock: Clock = { now: () => performance.now(), wait: ms => new Promise(resolve => setTimeout(resolve, ms)) };
/** POSIX shell quoting, including literal dollar substitutions, backticks and single quotes. */
const shellArgument = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
/** Injection is local to tests; production always uses the same three-attempt / 65-second budget. */
export async function writeAttempt(prepared: PreparedRequest, opId: string, server: string,
  runtime: Clock = clock, send: typeof sendPrepared = sendPrepared,
  pin?: (prepared:PreparedRequest,opId:string,server:string,timeoutMs:number)=>Promise<PreparedRequest>): Promise<unknown> {
  const deadline = runtime.now() + 65_000;
  let pinned = pin ? undefined : prepared;
  let attempts = 0, postAttempts = 0, unconfirmed = false;
  let last: RemoteProblem['body'] | undefined;
  const remaining = () => Math.max(1, Math.floor(Math.min(ATTEMPT_MS, deadline - runtime.now())));
  while (attempts < 3 && runtime.now() < deadline) {
    attempts++;
    let sending = false;
    try {
      // One immutable winner, retained after the first successful GET across every later write.
      pinned ??= await pin!(prepared, opId, server, remaining());
      if (runtime.now() >= deadline) {
        last = errorBody(new Problem(PROBLEM_CODE.unavailable, 'Recovery identity budget exhausted before write'));
        break;
      }
      sending = true; postAttempts++;
      return await send(pinned, remaining());
    }
    catch (error) {
      last = error instanceof RemoteProblem ? error.body
        : errorBody(sending && error instanceof LostAnswer ? new Problem(error.code, SAVE_WORDS[error.seen]) : error);
      unconfirmed ||= sending && last.error.retry === 'check';
      if (last.error.retry !== 'check' || last.error.code === PROBLEM_CODE.publicationNeedsReview || attempts === 3) break;
      const delay = attempts === 1 ? 250 : 1000;
      if (runtime.now() + delay >= deadline) break;
      await runtime.wait(delay);
    }
  }
  const failure = last ?? errorBody(new Problem(PROBLEM_CODE.saveUnconfirmed, 'Save result unknown'));
  const unresolved = unconfirmed && failure.error.retry !== 'check';
  const result = unresolved
    ? errorBody(new Problem(PROBLEM_CODE.saveUnconfirmed, SAVE_UNKNOWN))
    : failure;
  const detail = result.error.detail;
  result.error.detail = {
    ...(typeof detail === 'object' && detail !== null && !Array.isArray(detail) ? detail : detail === undefined ? {} : { originalDetail: detail }),
    ...(unresolved ? { lastFailure: failure.error } : {}),
    operation: { opId, attempts, postAttempts, server, checkCommand: `alpacawork --server ${shellArgument(server)} operation get --op-id ${shellArgument(opId)}` },
  };
  throw new RemoteProblem(result);
}
