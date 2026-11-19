import { useTranslation } from "react-i18next";
import { telemetryDetailsUrl } from "@alpacawork/contract/telemetry";

/** What usage data holds and how it is handled, in the display language: one page for setup and Settings. */
export function TelemetryDetailsLink() {
  const { t, i18n } = useTranslation("panels");
  return <a className="inline-link after:hidden" href={telemetryDetailsUrl(i18n.resolvedLanguage ?? "en")} target="_blank" rel="noreferrer">{t("telemetry.more")}</a>;
}
