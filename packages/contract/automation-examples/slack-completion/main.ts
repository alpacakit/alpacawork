import type { Config, RunInput, RunResult } from 'alpacawork';

export const config = {
  on: { event: 'task.state_changed', where: { to: 'done' } },
  limits: { perDay: 20 },
  uses: { send: ['slack'] },
} satisfies Config;

const escapeSlack = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Post completed tasks to Slack.
 *
 * Share the task identifier and title with the team.
 *
 * @returns A summary of the delivery.
 */
export async function run({ event, alp }: RunInput<typeof config>): Promise<RunResult> {
  const response = await alp.send({
    to: 'slack',
    body: { text: `Completed ${event.task.id}: ${escapeSlack(event.task.title)}` },
  });
  return { summary: response.status === null ? 'Prepared the Slack message.' : `Slack returned HTTP ${response.status}.` };
}
