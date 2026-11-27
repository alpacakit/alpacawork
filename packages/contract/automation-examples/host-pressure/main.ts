import type { Config, RunInput, RunResult } from 'alpacawork';

export const config = {
  on: { event: 'host.pressure', where: { kinds: ['cpu', 'memory', 'disk'] } },
  limits: { perDay: 3, cooldownMinutes: 60, tasksPerRun: 1 },
  uses: { ai: { operator: { agent: 'claude', model: 'sonnet', effort: 'high' } } },
} satisfies Config;

/**
 * Ask an AI to investigate pressure on the host.
 *
 * Report the affected resources and possible remedies.
 *
 * @returns The investigation task identifier.
 */
export async function run({ event, alp }: RunInput<typeof config>): Promise<RunResult> {
  const task = await alp.tasks.create({
    ai: 'operator',
    title: 'Investigate host resource pressure',
    instruction: 'Identify what is using the affected resources and report possible remedies.',
    data: { kinds: event.kinds, episodeStartedAt: event.episodeStartedAt },
  });
  return { summary: `Requested a host investigation in ${task.id}.` };
}
