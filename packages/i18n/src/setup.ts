/** The setup screen loads its own texts, so they are not part of the ordinary page's startup. */
import { uiLocales } from "@alpacawork/core/ui-language";
import { i18n } from "./index";

const catalogs = import.meta.glob<Record<string, unknown>>("./locales/*/setup.json", { eager: true, import: "default" });

export function installSetupTexts() {
  for (const locale of uiLocales) {
    const texts = catalogs[`./locales/${locale}/setup.json`];
    if (texts && !i18n.hasResourceBundle(locale, "setup")) i18n.addResourceBundle(locale, "setup", texts);
  }
}
