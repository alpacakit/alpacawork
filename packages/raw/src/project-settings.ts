/** Project settings shared by storage, API and browser contracts. */
import { z } from 'zod';

const COLOR_FORM = 'color must be six lowercase hex digits: #rrggbb (^#[0-9a-f]{6}$)';
export const projectColorSchema = z.string({ error: COLOR_FORM }).regex(/^#[0-9a-f]{6}$/, COLOR_FORM);
/** A project's own settings: its color. Its fields are its schema (task_values store), not settings. */
export const projectSettingsSchema = z.object({ color: projectColorSchema }).strict();
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
