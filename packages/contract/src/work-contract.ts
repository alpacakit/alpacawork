/** Rounded work labels and bounded previews of observed tool calls. */
import { z } from 'zod';
import { runIdSchema } from './fields.js';

export const RUN_TOOL_NAME_LIMIT = 128;
export const RUN_TOOL_ID_LIMIT = 128;
export const RUN_NOTE_LIMIT = 500;
export const workCommandSchema = z.enum(['task.new', 'task.update', 'task.move', 'task.request', 'task.report',
  'task.comment', 'task.get', 'task.list', 'task.returns', 'agent.assign', 'agent.handover', 'agent.release',
  'run.get', 'run.stop', 'field.get']);
export type WorkCommand = z.infer<typeof workCommandSchema>;
export const runWorkSchema = z.object({ at: z.iso.datetime({ offset: true }), toolName: z.string().max(RUN_TOOL_NAME_LIMIT).nullable(),
  command: workCommandSchema.nullable() }).strict();
export const runStepKindSchema = z.enum(['command', 'file', 'search', 'edit', 'web', 'tool']);
export type RunStepKind = z.infer<typeof runStepKindSchema>;
/** Names describe recent work, without claiming that its tool is still running. */
export const workNameSchema = z.enum([...workCommandSchema.options, ...runStepKindSchema.options]);
export type WorkName = z.infer<typeof workNameSchema>;
export const workLabelSchema = z.object({ name: workNameSchema, count: z.number().int().positive() }).strict();
export type WorkLabel = z.infer<typeof workLabelSchema>;
/** How many of the latest steps a Run keeps for display, and how much of each. */
export const RUN_STEP_LIMIT = 6;
export const RUN_STEP_TEXT_LIMIT = 240;
export const runStepLineSchema = z.object({ text: z.string().max(RUN_STEP_TEXT_LIMIT), more: z.number().int().nonnegative() }).strict();
export type RunStepLine = z.infer<typeof runStepLineSchema>;
/**
 * One thing an agent did, as its own tool call says it: the first line of what it ran, read or searched (`more`
 * counts the lines after it), the plain words the agent gave for it, and the first line of what came back.
 */
export const runStepSchema = z.object({
  id: z.string().max(RUN_TOOL_ID_LIMIT), at: z.iso.datetime({ offset: true }), tool: z.string().max(RUN_TOOL_NAME_LIMIT),
  kind: runStepKindSchema,
  ...runStepLineSchema.shape,
  about: z.string().max(RUN_STEP_TEXT_LIMIT).nullable(),
  state: z.enum(['running', 'done', 'failed']),
  result: runStepLineSchema.nullable(),
}).strict();
export type RunStep = z.infer<typeof runStepSchema>;
export const runStepsSchema = z.array(runStepSchema).max(RUN_STEP_LIMIT);
/**
 * Every step of one Run, read from its output only when someone opens them: how many of the latest it gives, and how
 * much of what each ran and got back.
 */
export const RUN_STEPS_READ_LIMIT = 200;
export const RUN_STEP_FULL_TEXT_LIMIT = 16 * 1024;
/** What a step ran or got back, as written up to the limit; `cut` when there was more. */
export const runStepTextSchema = z.object({ text: z.string().max(RUN_STEP_FULL_TEXT_LIMIT), cut: z.boolean() }).strict();
export type RunStepText = z.infer<typeof runStepTextSchema>;
export const runFullStepSchema = z.object({
  id: z.string().max(RUN_TOOL_ID_LIMIT), tool: z.string().max(RUN_TOOL_NAME_LIMIT), kind: runStepKindSchema,
  about: z.string().max(RUN_STEP_TEXT_LIMIT).nullable(), state: runStepSchema.shape.state,
  input: runStepTextSchema, output: runStepTextSchema.nullable(),
}).strict();
export type RunFullStep = z.infer<typeof runFullStepSchema>;
/**
 * GET /api/runs/:run/steps, oldest first. `older`: the steps read before these, left out. `unread`: the output before
 * what was read was too long to read, so there may be steps before those counted.
 */
export const runStepsReadSchema = z.object({ steps: z.array(runFullStepSchema).max(RUN_STEPS_READ_LIMIT),
  older: z.number().int().nonnegative(), unread: z.boolean() }).strict();
export type RunStepsRead = z.infer<typeof runStepsReadSchema>;
/** The running turn's recent work: its rounded name (null once it has gone quiet), and its latest words and steps as they are. */
export const coordinatorWorkSchema = z.object({ name: workNameSchema.nullable(), count: z.number().int().nonnegative(),
  conversation: z.string(), turn: z.string(), run: runIdSchema, steps: runStepsSchema, words: z.string().max(RUN_NOTE_LIMIT).nullable() }).strict().nullable();
