import { z } from 'zod';
import { TASK_STATE } from '@alpacawork/raw/task-enums';
import { defaultUiLocale, uiLocales } from '@alpacawork/core/ui-language';
import { bodyMarkSchema, taskIdSchema } from './fields.js';

/** Stored person values include choices and server-owned notification state. */
type SettingBase = {
  key: string;
  group: 'display' | 'notifications' | 'ai';
  owner: 'person' | 'server';
  labelKey: string;
  helpKey?: string;
  hidden?: boolean;
  /** Drawn only once its value differs from the default (and kept for that opening): a way back, not a choice offered up front. */
  shownWhenChanged?: boolean;
};
export type SettingDefinition = SettingBase & (
  | { kind: 'toggle' | 'checkbox'; defaultValue: boolean }
  | { kind: 'select'; defaultValue: string; options: readonly { value: string; labelKey?: string }[] }
  | { kind: 'timeZone'; defaultValue: string }
  | { kind: 'instant'; defaultValue: null }
  /** A BCP 47 language tag in its canonical form (`Intl.getCanonicalLocales`), or null while none is chosen. */
  | { kind: 'languageTag'; defaultValue: null }
);
export const quietTimes = Array.from({ length: 48 }, (_, index) =>
  `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`);
const quietOptions = quietTimes.map(value => ({ value }));
/** When the morning starts: where quiet hours end unless a person chose otherwise, and when "until morning" ends. */
export const MORNING_TIME = '08:00';
export const uiLanguageOptions = uiLocales.map(value => ({ value, labelKey: `settings.personal.option.${value}` }));
export const personalSettings = [
  { key: 'language', group: 'display', owner: 'person', kind: 'select', defaultValue: defaultUiLocale,
    labelKey: 'settings.personal.language', options: uiLanguageOptions },
  /**
   * The language the AI talks with the user in, apart from the screen's `language`. The coordinator decides it from the
   * user's own words and saves it with `alpacawork settings set`; the screen does not offer it.
   */
  { key: 'ai.language', group: 'ai', owner: 'person', kind: 'languageTag', defaultValue: null,
    labelKey: 'settings.personal.aiLanguage', hidden: true },
  { key: 'theme', group: 'display', owner: 'person', kind: 'select', defaultValue: 'system', labelKey: 'settings.personal.theme', helpKey: 'settings.personal.themeHelp', options: [
    { value: 'system', labelKey: 'settings.personal.option.system' }, { value: 'light', labelKey: 'settings.personal.option.light' }, { value: 'dark', labelKey: 'settings.personal.option.dark' },
  ] },
  { key: 'update.confirm', group: 'display', owner: 'person', kind: 'checkbox', defaultValue: true,
    labelKey: 'settings.personal.updateConfirm', shownWhenChanged: true },
  { key: 'push.review', group: 'notifications', owner: 'person', kind: 'checkbox', defaultValue: true,
    labelKey: 'settings.personal.pushReview' },
  { key: 'push.question', group: 'notifications', owner: 'person', kind: 'checkbox', defaultValue: true,
    labelKey: 'settings.personal.pushQuestion' },
  { key: 'push.followup', group: 'notifications', owner: 'person', kind: 'checkbox', defaultValue: true,
    labelKey: 'settings.personal.pushFollowup' },
  { key: 'push.done', group: 'notifications', owner: 'person', kind: 'checkbox', defaultValue: false,
    labelKey: 'settings.personal.pushDone' },
  { key: 'push.stopped', group: 'notifications', owner: 'person', kind: 'checkbox', defaultValue: true,
    labelKey: 'settings.personal.pushStopped' },
  { key: 'push.host', group: 'notifications', owner: 'person', kind: 'checkbox', defaultValue: true,
    labelKey: 'settings.personal.pushHost' },
  { key: 'push.awayAfter', group: 'notifications', owner: 'person', kind: 'select', defaultValue: '5',
    labelKey: 'settings.personal.awayAfter', helpKey: 'settings.personal.awayAfterHelp', options: [2, 5, 10, 15].map(value =>
      ({ value: String(value), labelKey: `settings.personal.option.away${value}` })) },
  { key: 'push.quiet', group: 'notifications', owner: 'person', kind: 'toggle', defaultValue: false,
    labelKey: 'settings.personal.quiet', helpKey: 'settings.personal.quietHelp' },
  { key: 'push.quietFrom', group: 'notifications', owner: 'person', kind: 'select', defaultValue: '22:00',
    labelKey: 'settings.personal.quietFrom', options: quietOptions, hidden: true },
  { key: 'push.quietTo', group: 'notifications', owner: 'person', kind: 'select', defaultValue: MORNING_TIME,
    labelKey: 'settings.personal.quietTo', options: quietOptions, hidden: true },
  { key: 'push.timeZone', group: 'notifications', owner: 'person', kind: 'timeZone', defaultValue: 'UTC',
    labelKey: 'settings.personal.timeZone', hidden: true },
  { key: 'push.mutedUntil', group: 'notifications', owner: 'server', kind: 'instant', defaultValue: null,
    labelKey: 'settings.personal.mutedUntil', hidden: true },
  { key: 'push.quietResumedUntil', group: 'notifications', owner: 'server', kind: 'instant', defaultValue: null,
    labelKey: 'settings.personal.quietResumedUntil', hidden: true },
] as const satisfies readonly SettingDefinition[];

