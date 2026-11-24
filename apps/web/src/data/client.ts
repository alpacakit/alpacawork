import { withRequestActivity } from './request-activity';
import { RESTORE_HEADER, recoveryIdentitySchema } from '@alpacawork/contract/recovery';
import { rememberWriteIdentity, readWriteIdentity } from './write-identity';
import { validIntentConfirmation } from './write-intent';
import { writeAccess, writeRestoreId, workspaceWriteBasis, type WriteBasis } from './connection';
import { PROBLEM_RULE } from "@alpacawork/core/codes";
import type { z } from "zod";
import { i18n } from "@alpacawork/i18n";
import { selectionProblemText } from "@/features/forms/choice-text";
import { problemsToSay } from "@/features/forms/launch-selection";
import { problemSchema, type Issue, type ProblemBody, type ProblemReason } from "@alpacawork/contract/problem";

type Retry = ProblemBody["error"]["retry"];
/**
 * A failed request. `retry` is what the user can do next (the server's row for the code,
 * `packages/core/src/codes.ts`): fix, reread, later, or check. No answer, or an answer this
 * screen cannot read, is `check`: whether a write landed is not known.
 */
/**
 * A request refused only because an update's switch holds the workspace (every read but the update's is refused until
 * it goes on). The update's line says so; each read's own failure notice stays silent, as it does offline.
 */
export const heldByRelease = (error: unknown) => error instanceof ApiError && error.reason?.kind === "release_maintenance_incomplete";
/** Refused because serve does not know what this page asked: the page and serve are different versions (serve was updated). */
export const fromOtherVersion = (error: unknown) => error instanceof ApiError && error.reason?.kind === "unknown_endpoint";
/**
 * serve is not there yet or says to wait: no answer, a proxy saying it cannot reach serve (502/503/504, as while serve
 * restarts behind it), serve closing, or serve's own `later` for the code (busy). Asking again once serve answers is all
 * it needs. A read's `later` alone is not this: every read failure is asked again `later`, a broken one too.
 */
export const unreachable = (error: unknown) => error instanceof ApiError && (error.code === "network_error"
  || error.code === "http_error" && [502, 503, 504].includes((error.detail as { status?: number } | undefined)?.status ?? 0)
  || error.reason?.kind === "server_closing" || Object.hasOwn(PROBLEM_RULE, error.code) && PROBLEM_RULE[error.code as keyof typeof PROBLEM_RULE].retry === "later");
export class ApiError extends Error {
  constructor(
    private readonly text: string | (() => string),
    readonly code = "network_error",
    readonly retry: Retry = "check",
    /** The refusal's own facts (`error.detail`), unparsed; each caller reads what its contract defines. */
    readonly detail: unknown = undefined,
    readonly issues: readonly Issue[] = [],
    readonly reason?: ProblemReason,
  ) {
    super(typeof text === "function" ? text() : text);
  }
  get displayMessage() {
    if (this.reason) return problemReasonText(this.reason, this.issues);
    return typeof this.text === "function" ? this.text() : problemCodeText(this.code, this.retry, this.detail);
  }
}
/** A bounded file read stopped before retaining a body beyond its caller's byte budget. */
export class FileReadLimitError extends Error {
  constructor(readonly limit: number) { super(`File read exceeds ${limit} bytes`); }
}
/** Phrases one after another, a space between them, except before one that opens with a full-width bracket, which
 * brings its own room. */
function phrases(parts: string[]): string {
  return parts.reduce((text, part) => !text || part.startsWith('（') ? text + part : `${text} ${part}`, '');
}

