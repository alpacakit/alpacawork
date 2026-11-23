import { faultReasonSchema, type FaultReason, type ProblemReason } from './reasons.js';
import { EntryInputError } from '@alpacakit/channels';
import { config, ZodError, type ZodType, type output } from 'zod';
import en from 'zod/v4/locales/en.js';
import { redactSecrets } from './redact.js';
import { toIssues, type Issue } from './issues.js';
export { toIssues, type Issue } from './issues.js';

import { PROBLEM_CODE, PROBLEM_RULE, type ProblemCode } from './codes.js';
export { PROBLEM_CODE, PROBLEM_RULE, RETRY, type ProblemCode, type Retry } from './codes.js';

// Zod's default locale setup is marked side-effect-free and can disappear in a bundle.
// Every entry reports the same concrete English validation reasons.
config(en());

/**
 * A failure the server answers with. It names its code; the code's row in `PROBLEM_RULE`
 * decides the HTTP status and what the receiver does next (`retry`).
 */
export class Problem extends Error {
  readonly issues?: readonly Issue[];
  readonly reason?: ProblemReason;
  constructor(
    readonly code: ProblemCode,
    message: string,
    readonly detail?: unknown,
    options?: ErrorOptions & { issues?: readonly Issue[]; reason?: ProblemReason },
  ) {
    super(message, options);
    this.reason = options?.reason;
    if (options?.issues?.length) this.issues = options.issues;
  }
  get status() { return PROBLEM_RULE[this.code].status; }
  get retry() { return PROBLEM_RULE[this.code].retry; }
}
/** Preserve dynamic library facts without treating diagnostic prose as a translation key. */
export function faultReason(error: unknown): FaultReason {
  if (error instanceof Problem) {
    const reason = faultReasonSchema.safeParse(error.reason);
    if (reason.success) return reason.data;
    if (error.cause) return faultReason(error.cause);
  }
  if (error instanceof ZodError) return { kind: 'validation_error', issues: error.issues.map(issue => ({
    code: issue.code, path: issue.path.map(String).join('.'), diagnostic: redactSecrets(issue.message) })) };
  const diagnostic = redactSecrets(error instanceof Error ? error.message : String(error));
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return { kind: 'system_error', code: error.code, diagnostic,
      ...('syscall' in error && typeof error.syscall === 'string' ? { syscall: error.syscall } : {}),
      ...('path' in error && typeof error.path === 'string' ? { path: redactSecrets(error.path) } : {}),
      ...('dest' in error && typeof error.dest === 'string' ? { dest: redactSecrets(error.dest) } : {}) };
  }
  return { kind: 'unexpected_error', name: error instanceof Error ? error.name : typeof error, diagnostic };
}
export function failure(error: unknown): Problem {
  if (error instanceof Problem) return error;
  if (hasCode(error, 'ERR_SQLITE_ERROR') &&
      typeof error === 'object' && error !== null && 'errcode' in error &&
      (error.errcode === 5 || error.errcode === 6))
    return new Problem(PROBLEM_CODE.busy, 'Database is busy; retry later', undefined, { cause: error, reason: { kind: 'database_busy' } });
  if (error instanceof EntryInputError) {
    const path = error.target.kind === 'parameter' ? error.target.parameterName : '';
    const message = redactSecrets(error.message);
    return new Problem(PROBLEM_CODE.invalidInput, message, undefined,
      { reason: { kind: 'validation_error' }, cause: error, issues: error.issues.map(text => ({ path, code: 'invalid_type', message: redactSecrets(text) })) });
  }
  return new Problem(
    PROBLEM_CODE.unavailable,
    redactSecrets(error instanceof Error ? error.message : 'Operation failed'),
    undefined,
    { cause: error, reason: faultReason(error) },
  );
}
/** Check one public entry's values before any command or service uses them. */
export function parseInput<Schema extends ZodType>(schema: Schema, value: unknown): output<Schema> {
  try { return schema.parse(value) as output<Schema>; }
  catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const issues = toIssues(error.issues);
    const first = issues[0];
    throw new Problem(PROBLEM_CODE.invalidInput, first ? `${first.path ? `${first.path}: ` : ''}${first.message.split('\n')[0]}` : 'Invalid input', undefined,
      { reason: { kind: 'validation_error' }, cause: error, issues });
  }
}
export function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
export function errorBody(error: unknown) {
  const e = failure(error);
  const reason = e.reason?.kind === 'validation_error' ? { kind: 'validation_error' as const } : e.reason;
  const issues = e.issues ?? (e.reason?.kind === 'validation_error' ? e.reason.issues?.map(issue => {
    const { diagnostic, code, path = '', line, column } = issue;
    const params = { ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
    return { code, path, message: diagnostic, ...(Object.keys(params).length ? { params } : {}) };
  }) : undefined);
  return { error: { code: e.code, message: e.message, retry: e.retry,
    ...(reason ? { reason } : {}),
    ...(issues ? { issues: [...issues] } : {}), ...(e.detail ? { detail: e.detail } : {}) } };
}

// Keep each native weak hash table small: resizing one process-wide table can block the event loop.
// Immutable record IDs distribute the long-lived records; other values use a bounded recent memo.
const frozenBuckets = Array.from({ length: 256 }, () => ({ recent: new WeakSet<object>(), previous: new WeakSet<object>(), count: 0 }));
function frozenBucket(value: object) {
  const id: unknown = Object.getOwnPropertyDescriptor(value, 'id')?.value;
  let hash = 0;
  if (typeof id === 'string') for (let index = 0; index < id.length; index++) hash = Math.imul(hash, 31) + id.charCodeAt(index) | 0;
  else if (typeof id === 'number') hash = id | 0;
  return frozenBuckets[hash & 255]!;
}
/** Freezes a value and all it holds. A frozen parent does not prove its children are frozen. */
export function deepFreeze<T>(value: T, seen?: WeakSet<object>): T {
  if (value === null || typeof value !== 'object') return value;
  const memo = frozenBucket(value);
  if (memo.recent.has(value) || memo.previous.has(value) || seen?.has(value)) return value;
  seen ??= new WeakSet<object>();
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  Object.freeze(value);
  if (memo.count >= 2048) { memo.previous = memo.recent; memo.recent = new WeakSet<object>(); memo.count = 0; }
  memo.recent.add(value); memo.count++;
  seen.delete(value);
  return value;
}

/**
 * A stored JSON text decoded with its schema, for a server that reads the same rows again and again. A schema's verdict
 * on a text never changes, so once it has passed a text and given back just what the text says, reading that text again
 * needs only JSON.parse: the result is as fresh and as mutable as ever. A schema that changes what it reads is simply
 * applied each time. Texts are compared whole, against what was last seen under the same key.
 */
export function storedJsonDecoder<T>(schema: { parse(value: unknown): T }): (key: unknown, text: string) => T {
  const passed = new Map<unknown, string>();
  return (key, text) => {
    if (passed.get(key) === text) return JSON.parse(text) as T;
    const value = schema.parse(JSON.parse(text));
    // Compared as text: a row stored in another key order is read in the schema's order, the same every time.
    if (JSON.stringify(value) === JSON.stringify(JSON.parse(text))) passed.set(key, text);
    else passed.delete(key);
    return value;
  };
}
