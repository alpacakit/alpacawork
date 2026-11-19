/** Recovery wire capability, shared by the actual maintenance entry, HTTP gate and CLI write pin. */
import { z } from 'zod';
export const RECOVERY_PROTOCOL=2;
export const RESTORE_HEADER='X-Alpacawork-Restore-Id';
export const INITIAL_RESTORE_ID='initial';
export const restoreIdSchema=z.union([z.literal(INITIAL_RESTORE_ID),z.string().uuid()]);
export const recoveryIdentitySchema=z.object({protocol:z.literal(RECOVERY_PROTOCOL),restoreId:restoreIdSchema});
/** Frozen failure-side receipts are diagnostic evidence, never a current successful write. */
export const recoveryOperationReceiptSchema=z.object({opId:z.string(),state:z.string(),status:z.number().optional(),body:z.unknown().optional(),tasks:z.array(z.string())});
export const beforeRestoreOperationSchema=z.object({state:z.literal('before_restore'),restoreId:restoreIdSchema,
  previous:recoveryOperationReceiptSchema,notFoundProvesUnexecuted:z.literal(false)}).strict();
export const unknownAfterRestoreOperationSchema=z.object({state:z.literal('unknown_after_restore'),restoreId:restoreIdSchema,
  notFoundProvesUnexecuted:z.literal(false)}).strict();
