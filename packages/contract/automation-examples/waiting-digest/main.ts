import type { Config, RunInput, RunResult } from 'alpacawork';

export const config = {
  on: { event: 'schedule', where: { cron: '0 9 * * *' } },
  limits: { perDay: 1 },
} satisfies Config;

/**
 * Summarize the tasks waiting for review.
 *
 * Publish the latest waiting tasks in the run report.
 *
 * @returns A report with task titles and identifiers.
 */
export async function run({ alp }: RunInput<typeof config>): Promise<RunResult> {
  const { tasks } = await alp.tasks.list({ state: 'waiting', limit: 20 });
  if (!tasks.length) return { summary: 'No tasks are waiting for review.' };
  const report = tasks.map(task => `- ${task.id} ${task.title}`).join('\n');
  return { summary: `Found ${tasks.length} recent tasks waiting for review.`, report, notify: true };
}
