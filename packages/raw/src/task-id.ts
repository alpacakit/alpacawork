/** Browser-safe authority for public Task identity. UUIDs and the workspace's shared number remain canonical. */
import type { TaskKind } from './task-enums.js';
const TASK_PREFIX = { task: 'T', project: 'P' } as const satisfies Record<TaskKind, string>;
export const MAX_TASK_NUMBER = 999_999_999;
export const MAX_TASK_ID_LENGTH = 10;
const PREFIX = `[${Object.values(TASK_PREFIX).join('')}]`;
/** One public ID, with no leading zero or trailing character. Placement P+UUID IDs are a different grammar. */
export const TASK_ID_PATTERN = `${PREFIX}[1-9][0-9]{0,8}`;
export const TASK_SEGMENT = new RegExp(`^${TASK_ID_PATTERN}(?![\\s\\S])`);
export function parseTaskId(value: string): { kind: TaskKind; number: number } | null {
  if (!TASK_SEGMENT.test(value)) return null;
  return { kind: value[0] === TASK_PREFIX.project ? 'project' : 'task', number: Number(value.slice(1)) };
}
export function publicTaskId(kind: TaskKind, number: number): string {
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_TASK_NUMBER) throw new Error('Invalid Task number');
  return `${TASK_PREFIX[kind]}${number}`;
}
/** The generated column is the persisted projection of this same prefix mapping, never a second allocation. */
export const PUBLIC_TASK_ID_SQL = `(CASE kind ${Object.entries(TASK_PREFIX).map(([kind, prefix]) =>
  `WHEN '${kind}' THEN '${prefix}'`).join(' ')} END || number)`;
