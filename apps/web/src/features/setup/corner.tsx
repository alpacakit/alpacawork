import { useTranslation } from "react-i18next";
import { activateLocale } from "@alpacawork/i18n";
import { isUiLocale, uiLocaleOrDefault } from "@alpacawork/core/ui-language";
import { personalSettings, uiLanguageOptions, type SettingDefinition } from "@alpacawork/contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { useWriteDisabled } from "@/data/queries";
import { resources } from "@/data/resources";
import { usePersonalSettings, visibleSettingValue } from "@/data/personal-settings";
import { intentKey, useWriteIntent, useWriteIntentStore } from "@/data/write-intent";

/**
 * A choice in the corner, saved to the person's own setting as Settings saves it: usable once a write can be sent (on a
 * slow first connection it waits greyed rather than drop the choice), shown as chosen while it saves, and put back when
 * the save is refused (which the save itself says, except that another screen saved it first, said here).
 */
function useCornerSetting(key: string) {
  const { t } = useTranslation("setup");
  const settings = usePersonalSettings();
  const denied = useWriteDisabled(resources.personalSettings(settings.root ?? "").queryKey);
  const writeKey = intentKey(settings.root ?? "", `personal-setting:${key}`, null);
  useWriteIntent(writeKey);
  const value = visibleSettingValue(key, settings);
  /** `show` puts what is shown in step with the setting when the choice did not stay (the language, applied before it saves). */
  const choose = async (next: string, show?: (value: unknown) => void) => {
    const before = usePersonalSettings.getState().values[key];
    if (await settings.save(key, next)) return;
    const conflict = useWriteIntentStore.getState().entries[writeKey]?.status === "conflict";
    show?.(conflict ? usePersonalSettings.getState().values[key] : before);
    if (conflict) notify.error(t("changedElsewhere"));
  };
  return { value, locked: denied || settings.status !== "ready", choose };
}

const themes = (personalSettings.find(setting => setting.key === "theme") as Extract<SettingDefinition, { kind: "select" }>).options.map(option => option.value);
/** The theme, as Settings has it: the page applies it at once and keeps it after setup. A phone shows the disc alone. */
export function ThemeSwitch() {
  const { t } = useTranslation("setup");
  const { value, locked, choose } = useCornerSetting("theme");
  const current = typeof value === "string" && themes.includes(value) ? value : "system";
  return <label className={cn("relative inline-flex h-9 items-center gap-2 rounded-sm border-hairline border-lit-line bg-lit px-3 text-sm narrow:w-9 narrow:justify-center narrow:px-0", locked && "opacity-60")}>
    <Icon name="theme" className="size-4 text-muted" />
    <select aria-label={t("theme")} value={current} disabled={locked} className="cursor-pointer border-0 bg-transparent text-ink disabled:cursor-default narrow:absolute narrow:inset-0 narrow:opacity-0"
      onChange={event => void choose(event.target.value)}>
      {themes.map(theme => <option key={theme} value={theme}>{{ system: t("themeOption.system"), light: t("themeOption.light"), dark: t("themeOption.dark") }[theme] ?? theme}</option>)}
    </select>
  </label>;
}

/** The display language: applied at once, and put back in step with the setting if the save does not stay. */
export function LanguageSwitch() {
  const { t, i18n } = useTranslation("setup");
  const { locked, choose } = useCornerSetting("language");
  const current = uiLocaleOrDefault(i18n.language);
  return <label className={cn("inline-flex h-9 items-center gap-2 rounded-sm border-hairline border-lit-line bg-lit px-3 text-sm", locked && "opacity-60")}>
    <Icon name="globe" className="size-4 text-muted" />
    <select aria-label={t("language")} value={current} disabled={locked} className="cursor-pointer border-0 bg-transparent text-ink disabled:cursor-default"
      onChange={event => {
        const next = event.target.value;
        if (!isUiLocale(next)) return;
        activateLocale(next);
        void choose(next, value => activateLocale(isUiLocale(value) ? value : current));
      }}>
      {uiLanguageOptions.map(({ value, labelKey }) => <option key={value} value={value}>{t(labelKey, { ns: "panels" })}</option>)}
    </select>
  </label>;
}
