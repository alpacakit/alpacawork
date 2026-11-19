/** Jev's destination is a complete System One POST URL, not an SDK base URL. */
import { z } from 'zod';

export const DEFAULT_JEV_SETTINGS = Object.freeze({ endpoint: '', model: 'jev-latest', api_key_env: 'TYPESAFE_API_KEY' });
export const jevSettingsSchema = z.object({
  endpoint: z.string().trim().refine(value => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return !url.username && !url.password && !url.hash && (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)));
    } catch { return false; }
  }, 'Use a complete HTTPS endpoint URL, or loopback HTTP, without credentials or a fragment').default(''),
  model: z.string().trim().min(1).default(DEFAULT_JEV_SETTINGS.model),
  api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default(DEFAULT_JEV_SETTINGS.api_key_env),
}).strict();
export type JevSettings = z.infer<typeof jevSettingsSchema>;

/** A loaded screen draft has every field; only stored YAML may omit fields to use defaults. */
export const jevFormSettingsSchema = jevSettingsSchema.extend({
  endpoint: jevSettingsSchema.shape.endpoint.unwrap(),
  model: jevSettingsSchema.shape.model.unwrap(),
  api_key_env: jevSettingsSchema.shape.api_key_env.unwrap(),
});
