import { z } from 'zod';
import { projectIdSchema } from './fields.js';

/** The setup screen's steps, in the order they are taken. */
export const setupSteps = ['agents', 'skills', 'project'] as const;
export const setupStepSchema = z.enum(setupSteps);
export type SetupStep = z.infer<typeof setupStepSchema>;

/**
 * A new workspace's setup: the project it sets up last, the step it was left on, and when it was finished. A workspace
 * without this file (made before it existed) has nothing to set up.
 */
export const firstRunSchema = z.object({
  version: z.literal(1), project: projectIdSchema, step: setupStepSchema, finishedAt: z.iso.datetime().nullable(),
}).strict();
export type FirstRun = z.infer<typeof firstRunSchema>;

export const firstRunChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('step'), step: setupStepSchema }).strict(),
  z.object({ kind: z.literal('finish') }).strict(),
]);
export type FirstRunChange = z.infer<typeof firstRunChangeSchema>;
export const firstRunRequestSchema = z.object({ change: firstRunChangeSchema }).strict();
export const firstRunResponseSchema = z.object({ state: firstRunSchema.nullable() }).strict();
export type FirstRunResponse = z.infer<typeof firstRunResponseSchema>;

/** Written once, by the initialization of a new workspace. */
export const initialFirstRun = (project: string): FirstRun =>
  firstRunSchema.parse({ version: 1, project, step: 'agents', finishedAt: null });

/** Setup stays finished; until then the step is where the person last was. */
export function applyFirstRun(state: FirstRun, change: FirstRunChange, now: string): FirstRun {
  if (state.finishedAt) return state;
  return change.kind === 'finish' ? { ...state, finishedAt: now } : { ...state, step: change.step };
}
