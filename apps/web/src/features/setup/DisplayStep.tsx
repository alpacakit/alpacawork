import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { activateLocale } from "@alpacawork/i18n";
import { isUiLocale, uiLocaleOrDefault } from "@alpacawork/core/ui-language";
import { personalSettings, uiLanguageOptions, type SettingDefinition } from "@alpacawork/contract";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { useWriteDisabled } from "@/data/queries";
import { resources } from "@/data/resources";
import { usePersonalSettings, visibleSettingValue } from "@/data/personal-settings";
import { intentKey, useWriteIntent, useWriteIntentStore } from "@/data/write-intent";
import { StepButtons } from "./parts";

/**
 * Step 1: the screen's language and theme, each a choice laid out in full. A choice applies at once and is saved to the
 * person's own setting as Settings saves it, so it stays after setup; Next only moves on. The language comes first, so
 * that the rest of the setup is read in the language chosen.
 */
export function DisplayStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation("setup");
  return <div data-setup-panel="display">
    <LanguageChoice />
    <ThemeChoice />
    <StepButtons>
      <Button data-setup-next className="min-h-11 px-6 narrow:w-full" onClick={onNext}>{t("next")}</Button>
    </StepButtons>
  </div>;
}

/**
 * A personal setting chosen here: usable once a write can be sent (on a slow first connection it waits greyed rather
 * than drop the choice), shown as chosen while it saves, and put back when the save is refused (which the save itself
 * says, except that another screen saved it first, said here).
 */
function usePersonalChoice(key: string) {
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

/** Each language under its own name, so a person who cannot read the current one still finds theirs. */
function LanguageChoice() {
  const { t, i18n } = useTranslation("setup");
  const { locked, choose } = usePersonalChoice("language");
  const current = uiLocaleOrDefault(i18n.language);
  const pick = (next: string) => {
    if (!isUiLocale(next) || next === current) return;
    activateLocale(next);
    void choose(next, value => activateLocale(isUiLocale(value) ? value : current));
  };
  return <Choices name="setup-language" legend={t("language")} icon="globe" locked={locked} grid="grid-cols-2 narrow:grid-cols-1">
    {uiLanguageOptions.map(({ value, labelKey }) => <Option key={value} name="setup-language" value={value} data-setup-language={value}
      checked={current === value} locked={locked} onPick={pick}>
      <Dot on={current === value} /><span lang={value} className="font-semibold">{t(labelKey, { ns: "panels" })}</span>
    </Option>)}
  </Choices>;
}

const themes = (personalSettings.find(setting => setting.key === "theme") as Extract<SettingDefinition, { kind: "select" }>).options.map(option => option.value);
/** The theme, each with a small picture of the page in it; the page takes the one chosen at once. */
function ThemeChoice() {
  const { t } = useTranslation("setup");
  const { value, locked, choose } = usePersonalChoice("theme");
  const current = typeof value === "string" && themes.includes(value) ? value : "system";
  return <Choices name="setup-theme" legend={t("theme")} note={t("themeSystem")} locked={locked} className="mt-7" grid="grid-cols-3">
    {themes.map(theme => <Option key={theme} name="setup-theme" value={theme} data-setup-theme={theme} checked={current === theme} locked={locked}
      onPick={next => { if (next !== current) void choose(next); }} className="flex-col items-stretch gap-2 p-2 pb-2.5">
      <ThemePicture theme={theme} />
      <span className="flex items-center gap-2 px-1 font-semibold narrow:gap-1.5 narrow:px-0 narrow:text-sm"><Dot on={current === theme} />{{ system: t("themeOption.system"), light: t("themeOption.light"), dark: t("themeOption.dark") }[theme] ?? theme}</span>
    </Option>)}
  </Choices>;
}

/** A page in miniature, in the theme's own ground, panel and text; the system theme shows light and dark side by side. */
function ThemePicture({ theme }: { theme: string }) {
  const page = (dark: boolean) => <span className={cn("flex flex-1 items-end p-1.5", dark ? "bg-[#07090c]" : "bg-[#f4f6f9]")}>
    <span className={cn("flex h-3/4 w-full flex-col gap-1 rounded-t-sm p-1.5", dark ? "bg-[oklch(24.5%_0.007_260)]" : "bg-[oklch(99.7%_0.005_260)]")}>
      <span className={cn("block h-1 w-3/5 rounded-full", dark ? "bg-[oklch(95%_0.005_260)]" : "bg-[oklch(21%_0.006_260)]")} />
      <span className={cn("block h-1 w-4/5 rounded-full", dark ? "bg-[oklch(50%_0.006_260)]" : "bg-[oklch(80%_0.006_260)]")} />
    </span>
  </span>;
  return <span aria-hidden className="flex h-14 overflow-hidden rounded-sm border-hairline border-line">
    {theme !== "dark" && page(false)}{theme !== "light" && page(true)}
  </span>;
}

function Choices({ name, legend, icon, note, locked, className, grid, children }: {
  name: string; legend: string; icon?: IconName; note?: string; locked: boolean; className?: string; grid: string; children: ReactNode;
}) {
  const noteId = useId();
  return <fieldset data-setup-choices={name} disabled={locked} aria-describedby={note ? noteId : undefined} className={cn("m-0 min-w-0 border-0 p-0", locked && "opacity-60", className)}>
    <legend className="flex items-center gap-1.5 p-0 font-semibold">{icon && <Icon name={icon} className="size-4 text-muted" />}{legend}</legend>
    {note && <p id={noteId} className="m-0 mt-1 text-sm text-muted [word-break:auto-phrase]">{note}</p>}
    <div className={cn("mt-3 grid gap-2", grid)}>{children}</div>
  </fieldset>;
}

/** One choice as a box that is pressed whole: a native radio inside, so the keys move between choices as usual. */
function Option({ name, value, checked, locked, onPick, className, children, ...data }: {
  name: string; value: string; checked: boolean; locked: boolean; onPick: (value: string) => void; className?: string; children: ReactNode;
} & Record<`data-${string}`, string>) {
  return <label {...data} className={cn("relative flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md border-hairline border-line bg-lit px-3 py-2 text-base hover:border-muted has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ink",
    checked && "border-ink outline outline-1 -outline-offset-2 outline-ink hover:border-ink", locked && "cursor-default", className)}>
    <input type="radio" name={name} value={value} checked={checked} disabled={locked} onChange={() => onPick(value)} className="sr-only" />
    {children}
  </label>;
}

/** The mark a chosen box carries, as the agents step marks its default agent. */
function Dot({ on }: { on: boolean }) {
  return <span aria-hidden className={cn("size-4 flex-none rounded-full border-[1.5px] border-muted", on && "border-[5px] border-ink")} />;
}
