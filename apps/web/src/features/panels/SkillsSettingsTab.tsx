import { useTranslation } from "react-i18next";
import { SKILL_OFFERS, type SkillName } from "@alpacawork/contract";
import { Button } from "@/components/ui/button";
import { ReadFailure } from "@/components/ui/loadable";
import { useSkillInstall, useSkills } from "@/data/skills";
import { SkillOfferText } from "@/features/setup/SkillOfferRow";
import { Loading } from "@/features/setup/parts";

// SAMPLE ONLY: the versions are not read from the server yet; these values are for the design sample.
const SAMPLE: Record<SkillName, { installed: string | null; latest: string }> = {
  askmeclearly: { installed: "11/02", latest: "11/20" },
  doyourjob: { installed: "11/20", latest: "11/20" },
  "alpacawork-betterquality": { installed: null, latest: "0.1.7" },
  "alpacawork-modelpickoptimization": { installed: "0.1.5", latest: "0.1.7" },
};

/**
 * The skills setup offers, here to install one or bring it up to date at any time: each row as setup shows it, with the
 * version on this PC and the latest, and its one action. Pressing it installs at once; nothing waits for a save.
 */
export function SkillsSettingsTab() {
  const { t } = useTranslation("panels");
  const { t: setup } = useTranslation("setup");
  const skills = useSkills();
  const { install, start } = useSkillInstall();
  if (skills.isError) return <ReadFailure what={t("settings.tabs.skills")} error={skills.error} retry={() => void skills.refetch()} />;
  if (!skills.data) return <Loading />;
  const running = install.phase === "running" ? install.job : null;
  return <div data-settings-skills>
    <p className="mt-0 mb-2 text-sm text-muted [word-break:auto-phrase]">{setup("skills.lead")}</p>
    <ul className="m-0 list-none p-0">
      {SKILL_OFFERS.map(offer => {
        const sample = SAMPLE[offer.name];
        const current = sample.installed !== null && sample.installed === sample.latest;
        const busy = running?.items.some(item => item.name === offer.name && item.state !== "done" && item.state !== "failed");
        return <li key={offer.name} data-settings-skill={offer.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 narrow:grid-cols-1 narrow:gap-y-2.5 border-b border-line py-3.5 last:border-b-0">
          <SkillOfferText offer={offer} meta={<span className="tabular-nums">
            {sample.installed === null ? t("settings.skills.notInstalled") : t("settings.skills.installedVersion", { version: sample.installed })}
            <span className="mx-1.5">→</span>{t("settings.skills.latestVersion", { version: sample.latest })}</span>} />
          <div className="pt-0.5 narrow:pt-0">
            {current ? <span className="inline-flex h-8 items-center text-sm whitespace-nowrap text-done">{t("settings.skills.upToDate")}</span>
              : <Button variant={sample.installed === null ? "default" : "outline"} disabled={!!busy || !!running} onClick={() => void start([offer.name])}>
                {busy ? t("settings.skills.installing") : sample.installed === null ? t("settings.skills.install") : t("settings.skills.update")}</Button>}
          </div>
        </li>;
      })}
    </ul>
    <p className="mt-3 mb-0 text-xs text-soft [overflow-wrap:anywhere] [word-break:auto-phrase]">{setup("skills.where", { place: skills.data.place })}</p>
  </div>;
}