/** One translation of the reason and all of its parameters, independent of retry guidance. */
export function problemReasonText(reason: ProblemReason, issues: readonly Issue[] = []): string {
  const technical = (diagnostic: string) => i18n.t('problem.technical', { diagnostic });
  switch (reason.kind) {
    case 'update_refused': return [i18n.t('problem.reason.update_refused', { reason: reason.reason }),
      ...(reason.cause ? [problemReasonText(reason.cause)] : [])].join(': ');
    case 'installation_record_unavailable': return i18n.t('problem.reason.installation_record_unavailable',
      { path: reason.path, cause: problemReasonText(reason.cause) });
    case 'run_store_unavailable': return i18n.t('problem.context.runs', { cause: problemReasonText(reason.cause) });
    case 'push_unavailable': return i18n.t('problem.context.push', { cause: problemReasonText(reason.cause) });
    case 'authorization_required': return i18n.t('problem.authorization.required', { action: reason.action,
      grants: reason.grants.map(([seat, ...conditions]) => phrases([i18n.t(`problem.authorization.seat.${seat}`),
        ...conditions.map(condition => i18n.t(`problem.authorization.condition.${condition}`))])).join(i18n.t('problem.authorization.or')) });
    case 'voice_stream_failed': return reason.diagnostic
      ? i18n.t('problem.reason.voice_stream_failed', { ...reason })
      : i18n.t('voice.providerFailed');
    case 'agent_command_unavailable': return i18n.t(`problem.executable.${reason.detail}`, { path: reason.path });
    case 'host_failure': return i18n.t(`problem.host.${reason.operation}`, { cause: problemReasonText(reason.cause) });
    case 'system_error': return [i18n.t('problem.reason.system_error', { ...reason, syscall: reason.syscall ?? '', path: reason.path ?? '', dest: reason.dest ?? '' }), technical(reason.diagnostic)].join(' · ');
    case 'unexpected_error': return [i18n.t('problem.reason.unexpected_error', { name: reason.name }), technical(reason.diagnostic)].join(' · ');
    // The resolver's evidence: what each previous value needs, as a launch choice says it (choice-text.ts).
    // Choosing again is the general advice, unless the conversation cannot go on: then only how to start anew is said.
    case 'selection_required': {
      const said = problemsToSay(reason.problems);
      return [...said.some(problem => problem.recovery === 'new_conversation') ? [] : [i18n.t('problem.reason.selection_required')],
        ...said.map(problem => selectionProblemText(problem))].join(' ');
    }
    case 'validation_error': return [i18n.t('problem.reason.validation_error'),
      ...issues.map(issue => [issue.path, issue.params?.line === undefined ? '' : i18n.t('problem.location', { line: issue.params.line, column: issue.params.column ?? 1 }),
        issue.code, technical(issue.message)].filter(Boolean).join(' · '))].join(' · ');
    case 'config_invalid': return [i18n.t(`problem.reason.${reason.kind}`, { path: 'path' in reason ? reason.path : '' }),
      ...reason.issues.map(issue => [issue.path, issue.line === undefined ? '' : i18n.t('problem.location', { line: issue.line, column: issue.column ?? 1 }), issue.code, technical(issue.diagnostic)].filter(Boolean).join(' · '))].join(' · ');
    default: return i18n.t(`problem.reason.${reason.kind}`, { ...reason });
  }
}
/** A read boundary supplies operation context only when the server supplied no more precise reason. */
export function readErrorWithReason<T>(error: T, reason: ProblemReason): T | ApiError {
  return error instanceof ApiError && !error.reason && Object.hasOwn(PROBLEM_RULE, error.code)
    ? Object.assign(new ApiError(error.message, error.code, error.retry, error.detail, error.issues, reason), { cause: error }) : error;
}
export async function readWithReason<T>(read: () => Promise<T>, reason: ProblemReason): Promise<T> {
  try { return await read(); }
  catch (error) { throw readErrorWithReason(error, reason); }
}
/** Why a file of the workspace could not be read, as the index's errors name it. */
export const readProblemText = ({ reason, code }: { reason?: ProblemReason | null; code: string }) => reason ? problemReasonText(reason) : problemCodeText(code);

/** API diagnostics stay in Error.message; only machine facts select screen text. */
export function problemCodeText(code: string, retry?: Retry, detail?: unknown): string {
  if (code === "network_error") return i18n.t("workspace.networkError");
  if (code === "invalid_response") return i18n.t("workspace.invalidResponse");
  const guidance = retry ?? Object.entries(PROBLEM_RULE).find(([name]) => name === code)?.[1].retry ?? "check";
  const problemKey = `problem.code.${code}`;
  const status = detail && typeof detail === "object" && "status" in detail && typeof detail.status === "number" ? detail.status : undefined;
  return i18n.exists(problemKey, { ns: "translation" }) ? i18n.t(problemKey, { status }) : i18n.t(`problem.retry.${guidance}`);
}
export function errorText(error: unknown): string {
  return error instanceof ApiError ? error.displayMessage : i18n.t("problem.retry.fix");
}
/** All HTTP adapters preserve refusal facts while keeping diagnostic prose out of presentation. */
export function apiError(error: ProblemBody["error"]): ApiError {
  return new ApiError(error.message, error.code, error.retry, error.detail, error.issues, error.reason);
}
/** Any failure that is not an ApiError is a fault in this screen: nothing was sent, so it is refused as is. */
export function retryOf(error: unknown): Retry {
  return error instanceof ApiError ? error.retry : "fix";
}
/**
 * What is left unknown by no answer, an answer this screen cannot read, or serve's own `check`: a write may have
 * landed (check); a read wrote nothing and is asked again (later).
 */
