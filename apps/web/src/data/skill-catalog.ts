import { z } from 'zod';

/** A chosen skill is its name: what a message carries, and what the agent's CLI resolves when the turn runs. */
export const skillAttrs = z.object({ name: z.string(), invocation: z.enum(['/', '$']) });
export type Skill = z.infer<typeof skillAttrs> & { description: string };
export const skillCatalogSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), profile: z.string(), skills: z.array(skillAttrs.extend({ description: z.string() })) }),
  z.object({ status: z.literal('unavailable'), profile: z.string(), skills: z.array(z.never()), reason: z.string() }),
]);
export type SkillCatalog = { status: 'loading' | 'unavailable' | 'ready'; profile: string; skills: Skill[]; reason?: string };
