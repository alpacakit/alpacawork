/**
 * Browser-safe: one zod schema per value rule, built from the raw facts.
 * Entry inputs and screen forms compose these; no other schema repeats a pattern or limit.
 */
import { z } from 'zod';
import { eastAsianWidthType } from 'get-east-asian-width';
import { TASK_KIND, TASK_STATE, TASK_BASE_STATES } from '@alpacawork/raw/task-enums';
import { MAX_TASK_ID_LENGTH, TASK_SEGMENT, parseTaskId } from '@alpacawork/raw/task-id';
import { MAX_QUOTE_LENGTH, taskLogSchema } from '@alpacawork/raw/task-log-schema';
import {
  BODY_MARK_PATTERN, DIGEST_PATTERN, ESTIMATE_MINUTES, MAX_CONTROL_BODY, MAX_DETAIL_LENGTH, MAX_INSTRUCTION_BYTES, MAX_TITLE_LENGTH,
  RUN_ID_PATTERN,
} from '@alpacawork/raw/values';
export { MAX_DETAIL_LENGTH } from '@alpacawork/raw/values';

const characters = (value: string) => [...value].length;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const filled = (value: string) => value.trim() !== '';
const bounded = (limit: number, measure: (value: string) => number, unit: string, required: boolean) =>
  z.string().superRefine((value, context) => {
    if (required && !filled(value))
      context.addIssue({ code: 'custom', message: 'Must not be blank', params: { kind: 'blank' } });
    if (measure(value) > limit)
      context.addIssue({ code: 'custom', message: `Must be at most ${limit} ${unit}`,
        params: { kind: 'too_big', maximum: limit } });
  });

export const taskIdSchema = z.string().max(MAX_TASK_ID_LENGTH).regex(TASK_SEGMENT);
/** Project-only boundaries reject ordinary Task IDs before any lookup. */
export const projectIdSchema = taskIdSchema.refine(id => parseTaskId(id)?.kind === 'project');
export const runIdSchema = z.string().regex(new RegExp(`^${RUN_ID_PATTERN}$`));
export type RunId = z.infer<typeof runIdSchema>;
export const digestSchema = z.string().regex(new RegExp(`^${DIGEST_PATTERN}$`));
export const bodyMarkSchema = z.string().regex(new RegExp(`^${BODY_MARK_PATTERN}$`));
export const taskStateSchema = z.enum(TASK_STATE);
export const taskBaseStateSchema = z.enum(TASK_BASE_STATES);
/** Every state can be restored from a hold; authorization distinguishes restoration from a Run's reports. */
export const reportStateSchema = taskStateSchema;
export const taskKindSchema = z.enum(TASK_KIND);
/** A Task log entry's ID, as the log itself checks it: what an answer names its question by. */
export const logIdSchema = taskLogSchema.shape.id;
export const estimateMinutesSchema = z.number().int().min(ESTIMATE_MINUTES.min).max(ESTIMATE_MINUTES.max);
/** Task titles count code points. Report titles use the width a reader sees. */
export const titleSchema = bounded(MAX_TITLE_LENGTH, characters, 'characters', true);
export const REPORT_TITLE_GUIDE_WIDTH = 40;
export const REPORT_TITLE_MAX_WIDTH = REPORT_TITLE_GUIDE_WIDTH * 2;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function reportTitleWidth(value: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(value)) {
    width += [...segment].some(character => ['wide', 'fullwidth'].includes(
      eastAsianWidthType(character.codePointAt(0)!))) ? 2 : 1;
  }
  return width;
}
/** One line no wider than twice the guide width: a report's title, or an urgent report's reason. */
const oneLine = (name: string) => z.string().superRefine((value, context) => {
  if (!filled(value)) context.addIssue({ code: 'custom', message: `${name} must not be blank`, params: { kind: 'blank' } });
  if (/[\r\n\u2028\u2029]/u.test(value))
    context.addIssue({ code: 'custom', message: `${name} must be one line`, params: { kind: 'newline' } });
  if (reportTitleWidth(value) > REPORT_TITLE_MAX_WIDTH)
    context.addIssue({ code: 'custom', message: `${name} must be at most display width ${REPORT_TITLE_MAX_WIDTH}`,
      params: { kind: 'too_big', maximum: REPORT_TITLE_MAX_WIDTH } });
});
export const reportTitleSchema = oneLine('Title');
/** Why an urgent comment or report wakes its requester now: one line, as a report title is. */
export const urgentReasonSchema = oneLine('Urgent reason');
export const descriptionSchema = bounded(MAX_DETAIL_LENGTH, characters, 'characters', true);
/** Bodies and instructions count UTF-8 bytes, as they are stored and delivered. A body may be empty. */
export const bodySchema = bounded(MAX_CONTROL_BODY, bytes, 'UTF-8 bytes', false);
export const instructionSchema = bounded(MAX_INSTRUCTION_BYTES, bytes, 'UTF-8 bytes', true);
/** A person's words recorded by the coordinator, counted as Task titles are. */
export const quoteTextSchema = bounded(MAX_QUOTE_LENGTH, characters, 'characters', true);
