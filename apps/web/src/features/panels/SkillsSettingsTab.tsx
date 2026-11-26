import { useTranslation } from "react-i18next";
import { SKILL_OFFERS, type SkillJob } from "@alpacawork/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FieldError } from "@/components/ui/field";
import { ReadFailure } from "@/components/ui/loadable";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useSkillInstall, useSkillLatest, useSkills } from "@/data/skills";
import { formatCalendarDate } from "@/domain/time";
import { skillVersionState } from "@/domain/skill-version";
import { SkillOfferText } from "@/features/setup/SkillOfferRow";

/**
 * The skills setup offers, here to install one or bring it up to date at any time: each row as setup shows it, and at
 * its end its one action (Install, Update, Retry) or how it stands, over its versions. One that comes with alpacawork
 * has no version of its own: it is replaced with alpacawork at each update, and says so. One from GitHub shows the day
 * its folder there last changed, as installed and as the latest, read as the page opens. A press installs at once;
 * nothing waits for a save.
 */
export function SkillsSettingsTab() {
  const { t } = useTranslation("panels");
  const { t: setup } = useTranslation("setup");
  const skills = useSkills();
  const latest = useSkillLatest();
  const { install, start } = useSkillInstall();
  if (skills.isError) return <ReadFailure what={t("settings.tabs.skills")} error={skills.error} retry={() => void skills.refetch()} />;
  if (!skills.data) return <RegionSkeleton shape="skills" />;
  const server = skills.data.job && !skills.data.job.finished ? skills.data.job : null;
  const job: SkillJob | null = install.phase === "running" || install.phase === "finished" ? install.job : server;
  const busy = install.phase === "running" || !!server;
  return <div data-settings-skills>
    <p className="mt-0 mb-2 text-sm text-muted [word-break:auto-phrase]">{setup("skills.lead")}</p>
    <ul className="m-0 list-none p-0">
      {SKILL_OFFERS.map(offer => {
        const status = skills.data!.skills.find(each => each.name === offer.name)!;
        const bundled = offer.from.kind === "bundled";
        const latestAt = bundled ? null : latest.data?.skills.find(each => each.name === offer.name)?.latestAt ?? null;
        const state = skillVersionState({ bundled, installed: status.installed, installedAt: status.installedAt, latestAt });
        const item = job?.items.find(each => each.name === offer.name);
        const working = busy && (item?.state === "waiting" || item?.state === "installing");
        const failed = item?.state === "failed" && state.kind !== "current" ? item : null;
        const press = state.kind === "absent" || state.kind === "behind" || failed;
        return <li key={offer.name} data-settings-skill={offer.name} data-skill-state={state.kind} className="border-b border-line py-5 last:border-b-0">
          <div className="grid grid-cols-[minmax(0,1fr)_10rem] items-start gap-x-6 narrow:grid-cols-1 narrow:gap-y-3">
            <div className="min-w-0">
              <SkillOfferText offer={offer} />
              {failed && <FieldError className="mt-2 mb-0 [overflow-wrap:anywhere]">{setup("skills.failed", { reason: setup(`skills.reason.${failed.reason}`) })}
                {failed.reason === "other" && failed.detail && <span className="block text-xs text-soft">{failed.detail}</span>}</FieldError>}
            </div>
            <div className="flex flex-col items-end gap-2 narrow:min-h-11 narrow:flex-row-reverse narrow:items-center narrow:justify-between">
              {press || working
                ? <Button data-skill-action variant={failed ? "outline" : "default"} className="min-w-24 narrow:min-h-11" disabled={busy || !status.installed && !canInstall(status)}
                  onClick={() => void start([offer.name])}>
                  {working ? <><Icon name="pending" className="size-4 animate-spin [animation-duration:1.4s]" />{state.kind === "absent" ? t("settings.skills.installing") : t("settings.skills.updating")}</>
                    : failed ? t("settings.skills.retry") : state.kind === "absent" ? t("settings.skills.install") : t("settings.skills.update")}</Button>
                : <span className="inline-flex h-9 items-center gap-1 text-sm whitespace-nowrap text-done"><Icon name="check" className="size-4" />
                  {state.kind === "current" ? t("settings.skills.upToDate") : setup("skills.installed")}</span>}
              {bundled ? <span className="text-end text-xs text-soft narrow:text-start">{t("settings.skills.withApp")}</span>
                : <Versions installed={status.installed} installedAt={status.installedAt} latestAt={latestAt} behind={state.kind === "behind"}
                  checking={latest.isPending} />}
            </div>
          </div>
        </li>;
      })}
    </ul>
    <p className="mt-4 mb-0 text-xs text-soft [overflow-wrap:anywhere] [word-break:auto-phrase]">{setup("skills.where", { place: skills.data.place })}</p>
  </div>;
}

/** A skill from GitHub can always be fetched; one that comes with alpacawork only where this release carries it. */
const canInstall = (status: { available: "yes" | "no" | "unknown"; name: string }) =>
  SKILL_OFFERS.some(offer => offer.name === status.name && (offer.from.kind === "repo" || status.available === "yes"));

/**
 * A GitHub skill's days, under its action: the day it was installed from (or that it is not known), and the latest in
 * ink when it would bring a change; while the latest is read, or when it could not be, that is said in its place.
 */
function Versions({ installed, installedAt, latestAt, behind, checking }: {
  installed: boolean; installedAt: string | null; latestAt: string | null; behind: boolean; checking: boolean;
}) {
  const { t, i18n } = useTranslation("panels");
  const day = (iso: string) => formatCalendarDate(Date.parse(iso), Date.now(), i18n.language);
  return <span className="flex flex-col items-end gap-0.5 text-xs whitespace-nowrap text-soft tabular-nums narrow:items-start">
    {installed && <span>{t("settings.skills.versions.installed", { version: installedAt ? day(installedAt) : t("settings.skills.versions.unknown") })}</span>}
    {latestAt ? (behind || !installed) && <span className={cn(installed && "font-semibold text-ink")}>{t("settings.skills.versions.latest", { version: day(latestAt) })}</span>
      : <span>{checking ? t("settings.skills.versions.checking") : t("settings.skills.versions.unchecked")}</span>}
  </span>;
}
