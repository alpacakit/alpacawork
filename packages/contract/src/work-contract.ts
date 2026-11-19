/** A closed, safe display vocabulary. Command arguments and shell text never cross this boundary. */
import { z } from 'zod';

export const workCommandSchema = z.enum(['task.new', 'task.update', 'task.move', 'task.request', 'task.report',
  'task.comment', 'task.get', 'task.list', 'task.returns', 'agent.assign', 'agent.handover', 'agent.release',
  'run.get', 'run.stop', 'field.get']);
export type WorkCommand = z.infer<typeof workCommandSchema>;
export const runWorkSchema = z.object({ at: z.iso.datetime({ offset: true }), toolName: z.string().max(128).nullable(),
  command: workCommandSchema.nullable() }).strict();
/** Names describe recent work, without claiming that its tool is still running. */
export const workNameSchema = z.enum([...workCommandSchema.options, 'command', 'file', 'search', 'edit', 'web', 'tool']);
export type WorkName = z.infer<typeof workNameSchema>;
export const workLabelSchema = z.object({ name: workNameSchema, count: z.number().int().positive() }).strict();
export type WorkLabel = z.infer<typeof workLabelSchema>;
export const coordinatorWorkSchema = workLabelSchema.extend({ conversation: z.string(), turn: z.string() }).nullable();
