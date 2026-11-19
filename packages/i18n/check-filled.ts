// Fails when any catalog entry is empty. The extractor writes every new key as
// "" in every language, so this is how `pnpm i18n:check` finds text that no
// person has written yet in `en` or translated into `ja`. See packages/i18n/README.md.
import { readFileSync, readdirSync } from "node:fs";
import config from "./i18next.config.ts";

type Catalog = { [key: string]: string | Catalog };

function emptyKeys(catalog: Catalog, prefix = ""): string[] {
  return Object.entries(catalog).flatMap(([key, value]) =>
    typeof value === "string"
      ? value === ""
        ? [prefix + key]
        : []
      : emptyKeys(value, `${prefix}${key}.`),
  );
}

let failed = false;
for (const locale of config.locales) {
  const directory = new URL(`./src/locales/${locale}/`, import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith(".json"))) {
    const empty = emptyKeys(JSON.parse(readFileSync(new URL(file, directory), "utf8")) as Catalog);
    for (const key of empty) console.error(`${locale}/${file}: empty ${key}`);
    failed ||= empty.length > 0;
  }
}
if (failed) process.exit(1);
