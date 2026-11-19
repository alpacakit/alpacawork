import { taskLogSchema } from '@alpacawork/contract/control';

/**
 * Read a task's complete stored log, newest first, through `task get` (999999999 is the most entries it takes).
 * History pages carry events, one per record, not the log entries.
 */
export async function readTaskLog(origin: string, task: string) {
  const response = await fetch(`${origin}/api/task/get?task=${encodeURIComponent(task)}&log=999999999`);
  if (!response.ok) throw new Error(`task/get ${task}: ${response.status} ${await response.text()}`);
  return taskLogSchema.array().parse((await response.json() as { task: { log: unknown } }).task.log).reverse();
}