const next = (data: unknown): Retry => data === undefined ? "later" : "check";
const noAnswer = (cause: unknown, data?: unknown) => Object.assign(new ApiError(() => i18n.t("workspace.networkError"), "network_error", next(data)), { cause });
/** How long this screen waits for a whole answer, from sending through its last byte. */
const deadlineOf = (data: unknown) => AbortSignal.timeout(data === undefined ? 10_000 : 20_000);
/**
 * The deadline passed before the answer was whole, or began. Told from its own signal: what a browser rejects the fetch or
 * the body with then is its choice (Chromium's `json()` says AbortError). `error.cause` keeps what it said.
 */
export class DeadlinePassed extends ApiError {
  constructor(cause: unknown, data?: unknown) {
    super(() => i18n.t("workspace.networkError"), "network_error", next(data));
    this.cause = cause;
  }
}
/** The failure of a request whose deadline passed; the caller's own abort stays its own, and anything else its caller's. */
function throwIfPast(deadline: AbortSignal, signal: AbortSignal | undefined, cause: unknown, data?: unknown) {
  if (deadline.aborted && !signal?.aborted) throw new DeadlinePassed(cause, data);
}
/**
 * A read the server stayed silent on is asked again a few times, with a growing wait, before its failure is said where
 * it is read: a request made while the server is busy would otherwise fail for good moments before it answers again.
 */
export const READ_RETRIES = 3;
export const readRetryDelay = (failures: number) => Math.min(30_000, 1000 * 2 ** failures);
/**
 * A read the server stayed silent on until the deadline. It wrote nothing and nothing was said about it, and a server
 * that is busy answers soon after, so it is one to ask again (query-client, lane-batch). A connection that fails at once
 * is the feed's to report, and a server's own "later" is an answer: both are said where they are read.
 */
