/** Writer v2: one fixed overwrite request, no copies or disposal lifecycle. */
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { MANAGED_SKILL_NAMES, completeSkillsReceiptSchema } from '@alpacawork/core/installed-skills';
export const equal = isDeepStrictEqual;
export const pathSchema = z.string().refine(p => isAbsolute(p) && normalize(p) === p && !p.includes('\0'));
export const namesSchema = z.array(z.enum(MANAGED_SKILL_NAMES)).max(MANAGED_SKILL_NAMES.length)
  .refine(names => equal(names, [...new Set(names)].sort()));
export const intentSchema = z.object({ place: namesSchema, remove: namesSchema }).strict()
  .refine(i => i.place.length + i.remove.length > 0 && !i.place.some(n => i.remove.includes(n)));
export type SkillIntent = z.infer<typeof intentSchema>;
export const requestSchema = z.object({ version: z.literal(2), operationId: z.uuid(), release: pathSchema, intent: intentSchema }).strict();
export type SkillWriteRequest = z.infer<typeof requestSchema>;
export const skillWriteResultSchema = z.object({ kind: z.literal('committed'), operationId: z.uuid(), receipt: completeSkillsReceiptSchema })
  .strict().refine(r => r.operationId === r.receipt.operationId);
export type SkillWriteResult = z.infer<typeof skillWriteResultSchema>;
