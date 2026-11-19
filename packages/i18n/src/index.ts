// The browser entry is raw TypeScript rather than a build: the JSON catalogs
// are imported directly, so only a bundler can read it. Node reads ./server.ts.
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en/translation.json";
import ja from "./locales/ja/translation.json";
import enUi from "./locales/en/ui.json";
import jaUi from "./locales/ja/ui.json";
import enChrome from "./locales/en/chrome.json";
import jaChrome from "./locales/ja/chrome.json";
import enTree from "./locales/en/tree.json";
import jaTree from "./locales/ja/tree.json";
import enReader from "./locales/en/reader.json";
import jaReader from "./locales/ja/reader.json";
import enForms from "./locales/en/forms.json";
import jaForms from "./locales/ja/forms.json";
import enPanels from "./locales/en/panels.json";
import jaPanels from "./locales/ja/panels.json";
import enPeople from "./locales/en/people.json";
import jaPeople from "./locales/ja/people.json";

/** The languages this build ships. `en` is the source language and the fallback. */
const locales = ["en", "ja"] as const;
export type Locale = (typeof locales)[number];
const defaultLocale: Locale = "en";

function isLocale(value: string | null | undefined): value is Locale {
  return locales.some((locale) => locale === value);
}

/** Browser language is only a loading hint; the server owns the saved choice. */
function detectLocale(): Locale {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return defaultLocale;
}

export function activateLocale(locale: Locale): void {
  void i18next.changeLanguage(locale);
}

/** Activate a language before the first render, so no text is ever rendered twice.
 *
 * - fallbackLng: `en`, the source language, so a `ja` entry that is missing
 *   shows English rather than the key.
 * - returnEmptyString: off, so an entry left empty falls back the same way
 *   instead of blanking the screen. `pnpm i18n:check` keeps both from
 *   shipping; this only limits the damage. See packages/i18n/README.md.
 */
export function startI18n(): Locale {
  const locale = detectLocale();
  // `init` resolves synchronously here: no backend and no async detector.
  void i18next.use(initReactI18next).init({
    lng: locale,
    supportedLngs: [...locales],
    fallbackLng: defaultLocale,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    // Shared connection wording and one namespace per part of the screen.
    resources: {
      en: { translation: en, ui: enUi, chrome: enChrome, tree: enTree, reader: enReader, forms: enForms, panels: enPanels, people: enPeople },
      ja: { translation: ja, ui: jaUi, chrome: jaChrome, tree: jaTree, reader: jaReader, forms: jaForms, panels: jaPanels, people: jaPeople },
    },
  });
  return locale;
}

export { i18next as i18n };