export type SettingValues = Record<string, string | boolean | null>;
export function defaultSettings(definitions: readonly SettingDefinition[] = personalSettings): SettingValues {
  return Object.fromEntries(definitions.map((definition) => [definition.key, definition.defaultValue]));
}
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}
/** Longest language tag kept; BCP 47 recommends that tags of at most 35 characters be supported. */
export const MAX_LANGUAGE_TAG = 35;
/**
 * The canonical form of one BCP 47 language tag (`ja-jp` is `ja-JP`); null for none, `und`, or a tag whose language
 * has no English name, which the start texts could not name.
 */
export function canonicalLanguageTag(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LANGUAGE_TAG) return null;
  try {
    const tags = Intl.getCanonicalLocales(value);
    const tag = tags.length === 1 && tags[0]!.length <= MAX_LANGUAGE_TAG ? tags[0]! : null;
    if (!tag || new Intl.Locale(tag).language === 'und') return null;
    return new Intl.DisplayNames('en', { type: 'language', fallback: 'none' }).of(tag) ? tag : null;
  } catch { return null; }
}
/**
 * A value as a setting's kind reads it, before validation: a boolean setting also reads `true`/`false`, a setting that
 * can be unset reads `null`, and a language tag is put in its canonical form. The command line writes every value as
 * text, so this is how it says a boolean or none; the screen sends JSON and is read the same way.
 */
export function readSettingValue(definitions: readonly SettingDefinition[], key: string, value: unknown): unknown {
  const definition = definitions.find(item => item.key === key);
  if (!definition || typeof value !== 'string') return value;
  if ((definition.kind === 'toggle' || definition.kind === 'checkbox') && (value === 'true' || value === 'false'))
    return value === 'true';
  if (definition.defaultValue === null && value === 'null') return null;
  if (definition.kind === 'languageTag') return canonicalLanguageTag(value) ?? value;
  return value;
}
export function validSetting(definitions: readonly SettingDefinition[], key: string, value: unknown): value is string | boolean | null {
  const definition = definitions.find((item) => item.key === key);
  if (!definition) return false;
  if (definition.kind === 'timeZone') return validTimeZone(value);
  if (definition.kind === 'instant') return value === null || typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
  if (definition.kind === 'languageTag') return value === null || typeof value === 'string' && canonicalLanguageTag(value) === value;
  if (definition.kind === 'select') return typeof value === 'string' && definition.options.some((option) => option.value === value);
  return typeof value === 'boolean';
}
/** The settings API accepts choices only; server-owned values retain their stored validation separately. */
export function validSettingWrite(definitions: readonly SettingDefinition[], key: string, value: unknown): value is string | boolean | null {
  return definitions.some(definition => definition.key === key && definition.owner === 'person') &&
    validSetting(definitions, key, value);
}
export const pauseChoices = ['hour', 'two-hours', 'morning'] as const;
export type PauseChoice = typeof pauseChoices[number];
/**
 * The choices a settings file holds, without the defaults of those it does not: a setting not chosen yet stays out
 * (the screen's `language` until a browser names its language). A language tag is read in its canonical form, and one
 * that no longer reads as a tag is left out, so that one value cannot make every setting unreadable.
 */
export function readStoredSettings(definitions: readonly SettingDefinition[], input: unknown): SettingValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid personal settings');
  // Stored preferences outlive definitions. Read only current choices; the next atomic save removes retired keys.
  // Known choices still fail validation, and API writes validate their keys separately with validSettingWrite.
  const values: SettingValues = {};
  for (const [key, raw] of Object.entries(input)) {
    const definition = definitions.find(item => item.key === key);
    if (!definition) continue;
    const value = definition.kind === 'languageTag' && raw !== null ? canonicalLanguageTag(raw) : raw;
    if (definition.kind === 'languageTag' && value === null) continue;
    if (!validSetting(definitions, key, value)) throw new Error('Invalid personal settings');
    values[key] = value as string | boolean | null;
  }
  return values;
}
export const personalSettingsResponseSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])), revision: z.string().min(1),
});
const noticeBaselineSchema = z.object({
  log: z.number().int().nonnegative(), state: z.enum(TASK_STATE), body: bodyMarkSchema,
  turnKey: z.string().nullable().optional(),
});
/** The reader's read marks, keyed by Task ID (version 4). */
export const noticeStateSchema = z.object({
  version: z.literal(4),
  checkpoint: z.object({ at: z.iso.datetime({ offset: true }), tasks: z.record(taskIdSchema, noticeBaselineSchema) }),
  reads: z.record(taskIdSchema, noticeBaselineSchema),
});
export const noticeStateResponseSchema = z.object({ state: noticeStateSchema.nullable(), revision: z.string().nullable(),
  initialBaselines: z.record(taskIdSchema, noticeBaselineSchema).optional() });
