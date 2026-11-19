import { z } from 'zod';
import { coordinatorIntentSchema, type CoordinatorIntent } from '@alpacawork/contract/coordinator';
import { readerTurn } from '@/features/reader/submission';
import type { SentIntent } from '../reader-send';
import type { Document } from './document';
import { hasReaderOperation } from './document';

const intentSchema = coordinatorIntentSchema.required({ expectedTaskHash: true });
const capturedOperationTurn = z.object({ taskId: z.string(), turn: z.string(), phase: z.string() });
type EditableIntent = { intent: SentIntent; turn: ReturnType<typeof readerTurn> };

/**
 * The draft fields that hold an operation's meaning while it can still be edited. `readerRetry` has no writer now: it
 * stays listed so that what an older version saved leaves with the rest.
 */
export const EDITABLE_INTENT_FIELDS = ['readerRetry', 'readerIntent', 'readerIntentTurn'] as const;
/** The draft without those fields: what a frozen send keeps (Fixed.intent owns the fact from there). */
export function withoutEditableIntent(values: Record<string, string>) {
  const rest = { ...values };
  for (const field of EDITABLE_INTENT_FIELDS) delete rest[field];
  return rest;
}
/** Merged into a draft still being edited, once the words no longer hold an operation. */
export const clearedEditableIntent = () => Object.fromEntries(EDITABLE_INTENT_FIELDS.map(field => [field, ''])) as Record<(typeof EDITABLE_INTENT_FIELDS)[number], string>;

/** One editable operation representation, both before its first freeze and after Fixed.intent returns. */
export function editableIntentValues(intent: CoordinatorIntent, turn: ReturnType<typeof readerTurn>) {
  const { taskId, phase } = turn;
  return { readerIntent: JSON.stringify(intent), readerIntentTurn: JSON.stringify({ taskId, turn: turn.turn, phase }) };
}

/** Operation words never silently become ordinary text when their captured meaning is missing or invalid. */
export function editableIntent(values: Record<string, string>, doc: Document): { kind: 'none' } | { kind: 'invalid' } | ({ kind: 'intent' } & EditableIntent) {
  if (!hasReaderOperation(doc)) return { kind: 'none' };
  try {
    const intent = intentSchema.parse(JSON.parse(values.readerIntent ?? ''));
    const turn = capturedOperationTurn.parse(JSON.parse(values.readerIntentTurn ?? ''));
    return intent.task === turn.taskId ? { kind: 'intent', intent, turn } : { kind: 'invalid' };
  } catch { return { kind: 'invalid' }; }
}
