import { useTranslation } from "react-i18next";
import { SKILL_OFFERS, type SkillName } from "@alpacawork/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FieldError } from "@/components/ui/field";
import { ReadFailure } from "@/components/ui/loadable";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useSkillInstall, useSkills } from "@/data/skills";
import { SkillOfferText } from "@/features/setup/SkillOfferRow";

// SAMPLE ONLY: the versions are not read from the server yet; these values are for the design sample.
type Sample = { installed: string | null; latest: string; state?: "installing" | "failed" };
const SAMPLES: Record<string, Record<SkillName, Sample>> = {
  a: {
    askmeclearly: { installed: "11/02", latest: "11/20" },
    doyourjob: { installed: "11/20", latest: "11/20" },
    "alpacawork-betterquality": { installed: null, latest: "0.1.7" },
    "alpacawork-modelpickoptimization": { installed: "0.1.5", latest: "0.1.7" },
  },
  b: {
    askmeclearly: { installed: "11/02", latest: "11/20", state: "installing" },
    doyourjob: { installed: "11/20", latest: "11/20" },
    "alpacawork-betterquality": { installed: null, latest: "0.1.7", state: "failed" },
    "alpacawork-modelpickoptimization": { installed: "0.1.7", latest: "0.1.7" },
  },
};
const sampleSet = () => SAMPLES[new URLSearchParams(location.search).get("sample") ?? "a"] ?? SAMPLES.a!;

/**
 * The skills setup offers, here to install one or bring it up to date at any time: each row as setup shows it, and at
 * its end what it is on this PC — its one action (Install, Update) or Up to date — over the version there and the latest.
 * Pressing it installs at once; nothing waits for a save.
 */
export function SkillsSettingsTab() {
  const { t } = useTranslation("panels");
  const { t: setup } = useTranslation("setup");
  const skills = useSkills();
  const { install, start } = useSkillInstall();
  if (skills.isError) return <ReadFailure what={t("settings.tabs.skills")} error={skills.error} retry={() => void skills.refetch()} />;
  if (!skills.data) return <RegionSkeleton shape="skills" />;
  const running = install.phase === "running" ? install.job : null;
  const samples = sampleSet();
  return <div data-settings-skills>
    <p className="mt-0 mb-2 text-sm text-muted [word-break:auto-phrase]">{setup("skills.lead")}</p>
    <ul className="m-0 list-none p-0">
      {SKILL_OFFERS.map(offer => {
        const sample = samples[offer.name];
        const installing = sample.state === "installing" || !!running?.items.some(item => item.name === offer.name && item.state !== "done" && item.state !== "failed");
        const failed = sample.state === "failed";
        const current = sample.installed !== null && sample.installed === sample.latest;
        return <li key={offer.name} data-settings-skill={offer.name} className="border-b border-line py-5 last:border-b-0">
          <div className="grid grid-cols-[minmax(0,1fr)_10rem] items-start gap-x-6 narrow:grid-cols-1 narrow:gap-y-3">
            <div className="min-w-0">
              <SkillOfferText offer={offer} />
              {failed && <FieldError className="mt-2 mb-0 [overflow-wrap:anywhere]">{setup("skills.failed", { reason: setup("skills.reason.unreachable") })}</FieldError>}
            </div>
            <div className="flex flex-col items-end gap-2 narrow:min-h-11 narrow:flex-row-reverse narrow:items-center narrow:justify-between">
              {current ? <span className="inline-flex h-9 items-center gap-1 text-sm whitespace-nowrap text-done"><Icon name="check" className="size-4" />{t("settings.skills.upToDate")}</span>
                : <Button variant={failed ? "outline" : "default"} className="min-w-24 narrow:min-h-11" disabled={installing || !!running} onClick={() => void start([offer.name])}>
                  {installing ? <><Icon name="pending" className="size-4 animate-spin [animation-duration:1.4s]" />{sample.installed === null ? t("settings.skills.installing") : t("settings.skills.updating")}</>
                    : failed ? t("settings.skills.retry") : sample.installed === null ? t("settings.skills.install") : t("settings.skills.update")}</Button>}
              <Versions installed={sample.installed} latest={sample.latest} current={current} />
            </div>
          </div>
        </li>;
      })}
    </ul>
    <p className="mt-4 mb-0 text-xs text-soft [overflow-wrap:anywhere] [word-break:auto-phrase]">{setup("skills.where", { place: skills.data.place })}</p>
  </div>;
}

/**
 * The version on this PC over the latest, each named, under the row's action: the latest in ink when an update would
 * bring it, only the one installed when they are the same, only the latest when none is installed. A skill fetched from
 * GitHub has no version number: its versions are the days its folder last changed.
 */
function Versions({ installed, latest, current }: { installed: string | null; latest: string; current: boolean }) {
  const { t } = useTranslation("panels");
  return <span className="flex flex-col items-end gap-0.5 text-xs whitespace-nowrap text-soft tabular-nums narrow:items-start">
    {installed !== null && <span>{t("settings.skills.versions.installed", { version: installed })}</span>}
    {!current && <span className={cn(installed !== null && "font-semibold text-ink")}>{t("settings.skills.versions.latest", { version: latest })}</span>}
  </span>;
}
