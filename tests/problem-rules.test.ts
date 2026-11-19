import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROBLEM_RULE, type ProblemCode } from '@alpacawork/core/codes';
import { Problem, errorBody, failure, faultReason, parseInput } from '@alpacawork/core';
import { failureExitCode } from '@alpacawork/cli-kit';
import { problemSchema } from '@alpacawork/contract/problem';
import { z } from 'zod';

// The expected public contract is intentionally independent of the implementation table.
const expected = {
  '400/fix/2': 'invalid_input invalid_option unknown_command invalid_settings invalid_yaml invalid_document invalid_path unsafe_path unsafe_endpoint too_deep too_many_children id_exhausted sandboxed_caller attachment_request_replaced urgent_to_user voice_empty',
  '403/fix/2': 'forbidden',
  '404/fix/2': 'not_found missing_document',
  '413/fix/2': 'too_large voice_too_large',
  '409/reread/2': 'conflict idempotency_conflict invalid_root already_initialized question_closed question_expired question_stopped',
  '409/fix/2': 'not_resumable finished_branch handover_required automatic_limit restore_changed',
  '409/later/2': 'busy handoff_pending conversation_busy responsible_missing parent_unavailable',
  '503/later/2': 'runs_unavailable database_unavailable unstable unsupported_platform',
  '503/check/3': 'save_unconfirmed read_failed io_failure unavailable voice_recognition_failed publication_pending publication_needs_review',
} as const;

function assertPublicRules() {
  const seen = new Set<string>();
  for (const [rule, codes] of Object.entries(expected)) {
    const [status, retry, exitCode] = rule.split('/');
    for (const code of codes.split(' ') as ProblemCode[]) {
      assert.ok(!seen.has(code), `duplicate expected code: ${code}`);
      seen.add(code);
      const problem = new Problem(code, 'Refused');
      assert.equal(problem.status, Number(status), code);
      assert.equal(problem.retry, retry, code);
      assert.equal(failureExitCode(problem.retry), Number(exitCode), code);
      assert.deepEqual(problemSchema.parse(errorBody(problem)).error,
        { code, message: 'Refused', retry }, code);
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(PROBLEM_RULE).sort());
}

test('every problem code has one public HTTP status, retry instruction, and CLI exit code', () => {
  assertPublicRules();
  // Prove the independent expectations detect a changed row, then restore the table.
  const mutable = PROBLEM_RULE as Record<string, { status: number; retry: string }>;
  const original = mutable.invalid_input!;
  try {
    mutable.invalid_input = { ...original, status: 418 };
    assert.throws(assertPublicRules, /invalid_input/);
  } finally {
    mutable.invalid_input = original;
  }
});

test('entry input Zod failure becomes invalid_input with a field path', () => {
  assert.throws(() => parseInput(z.object({ title: z.string() }), { title: 2 }), (error: unknown) => {
    const problem = failure(error);
    assert.equal(problem.code, 'invalid_input');
    assert.equal(problem.status, 400);
    assert.deepEqual(problem.issues?.map(issue => issue.path), ['title']);
    return true;
  });
  let outputError: unknown;
  try { z.object({ enabled: z.boolean() }).parse({ enabled: 'yes' }); }
  catch (error) { outputError = error; }
  const output = failure(outputError);
  assert.equal(output.code, 'unavailable');
  assert.equal(output.status, 503);
  assert.equal(output.retry, 'check');
});

test('a machine reason survives the public envelope without changing its code or retry policy', () => {
  const cause = Object.assign(new Error('SQLite diagnostic'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  const body = problemSchema.parse(errorBody(cause));
  assert.deepEqual(body.error, { code: 'busy', retry: 'later', message: 'Database is busy; retry later',
    reason: { kind: 'database_busy' } });
  const voice = new Problem('unavailable', 'Missing configured key', undefined,
    { reason: { kind: 'voice_key_missing', env: 'VOICE_KEY' } });
  assert.deepEqual(problemSchema.parse(errorBody(voice)).error.reason, { kind: 'voice_key_missing', env: 'VOICE_KEY' });
  assert.equal(problemSchema.safeParse({ error: { ...body.error, reason: { kind: 'voice_key_missing' } } }).success, false);
  assert.equal(problemSchema.safeParse({ error: { ...body.error, reason: { kind: 'voice_token_request_failed',
    provider: 'soniox', status: '503' } } }).success, false);
});

test('explicit application failures keep their meaning even when their cause is technical', () => {
  const cause = Object.assign(new Error('SQLite diagnostic'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  assert.equal(errorBody(new Problem('question_closed', 'Question already closed', undefined, { cause })).error.reason, undefined);
  const migration = new Problem('unavailable', 'Database requires explicit migration; existing database is preserved', undefined,
    { reason: { kind: 'database_migration_required' } });
  const reason = { kind: 'run_store_unavailable' as const, cause: faultReason(migration) };
  assert.deepEqual(problemSchema.parse(errorBody(new Problem('unavailable', 'Runs unavailable', undefined, { reason }))).error.reason,
    { kind: 'run_store_unavailable', cause: { kind: 'database_migration_required' } });
});
