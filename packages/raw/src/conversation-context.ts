/** Version witnesses supplied to an owner, and the owner's atomic handoff report. Historical Runs have no witness. */
import { z } from 'zod';
import { TASK_SEGMENT } from './task-id.js';
const run = z.string().regex(/^R[1-9][0-9]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const childVersionsSchema = z.record(z.string().regex(TASK_SEGMENT), hash);
export const conversationContextSchema = z.object({
  children: z.record(z.string().regex(TASK_SEGMENT), hash.nullable()),
  /** The acknowledged snapshot used to compare this input; children records only what this input supplied. */
  snapshotFrom: z.string().min(1).optional(),
  /** The report whose prepared handoff this Request reserves; not proof of a provider's receipt. */
  rotationFrom: z.string().min(1).optional(),
  /** This input contained this complete rendered owner explanation; receipt and child acceptance are separate facts. */
  suppliedSnapshot: hash.optional(),
}).strict();
export const conversationCheckpointSchema = z.object({
  bodyHash: hash,
  inputHead: run,
  children: childVersionsSchema,
  /** How the next conversation starts: new, or the same one compacted first (with what its summary keeps in focus). */
  nextConversation: z.enum(['new', 'compact']).optional(),
  compactFocus: z.string().min(1).optional(),
}).strict().refine(value => value.compactFocus === undefined || value.nextConversation === 'compact',
  'Only a compacted next conversation keeps a focus');
export type ChildVersions = z.infer<typeof childVersionsSchema>;
export type ConversationCheckpoint = z.infer<typeof conversationCheckpointSchema>;

export type ChildObservations = z.infer<typeof conversationContextSchema>['children'];
