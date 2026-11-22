import { z } from 'zod';

/** A turn owns snapshots of explicitly linked local files. An absent array means there were no snapshots. */
export const answerFileSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), href: z.string(), name: z.string(), size: z.number() }),
  z.object({ state: z.literal('unavailable'), href: z.string(), reason: z.enum(['missing', 'unsafe', 'too_large', 'invalid', 'limit']) }),
]);
export type AnswerFile = z.infer<typeof answerFileSchema>;
/**
 * A coordinator answer's kept copies as any view of that answer reads them: `requestId` is the Request whose Run
 * kept them (the Run a joined message went into), which their address names.
 */
export const answerFilesSchema = z.object({ requestId: z.string().min(1), files: z.array(answerFileSchema).min(1) }).strict();
export type AnswerFiles = z.infer<typeof answerFilesSchema>;
export const coordinatorFileUrl = (id: string, name: string, area: 'attachments' | 'answers' = 'attachments') =>
  `/api/coordinator/file?requestId=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}${area === 'answers' ? '&area=answers' : ''}`;
