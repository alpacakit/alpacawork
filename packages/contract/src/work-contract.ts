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
 * How much of what one step ran or got back is shown when it is opened: past this, its end is left out and the count
 * of the characters left out is said. A bridge writes no more than this into its output either.
 */
export const RUN_STEP_FULL_TEXT_LIMIT = 256 * 1024;
/** What a step ran or got back, as written: `omitted` counts the characters left out after `text`, `omittedFiles` the files. */
export const runStepTextSchema = z.object({ text: z.string().max(RUN_STEP_FULL_TEXT_LIMIT), omitted: z.number().int().nonnegative(),
  /** Files of a change list left out after those `text` says (a list too long to carry whole). */
  omittedFiles: z.number().int().positive().optional() }).strict();
export type RunStepText = z.infer<typeof runStepTextSchema>;
/**
 * Where a step's time came from: `row`, the agent's own output line said it; `read`, the Run's manager read the line
 * at that time (within its poll interval of when it was written).
 */
export const stepTimeSourceSchema = z.enum(['row', 'read']);
export type StepTimeSource = z.infer<typeof stepTimeSourceSchema>;
/** A step's input with paths, digests, IDs and numbers replaced, and a digest of the whole input when it has more lines. */
export const stepFingerprintSchema = z.object({ line: z.string().max(RUN_STEP_TEXT_LIMIT), body: z.string().regex(/^[0-9a-f]{16}$/).nullable() }).strict();
export type StepFingerprint = z.infer<typeof stepFingerprintSchema>;
export const stepOutputSchema = z.object({ chars: z.number().int().nonnegative(), digest: z.string().regex(/^[0-9a-f]{16}$/) }).strict();
export type StepOutput = z.infer<typeof stepOutputSchema>;
/**
 * One line of a Run's step journal (RUN_FILES.steps), appended by the Run's manager as a step starts or ends and never
 * rewritten. `line` is the number (from 0) of the output line that started the step: with `id` it names the step, so
 * the manager reading the output again appends nothing it already holds.
 */
export const stepJournalEntrySchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('start'), line: z.number().int().nonnegative(), id: z.string().min(1).max(RUN_TOOL_ID_LIMIT),
    at: z.iso.datetime({ offset: true }), source: stepTimeSourceSchema, fingerprint: stepFingerprintSchema.nullable(),
    parent: z.string().min(1).max(RUN_TOOL_ID_LIMIT).nullable() }).strict(),
  z.object({ event: z.literal('end'), line: z.number().int().nonnegative(), id: z.string().min(1).max(RUN_TOOL_ID_LIMIT),
    at: z.iso.datetime({ offset: true }), source: stepTimeSourceSchema,
    state: z.enum(['done', 'failed', 'unknown']), output: stepOutputSchema.nullable() }).strict(),
]);
export type StepJournalEntry = z.infer<typeof stepJournalEntrySchema>;
/** The most of a step journal read back: about 200 bytes a line, so some 80,000 step events. */
export const STEP_JOURNAL_LIMIT = 16 * 1024 * 1024;
/** How many steps one read of a Run's steps gives at most. */
export const RUN_STEPS_PAGE_LIMIT = 200;
/**
 * One step in a Run's list of steps: its place in the Run (`n`, from 0), what it ran on one line, and how it went.
 * `unknown`: a line of the Run's output that could not be read came while it ran and nothing said later how it ended,
 * so whether it went well is not known.
 */
export const runStepEntrySchema = z.object({
  n: z.number().int().nonnegative(), id: z.string().max(RUN_TOOL_ID_LIMIT), tool: z.string().max(RUN_TOOL_NAME_LIMIT),
  kind: runStepKindSchema, ...runStepLineSchema.shape, about: z.string().max(RUN_STEP_TEXT_LIMIT).nullable(),
  state: z.enum(['running', 'done', 'failed', 'unknown']),
  /** The index's version when this step last changed: of two answers about it, the higher is the newer. */
  changed: z.number().int().nonnegative(),
  /**
   * When it started and ended, as its Run's step journal kept them while it ran (null where the journal holds none: a
   * Run from before the journal, or an end not yet seen), and where each time came from.
   */
  startedAt: z.iso.datetime({ offset: true }).nullable(), startSource: stepTimeSourceSchema.nullable(),
  endedAt: z.iso.datetime({ offset: true }).nullable(), endSource: stepTimeSourceSchema.nullable(),
  /** What it ran with the parts that change from run to run replaced (stepFingerprint), so repeats read as one. */
  fingerprint: stepFingerprintSchema.nullable(),
  /** What came back: its size in characters and a digest of it, so a read that got the same answer again shows. */
  output: stepOutputSchema.nullable(),
  /** The step of the agent's own sub-agent that ran it (its tool call ID); null for the agent's own steps. */
  parent: z.string().max(RUN_TOOL_ID_LIMIT).nullable(),
  /** For a step that ran a sub-agent: how many steps the sub-agent took. */
  subagentSteps: z.number().int().nonnegative(),
}).strict();
export type RunStepEntry = z.infer<typeof runStepEntrySchema>;
/**
 * GET /api/runs/:run/steps: `?from=&limit=` gives the Run's steps from `from` on (the latest `limit` without `from`),
 * oldest first; `?since=` gives the steps that changed after version `since` (new ones too), oldest change first.
 * `version` is how far this answer has caught up: asked again `since` it, a list misses no change. `total`: the steps
 * so far. `complete`: `version` is the latest (a long run of changes comes a page at a time). `generation` names the
 * reading of the output its steps come from; a new one (the output was replaced, or the index was read anew) never
 * repeats an earlier, and a list of another generation is no longer the Run's.
 */
export const runStepsPageSchema = z.object({ steps: z.array(runStepEntrySchema).max(RUN_STEPS_PAGE_LIMIT),
  total: z.number().int().nonnegative(), version: z.number().int().nonnegative(), complete: z.boolean(),
  generation: z.number().int().nonnegative() }).strict();
export type RunStepsPage = z.infer<typeof runStepsPageSchema>;
/** GET /api/runs/:run/steps/:n: what that step ran and what came back (null before it has ended or when nothing did). */
export const runStepDetailSchema = z.object({ input: runStepTextSchema, output: runStepTextSchema.nullable(),
  changed: runStepEntrySchema.shape.changed, generation: runStepsPageSchema.shape.generation,
  /** Its record was too large to keep its details: what it ran and got back could not be kept. */
  detailsDropped: z.literal(true).optional() }).strict();
export type RunStepDetail = z.infer<typeof runStepDetailSchema>;
/** The running turn's recent work: its rounded name (null once it has gone quiet), and its latest words and steps as they are. */
export const coordinatorWorkSchema = z.object({ name: workNameSchema.nullable(), count: z.number().int().nonnegative(),
  conversation: z.string(), turn: z.string(), run: runIdSchema, steps: runStepsSchema, stepEvents: z.number().int().nonnegative(),
  stepsStarted: z.number().int().nonnegative(),
  words: z.string().max(RUN_NOTE_LIMIT).nullable() }).strict().nullable();
