# Internationalization (i18n)

This package holds translations for the web interface, terminal confirmations and notifications.
English (`en`) is the source language and fallback. The build currently ships English and Japanese
(`ja`); keep every supported locale complete as more languages are added.

## Catalogs and keys

Catalogs live in `src/locales/<locale>/<namespace>.json`, relative to this package.

| Namespace | Used for |
| --- | --- |
| `chrome`, `tree`, `reader`, `forms`, `panels`, `people` | The corresponding feature in `apps/web/src/features/` |
| `setup` | The setup screen a new workspace opens on, loaded only there (`@alpacawork/i18n/setup`) |
| `ui` | Short text with the same meaning across features, such as state names |
| `translation` | Shared text in `apps/web/src/data/` and `apps/web/src/components/ui/`; the default namespace |
| `server` | Terminal confirmations and results for setup, uninstall and deploy, and notifications |

Use semantic keys such as `panels:diagnostics.description`, rather than the original sentence.
Within a namespace, use `<component>.<role>`:

- Start the component's filename in lower camel case: `SourceTab.tsx` becomes `sourceTab`.
  Drop a dialog's trailing `Dialog`: `DiagnosticsDialog.tsx` becomes `diagnostics`.
- Name the role in English lower camel case, such as `title`, `description`, `empty` or `emptyHint`.
  Choose a name that survives changes to the wording.
- Group related values one level deeper, such as `runs.activity.toolStart` or `runs.state.running`.
- Use `.` within keys; `:` separates the namespace from the key.
- Give different screens their own keys, even when their current wording matches. Share a `ui` key
  only when the meaning and reasons to change it are also shared.

Prefer string literals in `t()` calls so extraction can find them. Map API values to literal keys:

```tsx
const labels: Record<RunActivity["kind"], string> = {
  tool_start: t("runs.activity.toolStart"),
  tool_end: t("runs.activity.toolEnd"),
  // ...
};
```

Computed keys and registries need matching `extract.preservePatterns` in
[`i18next.config.ts`](i18next.config.ts). Review those patterns when adding or retiring a key family;
otherwise extraction can remove keys still used at runtime or keep keys that are no longer used.
The extractor scans `apps/web/src` and `apps/backend/src`. It also qualifies the translation helper
arguments in `domain/day-clock.ts` and `domain/finish-words.ts` through its configured plugin.

## Adding, changing and removing text

Add, change or remove the corresponding logical key in **every supported locale in the same change**.
When the meaning changes, update every translation, not only the English source. A wording change
alone does not require renaming the key. Keep interpolation names consistent across translations;
plural suffixes must follow each language's plural rules.

Run these commands from the repository root:

```sh
pnpm i18n:extract
# Fill new entries and update the affected translations in every supported locale.
git add packages/i18n/src/locales
pnpm i18n:check
```

Extraction adds new keys with empty strings and removes unused keys unless a preserve pattern keeps
them. For a removal or rename, update the call sites and any applicable preserve patterns, then
review the resulting catalogs in every locale.

`i18n:check` extracts again, compares the catalog working tree with the Git index, then checks for
empty strings in every catalog of every locale listed in `i18next.config.ts`. Stage the intended
catalog edits first so the diff detects unexpected extraction changes. An empty entry fails even
though runtime fallback can display English. This check does not judge translation quality or
placeholder correctness; review those in the changed text.

