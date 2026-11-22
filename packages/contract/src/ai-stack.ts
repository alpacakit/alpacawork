import { z } from 'zod';
import { selectionSchema } from './agent-settings.js';

export const aiRowSchema = z.object({
  agent: z.string().regex(/^[a-z][a-z0-9_-]*$(?![\s\S])/),
  values: selectionSchema,
}).strict();
export type AiRow = z.infer<typeof aiRowSchema>;
export const aiStackSchema = z.array(aiRowSchema);
