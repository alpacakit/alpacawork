import { z } from 'zod';
import { enabledAgents, selectionSchema } from './agent-settings.js';

export const aiRowSchema = z.object({
  agent: z.string().regex(/^[a-z][a-z0-9_-]*$(?![\s\S])/),
  values: selectionSchema,
}).strict();
export type AiRow = z.infer<typeof aiRowSchema>;
export const aiStackSchema = z.array(aiRowSchema);

/** Use the task stack's first agent, or the first enabled profile when the task stack has no rows. */
export function coordinatorDefaultAgent<T extends { enabled?: boolean }>(agents: Readonly<Record<string, T>>,
  aiStack: readonly Pick<AiRow, 'agent'>[] | undefined): [string, T] | undefined {
  const agent = aiStack?.[0]?.agent;
  if (agent === undefined) return enabledAgents(agents)[0];
  const setting = Object.hasOwn(agents, agent) ? agents[agent] : undefined;
  return setting && setting.enabled !== false ? [agent, setting] : undefined;
}

const explicitAiRowSchema = aiRowSchema.partial({ values: true });
export const aiStackPrefixSchema = z.array(z.union([explicitAiRowSchema, z.literal('stop')])).min(1)
  .refine(items => items.indexOf('stop') === -1 || items.indexOf('stop') === items.length - 1,
    'Stop must be the last item');
export type AiStackPrefix = z.infer<typeof aiStackPrefixSchema>;
