/**
 * The texts people read from the server: terminal confirmations of setup, uninstall and deploy, and notifications.
 * Node reads this entry, built to `dist` (the JSON imports name their type), so it owns its own i18next instance with
 * the `server` namespace alone and never loads react-i18next or reads a browser global. See packages/i18n/README.md.
 */
import i18next, { type ResourceLanguage } from "i18next";
import { defaultUiLocale, uiLocales, type UiLocale } from "@alpacawork/core/ui-language";
import en from "./locales/en/server.json" with { type: "json" };
import ja from "./locales/ja/server.json" with { type: "json" };
import zhCN from "./locales/zh-CN/server.json" with { type: "json" };
import es from "./locales/es/server.json" with { type: "json" };
import ptBR from "./locales/pt-BR/server.json" with { type: "json" };

export type ServerLocale = UiLocale;
/** Keys are written with their namespace (`t("server:setup.title")`), so extraction finds them. */
export type ServerText = (key: string, values?: { readonly [name: string]: string | number }) => string;

const catalogs = i18next.createInstance();
// `init` resolves synchronously here: the resources are given and there is no backend.
void catalogs.init({
  lng: defaultUiLocale,
  fallbackLng: defaultUiLocale,
  supportedLngs: [...uiLocales],
  returnEmptyString: false,
  resources: {
    en: { server: en },
    ja: { server: ja },
    "zh-CN": { server: zhCN },
    es: { server: es },
    "pt-BR": { server: ptBR },
  } satisfies Record<UiLocale, ResourceLanguage>,
});

/**
 * The texts in one language. A `{{name}}` in a text takes the value given under that name, and a number given as
 * `count` also picks the plural form. Each placeholder is filled once and a value is never read again: i18next's own
 * interpolation fills a later placeholder inside an earlier value that happens to spell it, and these values are
 * paths and titles the person approves as shown.
 */
export function serverText(language: ServerLocale): ServerText {
  const template = catalogs.getFixedT(language);
  return (key, values = {}) =>
    template(key, { count: typeof values.count === "number" ? values.count : undefined, skipInterpolation: true })
      .replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}
