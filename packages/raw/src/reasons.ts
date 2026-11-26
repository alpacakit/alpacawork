import { z } from 'zod';

export const TAKEN = ['adopted', 'fix', 'redo', 'addition', 'new_request', 'dropped'] as const;
export const CAUSES = ['unclear_request', 'misread', 'shortfall', 'premise_changed', 'external', 'other'] as const;
export const ASPECTS = ['look_feel', 'behavior', 'wording', 'speed', 'scope', 'presentation'] as const;
export const PLACED_AS = ['policy', 'lighter', 'exception'] as const;
export const TRIGGERS = ['instruction', 'found', 'misjudged', 'refine'] as const;
export const REASON_MEANINGS = {
  taken: {
    adopted: 'Used the result as delivered.',
    fix: 'Kept the result and corrected part of it.',
    redo: 'Replaced the result by doing the work again.',
    addition: 'Used the result and asked for more within the same goal.',
    new_request: 'Used the result and asked for a separate goal.',
    dropped: 'Set the result aside without using it.',
  } satisfies Record<typeof TAKEN[number], string>,
  cause: {
    unclear_request: 'The request did not make the intended result clear.',
    misread: 'The request was clear but read differently.',
    shortfall: 'The request was understood but the result fell short.',
    premise_changed: 'A requirement or assumption changed after the request.',
    external: 'An outside system or event affected the result.',
    other: 'None of these applies. Give one line with --cause-note.',
  } satisfies Record<typeof CAUSES[number], string>,
  aspects: {
    look_feel: 'Appearance or ease of use.',
    behavior: 'What the result does.',
    wording: 'The words used.',
    speed: 'How long the work or operation takes.',
    scope: 'What is included.',
    presentation: 'How the result is organized or presented for review.',
  } satisfies Record<typeof ASPECTS[number], string>,
  placedAs: {
    policy: 'The choice follows the applicable placement policy.',
    lighter: 'A lighter model or lower effort is being tried.',
    exception: 'This choice departs from policy. Give one line with --placed-note.',
  } satisfies Record<typeof PLACED_AS[number], string>,
  trigger: {
    instruction: 'A user or requester directed the change.',
    found: 'Investigation found something that changed the direction.',
    misjudged: 'A failure or an estimate miss led to the change.',
    refine: 'The wording was clarified and the direction stayed the same.',
  } satisfies Record<typeof TRIGGERS[number], string>,
} as const;

export const needsCause = (taken: string | undefined) => taken === 'fix' || taken === 'redo' || taken === 'dropped';

export const reasonNoteSchema = z.string().trim().min(1).max(200).regex(/^[^\r\n\u0085\u2028\u2029]+$/u);
export const aspectsSchema = z.array(z.enum(ASPECTS)).max(ASPECTS.length)
  .refine(aspects => new Set(aspects).size === aspects.length, 'Name each aspect once');
const id = z.string().min(1).max(128);
export const takenReasonSchema = z.strictObject({ code: z.enum(TAKEN), cause: z.enum(CAUSES).nullable(), aspects: aspectsSchema,
  note: reasonNoteSchema.optional(), of: id.nullable() })
  .refine(taken => needsCause(taken.code) === (taken.cause !== null), 'Only fix, redo and dropped take a cause')
  .refine(taken => needsCause(taken.code) || !taken.aspects.length, 'Only fix, redo and dropped take aspects')
  .refine(taken => (taken.cause === 'other') === (taken.note !== undefined), 'Only cause other needs a note');
export const placedReasonSchema = z.strictObject({ code: z.enum(PLACED_AS), note: reasonNoteSchema.optional() })
  .refine(placed => (placed.code === 'exception') === (placed.note !== undefined), 'Only a placement exception needs a note');
export const triggerReasonSchema = z.strictObject({ code: z.enum(TRIGGERS), fields: z.array(z.string()).min(1), note: reasonNoteSchema.optional() });

const decisionReasonFields = { taken: takenReasonSchema.optional(), placed: placedReasonSchema.optional() };
export const requestActionReasonSchema = z.strictObject(decisionReasonFields)
  .refine(reason => reason.taken !== undefined || reason.placed !== undefined, 'A request reason needs taken or placed');
export type RequestActionReason = z.infer<typeof requestActionReasonSchema>;

export const actionReasonSchema = z.strictObject({
  ...decisionReasonFields, trigger: triggerReasonSchema.optional(),
}).refine(reason => reason.taken !== undefined || reason.placed !== undefined || reason.trigger !== undefined, 'A reason needs taken, placed or trigger');

export type ActionReason = z.infer<typeof actionReasonSchema>;
export type TakenReason = z.infer<typeof takenReasonSchema>;
export type PlacedReason = z.infer<typeof placedReasonSchema>;
export type TriggerReason = z.infer<typeof triggerReasonSchema>;