export function readDeadlinePassed(error: unknown): boolean {
  return error instanceof DeadlinePassed && error.retry === "later";
}
export function requireWriteAccess(basis?: WriteBasis) {
  const access = writeAccess(basis);
  if (access === 'offline') throw new ApiError(() => i18n.t('workspace.networkError'), 'write_unavailable', 'later');
  if (access === 'forbidden') throw new ApiError('Write refused by current read authority', 'forbidden', 'fix');
  if (access === 'conflict') throw new ApiError('Write basis no longer matches current reads', 'conflict', 'reread');
}
/** Admission may establish evidence; a continuation must retain the operation's existing evidence. */
function writeHeaders(basis: WriteBasis, opId: string, initial: HeadersInit, identity: () => string | null): Headers {
  requireWriteAccess(basis);
  let pinned: string | null;
  try { pinned = identity(); }
  catch (cause) { throw Object.assign(new ApiError('Cannot preserve write identity', 'write_unavailable', 'fix'), { cause }); }
  if (pinned === null) throw new ApiError('This operation has no proven restore identity; check its result', 'restore_changed', 'fix');
  const headers = new Headers(initial); headers.set(RESTORE_HEADER, pinned); headers.set('X-Alpacawork-Op-Id', opId); return headers;
}
/** Workspace mutations use this wire boundary, including XHR and ephemeral activity/voice requests. */
export function mutationHeaders(basis: WriteBasis = workspaceWriteBasis(), opId: string = crypto.randomUUID(), initial: HeadersInit = {}): Headers {
  return writeHeaders(basis, opId, initial, () => rememberWriteIdentity(basis.root, opId, writeRestoreId(basis.root)));
}
/** An operation already admitted by its owner must never acquire a replacement pin. */
export function continuingMutationHeaders(basis: WriteBasis, opId: string, initial: HeadersInit = {}): Headers {
  return writeHeaders(basis, opId, initial, () => readWriteIdentity(basis.root, opId));
}
export function createApi() {
  async function responseFor(url: string, deadline: AbortSignal, signal?: AbortSignal, data?: unknown, opId?: string, basis?: WriteBasis, keepalive = false, execution?: Headers): Promise<Response> {
    if (data !== undefined && !execution) {
      if (!basis) throw new ApiError('Write basis is required', 'write_unavailable', 'later');
      requireWriteAccess(basis);
      if (basis.kind === 'confirmation' && !validIntentConfirmation(basis.confirmation, basis.root, data, opId)) throw new ApiError('Recorded operation changed', 'write_unavailable', 'later');
    }
    const headers = execution ?? (data === undefined ? {} : mutationHeaders(basis, opId, { 'Content-Type': 'application/json' }));
    let response: Response;
    try {
      response = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        method: data === undefined ? "GET" : "POST",
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
        ...(keepalive ? { keepalive: true } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throwIfPast(deadline, signal, error, data);
      throw noAnswer(error, data);
    }
    if (!response.ok) {
      const problem = problemSchema.safeParse(await response.json().catch(() => null));
      if (!problem.success) throw new ApiError(`HTTP ${response.status}`, response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : "http_error", next(data), { status: response.status });
      const { message, code, retry, detail, issues, reason } = problem.data.error;
      throw new ApiError(message, code, retry === "check" ? next(data) : retry, detail, issues, reason);
    }
    return response;
  }
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    data?: unknown,
    opId?: string,
    basis?: WriteBasis,
    keepalive = false,
    deadlineMs?: number,
    execution?: Headers,
  ): Promise<T> {
    return withRequestActivity(async () => {
      const deadline = deadlineMs === undefined ? deadlineOf(data) : AbortSignal.timeout(deadlineMs);
      const response = await responseFor(`/api/${path}`, deadline, signal, data, opId, basis, keepalive, execution);
      try {
        const body: unknown = await response.json();
        const value = schema.parse(body);
        return value;
      } catch (cause) {
        throwIfPast(deadline, signal, cause, data);
        throw Object.assign(new ApiError(() => i18n.t("workspace.invalidResponse"), "invalid_response", next(data)), { cause });
      }
    });
  }
  async function requestText(url: string, signal?: AbortSignal): Promise<string> {
    return withRequestActivity(async () => {
      const deadline = deadlineOf(undefined);
      const response = await responseFor(url, deadline, signal);
      try { return await response.text(); }
      catch (cause) {
        throwIfPast(deadline, signal, cause);
        throw Object.assign(new ApiError(() => i18n.t("workspace.invalidResponse"), "invalid_response", "later"), { cause });
      }
    });
  }
  async function requestBytes(url: string, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
    return withRequestActivity(async () => {
      const deadline = deadlineOf(undefined);
      const response = await responseFor(url, deadline, signal);
      const reader = response.body?.getReader();
      if (!reader) return new Uint8Array();
      try {
        if (Number(response.headers.get("content-length")) > limit) throw new FileReadLimitError(limit);
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new FileReadLimitError(limit);
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes;
      } catch (cause) {
        // Cancellation can itself fail when the network stream has already failed; preserve the original failure.
        await reader.cancel().catch(() => undefined);
        if (cause instanceof FileReadLimitError || signal?.aborted) throw cause;
        throwIfPast(deadline, signal, cause);
        throw Object.assign(new ApiError(() => i18n.t("workspace.invalidResponse"), "invalid_response", "later"), { cause });
      } finally { reader.releaseLock(); }
    });
  }
  /** A read the server itself takes long over (it bounds the work), so this screen waits longer than that bound. */
  const readWithin = <T,>(path: string, schema: z.ZodType<T>, deadlineMs: number, signal?: AbortSignal) =>
    request(path, schema, signal, undefined, undefined, undefined, false, deadlineMs);
  /** Execute once, pinned to the restore identity observed before the request. */
  async function runWithin<T>(path: string, schema: z.ZodType<T>, data: Record<string, unknown>, deadlineMs: number, signal?: AbortSignal) {
    const restoreId = writeRestoreId(workspaceWriteBasis().root)
      ?? (await request('runtime/recovery', recoveryIdentitySchema, signal)).restoreId;
    const headers = new Headers({ [RESTORE_HEADER]: restoreId, 'Content-Type': 'application/json' });
    return request(path, schema, signal, data, undefined, undefined, false, deadlineMs, headers);
  }
  return { request, requestText, requestBytes, readWithin, runWithin };
}
