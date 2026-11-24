import { z } from 'zod';

/** The selection's purpose and weight, as named by the project's policy. */
const label = z.string().trim().min(1).max(160);
export const ownerChoiceContextSchema = z.strictObject({ purpose: label, weight: label });