`test:quick` does not run `i18n:check`. Run the catalog check explicitly for translation changes and
choose the related Node, web or browser tests for the behavior affected; see [Checks](#checks).

## Using translations

### Web components and other browser code

The browser entry, `@alpacawork/i18n`, exports `startI18n`, `activateLocale`, `i18n` and the `Locale`
type. It loads the web catalogs directly as TypeScript/JSON through the bundler; it is not the Node
entry. `apps/web/src/main.tsx` calls `startI18n()` before the first render and updates the document's
`lang` when the language changes.

A component chooses its feature namespace:

```tsx
const { t } = useTranslation("panels");
return <p>{t("diagnostics.description")}</p>;
```

Outside React, evaluate `i18n.t("namespace:key")` when the function is called. Do not translate at
module initialization: that freezes text before the language is chosen and prevents later changes
from taking effect.

`startI18n()` uses the first supported base language in `navigator.languages` as a loading hint,
falling back to English. The server owns the saved screen-language setting, `language`: its first
settings read can initialize it from `Accept-Language`, and the web settings store applies saved
changes through `activateLocale`. Missing or empty translations fall back to English.

For dates and numbers, pass the active language to the formatter, such as
`date.toLocaleString(i18n.language)` or `new Intl.NumberFormat(i18n.language)`. Do not hardcode a
particular display locale.

Use the interpolation name `count` only when it should select a plural form. Supply the forms
required by each language, such as `_one` and `_other` for English. For a number that should not
select a plural form, use a descriptive name such as `shownCount`.

### Server and terminal text

Node callers import `serverText` from `@alpacawork/i18n/server`, whose independent i18next instance
loads only the `server` namespace. The caller supplies a `ServerLocale` and uses qualified literal
keys:

```ts
import { serverText } from "@alpacawork/i18n/server";

const t = serverText(language);
const line = t("server:setup.title");
```

Installation commands select the language from the first nonempty value of `LC_ALL`, `LC_MESSAGES`
and `LANG`. The current selector recognizes Japanese and otherwise uses English. Notifications use
the saved screen language, independently of the AI reply language.

`serverText` replaces each `{{name}}` once with a supplied string or number. Replacement values are
not interpreted again, so paths or titles containing `{{...}}` stay as written. A numeric `count`
also selects the plural form. Do not use i18next formatting such as `{{value, number}}` or `$t(...)`
nesting with this wrapper. Keep a terminal row, including its alignment spaces, in one catalog entry.

Node reads the built `dist/server.js` and copied catalogs. After changing server catalogs, run
`pnpm build:packages` before server tests; browser imports read the source catalogs directly.

### AI reply language

The screen's `language` and the hidden personal setting `ai.language` are separate.
`ai.language` accepts a validated, canonical BCP 47 tag, such as `fr-CA`, or `null`; it is not limited
to the UI catalog locales and has no screen selector. The coordinator's reply-language rules live in
[`skills/alpacawork/references/coordinator.md`](../../skills/alpacawork/references/coordinator.md),
under "Language for the user". It reads settings before its first reply, chooses and saves the language from the
user's own words when none is saved, and uses the saved language afterward. Without a saved reply
language or the user's own words, it uses the screen language. If settings cannot be read, it uses
the user's own words or English and does not save a choice.

When `ai.language` is saved, every launch of an owner's or a member's Run, and every message to the coordinator on
the screen, carries one sentence built by `languageLine` in `apps/backend/src/receiver/person-state.ts`: write
replies, progress updates and what goes into alpacawork (titles, values, requests, reports, questions, records) in the
saved language. It is kept plain so that the user, the project policy or another instruction the agent follows can
name a language for a particular output (a PR in English, a translation); which instruction wins a conflict is set
once, under "Policy" in the alpacawork skill. A coordinator in an outside conversation gets the same rule from the
skill. Adding a UI locale must not restrict or overwrite `ai.language`.

## What to translate

Translate interface labels, instructions, validation guidance, empty states, failure explanations,
and text surrounding a displayed error. Translate server text intended for people in terminal
confirmations, results and notifications.

Keep these as written:

- Error details passed to `throw`, `Error`, `ApiError` or `Problem`, and fallback error messages:
  write them directly in English. A displayed `error.message` remains the error's content.
- CLI `-h` help and server logs: write them directly in English.
- User and record data: task titles and bodies, IDs, paths, provider names, configuration-defined
  labels, conversation IDs, working directories, saved Run prompts and AI results.
- Field definitions used by agents. Shipped `DEFAULT_FIELDS` remain in English; the web interface
  displays their titles, hints and size guidance through `ui:defaultField.*` in
  `apps/web/src/domain/field-display.ts`. The English catalog must match the shipped definitions.
  Workspace-defined fields display their own text.
- API values such as activity kinds, states, reasons and roles. Translate their display labels,
  while preserving the values sent over the API.

The send-back prefix (`reader:intent.sendback`) is translated when the action creates its message.
Once saved in a Run prompt, it is record data and is not translated again.

## Adding a language

Creating a catalog directory alone does not enable a language. The current build has explicit
English/Japanese registrations in the following places; extend them together when adding a locale.

| Area | Required updates |
| --- | --- |
| Catalogs and extraction | Add `src/locales/<locale>/` with every namespace, translate its entries, and add the locale to `locales` in `i18next.config.ts`. Include the locale's plural forms. |
| Browser registration | Import its web catalogs and register them in `locales` and `resources` in `src/index.ts`. Review `detectLocale()`, which currently reduces browser tags to their base language. |
| Node registration | Extend `ServerLocale`, import its `server.json` and register its resources in `src/server.ts`. |
| Screen selection and validation | Add the `language` option in `packages/contract/src/personal-settings.ts` and its `panels:settings.personal.option.<locale>` label in every locale. The settings screen renders these definitions; validation uses the same options. Extend `applyLanguage` in `apps/web/src/data/personal-settings.ts`. |
| First-use detection | Extend `languageFrom` in `apps/backend/src/receiver/person-state.ts`, including its accepted tags and return type. Keep browser detection and the server's `Accept-Language` handling consistent. |
| Terminal and notifications | Extend `installationLanguage` in `apps/backend/src/installation/confirmation.ts` and the language selection in `apps/backend/src/receiver/push.ts` and `receiver/server.ts`. Update the boolean Japanese/English argument of `serviceStartupAdvice` in `apps/backend/src/installation/public-setup.ts`. |
| AI and CLI guidance | Keep the coordinator skill's reply-language rules aligned with the separate `language` and `ai.language` settings, retaining supported BCP 47 reply tags beyond the UI locales. Update the screen-language list in the settings help in `packages/contract/src/cli-commands.ts`. |
| Linked documentation | Add `docs/<locale>/telemetry.md`, as required by the locale-specific telemetry policy link in `packages/contract/src/telemetry.ts`. English uses `docs/telemetry.md`. Translations of the other guides under `docs/` go in the same folder. |
| Checks | Run extraction and the filled-catalog check. Extend language-specific assertions in settings, field-display, reply-language, terminal and notification tests, and verify the new language through the screen's settings and first-use flow. |

The filled-catalog checker already iterates the configured locale list. Other tests explicitly name
English and Japanese, so passing them unchanged does not establish that a new locale works.
These registrations and restrictions describe the current implementation,
not a limit on the number of languages the application should support.

## Checks

- `pnpm i18n:check` checks extraction drift and empty catalog entries. `tests/i18n-filled.test.ts`
  exercises the real checker, including an empty nested entry in each configured catalog.
- `tests/hardcoded-japanese.test.ts` scans string literals, templates, regular expressions and JSX
  in web, contract, backend and CLI source. Exceptions belong in its exact-literal `ALLOWED` list
  with a reason. It does not detect untranslated text in every language.
- Web tests (`apps/web/tests`, Vitest) must call `startI18n()` before rendering translated components.
  The jsdom browser language is English; use `await i18n.changeLanguage(locale)` to test another
  catalog, then restore the language. `field-display.test.tsx` checks the English shipped field
  definitions and their translated display; `personal-settings.test.tsx` checks setting labels and
  applying the saved language.
- `tests/reply-language.test.ts` checks AI reply-tag validation and screen-language validation.
  Installation and push tests cover their own terminal and notification behavior.
- Browser tests default to `en-US` in `e2e/fixtures.ts`. Set `test.use({ locale: "ja-JP" })`, or the
  corresponding tag for a new supported locale, when testing that browser-language flow.

Use focused existing tests and the quick runner's selection options for affected behavior; the
repository-wide `test:all` also runs `i18n:check`, but is not required for every catalog edit.
