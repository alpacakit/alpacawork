/** Shared Task document limits, names, and validators. */
import { createHash } from 'node:crypto';
import { PROBLEM_CODE, Problem, type ProblemReason } from '@alpacawork/core';
import { MAX_TASK_ID_LENGTH, TASK_SEGMENT } from './task-id.js';
import { TASK_STATE, type TaskState } from './task-enums.js';
import { DIGEST_PATTERN } from './values.js';
export { MAX_DOCUMENT } from './values.js';
/** alpacawork's own files live in this task-root directory; it is not a task (dot entries are skipped). */
export const META_DIRECTORY = '.alpacawork';
/** Only this file inside META_DIRECTORY marks an initialized workspace. */
export const WORKSPACE_MARKER = 'workspace';
/** Workspace settings: extracts, agents and limits. */
export const CONFIG_FILE = 'config.yaml';
const states = Object.values(TASK_STATE);
export const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const DIGEST = new RegExp(`^${DIGEST_PATTERN}$`);
/** True when `value` has the form `digest` returns: 64 lowercase hex digits and nothing else. */
export const isDigest = (value: unknown): value is string => typeof value === 'string' && DIGEST.test(value);
export const now = () => new Date().toISOString().replace('Z', '000+00:00');
export function text(value: unknown, name: string, limit = 200): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > limit)
    throw new Problem(PROBLEM_CODE.invalidInput, `${name} must be a nonempty string, at most ${limit} characters`, undefined,
      { reason: { kind: 'must_nonempty_string_at_most_characters', name: String(name), limit: String(limit) } });
  return value;
}
export function taskId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_TASK_ID_LENGTH ||
    !TASK_SEGMENT.test(value)
  )
    throw new Problem(PROBLEM_CODE.invalidInput, 'Task ID must be T1…T999999999 or P1…P999999999', undefined,
      { reason: { kind: 'task_id_must_1_999999999' } });
  return value;
}
export function fields(value: unknown, keys: string[], name: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw new Problem(PROBLEM_CODE.invalidInput, `${name} requires exactly: ${[...keys].sort().join(', ')}`, undefined,
      { reason: { kind: 'requires_exactly', name: String(name), keysSort: String([...keys].sort().join(', ')) } });
  return value as Record<string, unknown>;
}
function oneOf<const Options extends readonly string[]>(value: unknown, options: Options, message: string, reason: ProblemReason): Options[number] {
  for (const option of options) if (value === option) return option;
  throw new Problem(PROBLEM_CODE.invalidInput, message, undefined, { reason });
}
export function taskState(value: unknown): TaskState {
  return oneOf(value, states, 'Unknown task state', { kind: 'unknown_task_state' });
}
