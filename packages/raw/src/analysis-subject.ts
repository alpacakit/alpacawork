import { z } from 'zod';
import { TASK_SEGMENT } from './task-id.js';
import { ASPECTS, CAUSES } from './reasons.js';

export const analysisFindingRules = ['long-wait', 'repeated-question', 'long-step', 'limit-hit', 'repeated-failure', 'same-result',
  'fan-out', 'queue-wait', 'failed-run', 'rework', 'large-output', 'same-test-same-commit', 'idle'] as const;

const period = z.strictObject({ kind: z.literal('period'), from: z.iso.date(), to: z.iso.date() });

/** The single subject that marks a Task as analysis or improvement work. */
export const analysisSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cause'), key: z.enum([...CAUSES, ...ASPECTS, ...analysisFindingRules]) }),
  z.strictObject({ kind: z.literal('task'), task: z.string().regex(TASK_SEGMENT).startsWith('T') }),
  period,
]).refine(subject => subject.kind !== 'period' || subject.from <= subject.to,
  { path: ['to'], message: 'To must be on or after from' });

export type AnalysisSubject = z.infer<typeof analysisSubjectSchema>;
