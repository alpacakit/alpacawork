import { z } from 'zod';
import { selectionSchema } from './agent-settings.js';

export const aiRowSchema = z.object({
  agent: z.string().regex(/^[a-z][a-z0-9_-]*$(?![\s\S])/),
  values: selectionSchema,
}).strict();
export type AiRow = z.infer<typeof aiRowSchema>;
export const aiStackSchema = z.array(aiRowSchema);

const explicitAiRowSchema = aiRowSchema.partial({ values: true });
export const aiStackPrefixSchema = z.array(z.union([explicitAiRowSchema, z.literal('stop')])).min(1)
  .refine(items => items.indexOf('stop') === -1 || items.indexOf('stop') === items.length - 1,
    'Stop must be the last item');
export type AiStackPrefix = z.infer<typeof aiStackPrefixSchema>;
