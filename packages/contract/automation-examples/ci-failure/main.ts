import type { Config, Json, RunInput, RunResult, TriggerInput, TriggerResult } from 'alpacawork';

export const config = {
  on: { event: 'signal' },
  limits: { perDay: 10, tasksPerRun: 1 },
  uses: { ai: { investigator: { agent: 'claude', model: 'sonnet', effort: 'high' } } },
} satisfies Config;

function failure(data: Json): data is { [name: string]: Json; result: 'failed' } {
  return data !== null && typeof data === 'object' && 'result' in data && data.result === 'failed';
}

/**
 * Select signals that report a CI failure.
 *
 * Send an object with a `result` field set to `failed` for a failure.
 *
 * @returns Whether the batch contains a failure.
 */
export function trigger({ event }: TriggerInput<typeof config>): TriggerResult {
  const failed = event.items.some(({ data }) => failure(data));
  return { run: failed, reason: failed ? 'CI reported a failure.' : 'No CI failure in the batch.' };
}

/**
 * Ask an AI to investigate the CI failure.
 *
 * The failing signal's identifier and workflow name are attached as reference material.
 *
 * @returns The investigation task identifier.
 */
export async function run({ event, alp }: RunInput<typeof config>): Promise<RunResult> {
  const item = event.items.find(({ data }) => failure(data));
  if (!item || !failure(item.data)) return { summary: 'No CI failure to investigate.' };
  const workflow = typeof item.data.workflow === 'string' ? item.data.workflow.slice(0, 200) : null;
  const task = await alp.tasks.create({
    ai: 'investigator',
    title: 'Investigate a CI failure',
    instruction: 'Check the CI job at its source and report the failure cause and a suggested fix.',
    data: { at: item.at, key: item.key, workflow },
  });
  return { summary: `Requested a CI investigation in ${task.id}.` };
}
