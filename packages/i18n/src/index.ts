/// <reference types="vite/client" />
// The browser entry reads the catalogs through Vite. Node reads ./server.ts.
import i18next, { type ResourceLanguage } from "i18next";
import { initReactI18next } from "react-i18next";
import { defaultUiLocale, isUiLocale, matchUiLocale, uiLocales, type UiLocale } from "@alpacawork/core/ui-language";

const catalogs = import.meta.glob<ResourceLanguage[string]>(
  ["./locales/*/*.json", "!**/server.json", "!**/setup.json"],
  { eager: true, import: "default" },
);
const resources: Record<string, ResourceLanguage> = {};
for (const [path, catalog] of Object.entries(catalogs)) {
  const [, , locale, file] = path.split("/");
  if (isUiLocale(locale) && file) (resources[locale] ??= {})[file.slice(0, -".json".length)] = catalog;
}

export function activateLocale(locale: UiLocale): void {
  void i18next.changeLanguage(locale);
}

/** Activate the browser's loading hint before the first render. The server owns the saved choice. */
export function startI18n(): UiLocale {
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  const locale = matchUiLocale(tags) ?? defaultUiLocale;
  // With the resources already loaded and no backend, init is synchronous.
  void i18next.use(initReactI18next).init({
    lng: locale,
    supportedLngs: [...uiLocales],
    fallbackLng: defaultUiLocale,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    resources,
  });
  return locale;
}

export { i18next as i18n };
