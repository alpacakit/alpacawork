import type { Config, RunInput, RunResult } from 'alpacawork';

export const config = {
  on: { event: 'task.message', where: { by: 'human', type: 'send_back' } },
  limits: { perDay: 20, tasksPerRun: 1 },
} satisfies Config;

const notebook = 'Skill review notes';

/**
 * Add a review note to the shared notebook task.
 *
 * Record the feedback and the skills used on the task.
 *
 * @returns The notebook task identifier.
 */
export async function run({ event, alp }: RunInput<typeof config>): Promise<RunResult> {
  const source = await alp.tasks.get({ task: event.task.id });
  const found = await alp.tasks.list({ createdByThis: true, title: notebook });
  const target = found.tasks[0] ?? await alp.tasks.create({ title: notebook, request: false });
  const skills = source.skills?.names.join(', ').slice(0, 400) || 'Unavailable';
  await alp.tasks.comment({
    task: target.id,
    title: `Review note for ${source.id}`,
    description: [event.description.slice(0, 3000), `Skills: ${skills}`].join('\n\n'),
  });
  return { summary: `Added a review note to ${target.id}.` };
}
