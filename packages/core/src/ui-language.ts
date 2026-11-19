export const uiLocales = ['en', 'ja', 'zh-CN', 'es', 'pt-BR'] as const;
export type UiLocale = typeof uiLocales[number];
export const defaultUiLocale = 'en' satisfies UiLocale;

export function isUiLocale(value: unknown): value is UiLocale {
  return uiLocales.some(locale => locale === value);
}

/** A saved screen setting is a catalog code, not a language preference to negotiate. */
export function uiLocaleOrDefault(value: unknown): UiLocale {
  return isUiLocale(value) ? value : defaultUiLocale;
}

const catalogLocales = uiLocales.map(code => ({ code, tag: new Intl.Locale(code).maximize() }));

/** Match ordered BCP 47 preferences by language and writing system, allowing regional variants. */
export function matchUiLocale(tags: Iterable<string>): UiLocale | undefined {
  const unmatchedLanguages = new Set<string>();
  for (const tag of tags) {
    let locale: Intl.Locale;
    try { locale = new Intl.Locale(tag); }
    catch { continue; }
    if (!locale.language || locale.language === 'und') continue;
    // Browsers can insert a bare language after a regional preference in Accept-Language.
    // It carries that preference's writing system rather than naming a new one.
    if (locale.baseName === locale.language && unmatchedLanguages.has(locale.language)) continue;
    if (isUiLocale(locale.baseName)) return locale.baseName;
    const { language, script } = locale.maximize();
    const match = catalogLocales.find(catalog => catalog.tag.language === language && catalog.tag.script === script);
    if (match) return match.code;
    unmatchedLanguages.add(locale.language);
  }
  return undefined;
}

/** A missing preference or wildcard alone leaves first-use settings unsaved. */
export function uiLocaleFromAcceptLanguage(header: string | undefined): UiLocale | undefined {
  const preferences = (header ?? '').split(',').flatMap(part => {
    const [range = '', weight] = part.split(';');
    const tag = range.trim();
    if (!tag || tag === '*') return [];
    const quality = weight === undefined ? 1
      : Number(weight.trim().match(/^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i)?.[1]);
    return quality > 0 ? [{ tag, quality }] : [];
  }).sort((a, b) => b.quality - a.quality);
  if (preferences.length === 0) return undefined;
  return matchUiLocale(preferences.map(({ tag }) => tag)) ?? defaultUiLocale;
}

/** POSIX locale names may carry a codeset or modifier after their language and region. */
export function uiLocaleFromEnvironment(env: Readonly<Record<string, string | undefined>>): UiLocale {
  const name = (env.LC_ALL || env.LC_MESSAGES || env.LANG || '').trim();
  const [tag = ''] = name.split(/[.@]/, 1);
  return matchUiLocale([tag.replaceAll('_', '-')]) ?? defaultUiLocale;
}
