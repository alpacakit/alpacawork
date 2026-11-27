import { defineConfig } from "i18next-cli";
import { defaultUiLocale, uiLocales } from "../core/src/ui-language.ts";

// Keys are names (`screen.role`, e.g. `diagnostics.description`) and `en` is the
// language people write first. A key with no text in
// the running language falls back to `en`. See packages/i18n/README.md.
export default defineConfig({
  locales: [...uiLocales],
  plugins: [{
    name: "people-translator-arguments",
    // These pure helpers receive useTranslation("people").t (or "automations") from their callers.
    // Qualify that argument only for extraction; no runtime source is changed.
    onLoad(code, path) {
      if (/\/domain\/(day-clock|finish-words)\.ts$/.test(path))
        return code.replace(/\bt\((["`])(?=(?:clock|day|finish)\.)/g, "t($1people:");
      // The token speed's helper receives useTranslation("tree").t the same way.
      if (/\/features\/tree\/token-speed\.tsx$/.test(path)) return code.replace(/\bt\((["`])speed\./g, "t($1tree:speed.");
      // These receive useTranslation("automations").t the same way.
      if (/\/features\/automations\/words\.ts$/.test(path)) return code.replace(/\bt\((["`])/g, "t($1automations:");
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
      "panels:agentSettings.context.source.*", // Where a model's context limit came from, by its source (contract CONTEXT_SOURCES).
      "panels:settings.personal.*",
      "panels:telemetry.blocked.*", // Eligibility reasons come from telemetryGate.
      "setup:skills.items.*", // An offered skill's name and description, looked up by its ID (contract SKILL_OFFERS).
      "setup:skills.reason.*", // Why a skill was not installed, by the server's reason code.
      "panels:settings.show.*", "panels:settings.showShort.*",
      "panels:settings.server.limit.*", "panels:settings.server.agentIssue.*",
      "reader:history.waiting.*", "reader:history.reasons.*", "reader:files.facet.*",
      "reader:reportFeed.row.*", // A History row says its party, kind and ending by the record's own values.
      "translation:problem.*", "translation:validation.*",
      // An automation said in words, by its fields' values and the server's codes (features/automations/words.ts).
      "automations:schedule.*", "automations:weekday.*", "automations:event.*", "automations:next.*",
      "automations:reason.*", "automations:runs.reason.*", "automations:duration.*", "automations:pressure.*",
      "automations:trigger.message.*", "automations:trigger.who.*", "automations:trigger.kind.*", "automations:runs.state.*",
      "automations:attention.*", "automations:phase.*", "automations:group.*", "automations:mark.*", "automations:dot.*", "automations:pane.*", "automations:effect.*",
      "panels:update.card.failedBody.*", // A failed update said by its category (features/update/UpdateView.tsx).
      "panels:telemetry.outcome.*", // What became of a request sent, by its outcome (features/telemetry/Telemetry.tsx).
      "panels:telemetry.fields.*", // A kind of information sent, by its field's name (features/telemetry/field-text.ts).
      "analysis:*", // The analysis writes its numbers and names through helpers and by the server's keys (features/analysis).
    ],
    sort: true,
    indentation: 2,
  },
});
