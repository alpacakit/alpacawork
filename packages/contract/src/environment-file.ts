/**
 * What the server says about its environment file, as it read it when it started. The file holds secrets, and a line
 * put wrongly may hold one anywhere, so nothing read from it is here: no value, no name, no line. Only where the file
 * is, whether it was read, how many variables it set, and the numbers of the lines that set none.
 */
import { z } from 'zod';

export const environmentFileSchema = z.object({
  path: z.string(),
  /** `read`, `absent` (no such file), or why the whole file was left unread. */
  state: z.enum(['read', 'absent', 'not_regular_file', 'owner', 'permissions', 'unreadable']),
  /** How many variables the file set. */
  applied: z.number().int().nonnegative(),
  skipped: z.array(z.object({ line: z.number().int().positive(), reason: z.enum(['malformed', 'reserved', 'duplicate']) }).strict()),
}).strict();
export type EnvironmentFile = z.infer<typeof environmentFileSchema>;
