import { z } from 'zod';

export const runUsageNameSchema = z.string().regex(/^[A-Za-z0-9_.:/@+ -]{1,160}$/);
