import { defineConfig } from "i18next-cli";
import { defaultUiLocale, uiLocales } from "../core/src/ui-language.ts";

// Keys are names (`screen.role`, e.g. `diagnostics.description`) and `en` is the
// language people write first. A key with no text in
// the running language falls back to `en`. See packages/i18n/README.md.
export default defineConfig({
  locales: [...uiLocales],
  plugins: [{
    name: "people-translator-arguments",
    // These pure helpers receive useTranslation("people").t from their callers.
    // Qualify that argument only for extraction; no runtime source is changed.
    onLoad(code, path) {
      if (/\/domain\/(day-clock|finish-words)\.ts$/.test(path))
        return code.replace(/\bt\((["`])(?=(?:clock|day|finish)\.)/g, "t($1people:");
    },
  }],
  extract: {
    // The screen, and the server's texts for people (namespace `server`, read through `@alpacawork/i18n/server`).
    input: ["apps/web/src/**/*.{ts,tsx}", "apps/backend/src/**/*.ts"],
    output: "packages/i18n/src/locales/{{language}}/{{namespace}}.json",
    primaryLanguage: defaultUiLocale,
    // A new key is written empty in every language; `pnpm i18n:check` fails
    // until every catalog has been filled.
    defaultValue: "",
    // Registries, structured History words and computed keys are read at runtime.
    preservePatterns: [
      "ui:input.skillReasons.*", // Catalog reason codes are selected by the server.
      "ui:state.*", // State names are chosen from current task state at runtime.
      "ui:turn.reason.*", // A turn's reason is selected from the server's reason code.
      "ui:defaultField.*", // A shipped field's title and hint, chosen by its field ID (domain/field-display.ts).
      "tree:status.turn.*", // Its short word on a row, by the same code.
      "tree:status.cause.*", // A stopped row's word for a recognized failure cause (contract runErrorCauseSchema).
      "tree:status.tokens.*", // A token counter's name, by the counter's key (contract TOKEN_COUNTER_KEYS).
      "chrome:limits.window.*", // A limit window's name, by its kind (contract LIMIT_KINDS).
      "panels:settings.personal.*",
      "panels:telemetry.blocked.*", // Eligibility reasons come from telemetryGate.
      "setup:skills.items.*", // An offered skill's name and description, looked up by its ID (contract SKILL_OFFERS).
      "setup:skills.reason.*", // Why a skill was not installed, by the server's reason code.
      "panels:settings.show.*", "panels:settings.showShort.*",
      "panels:settings.server.limit.*", "panels:settings.server.agentIssue.*",
      "reader:history.waiting.*", "reader:history.reasons.*", "reader:files.facet.*",
      "reader:reportFeed.row.*", // A History row says its party, kind and ending by the record's own values.
      "translation:problem.*", "translation:validation.*",
    ],
    sort: true,
    indentation: 2,
  },
});
