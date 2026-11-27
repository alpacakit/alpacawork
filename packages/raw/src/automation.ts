import { z } from 'zod';

export const automationIdSchema = z.string().regex(/^A[1-9][0-9]{0,8}(?![\s\S])/);
export const automationNameSchema = z.string().min(1).max(200).regex(/\S/);

const reference = {
  automationId: automationIdSchema,
  revision: z.number().int().positive(),
  runNumber: z.number().int().positive(),
};
export const automationActorSchema = z.strictObject({ kind: z.literal('automation'), ...reference });
export const automationOriginSchema = z.strictObject({ ...reference, digest: z.string().regex(/^[0-9a-f]{64}$/).optional(), name: automationNameSchema, trial: z.literal(true).optional() });
export type AutomationOrigin = z.infer<typeof automationOriginSchema>;
