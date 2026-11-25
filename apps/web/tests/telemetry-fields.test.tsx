import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { TELEMETRY_FIELDS } from "@alpacawork/contract/telemetry";
import { telemetryFieldKey, telemetryFieldsWithoutExample } from "../src/features/telemetry/field-text";

beforeAll(() => { startI18n(); });

// Asked again, a person reads what each added field is and an example value; a field added without either would be
// asked about by its name alone.
test("every kind of information sent says what it is in every language, with an example value", () => {
  expect(telemetryFieldsWithoutExample()).toEqual([]);
  const languages = Object.keys(i18n.options.resources ?? {});
  expect(languages.length).toBeGreaterThan(1);
  for (const language of languages)
    expect(TELEMETRY_FIELDS.filter(field => !i18n.exists(telemetryFieldKey(field), { lng: language, ns: "panels", fallbackLng: false })), language).toEqual([]);
});
