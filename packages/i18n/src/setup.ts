/** The setup screen loads its own texts, so they are not part of the ordinary page's startup. */
import { i18n } from "./index";
import en from "./locales/en/setup.json";
import ja from "./locales/ja/setup.json";

export function installSetupTexts() {
  for (const [locale, texts] of Object.entries({ en, ja })) {
    if (!i18n.hasResourceBundle(locale, "setup")) i18n.addResourceBundle(locale, "setup", texts);
  }
}
