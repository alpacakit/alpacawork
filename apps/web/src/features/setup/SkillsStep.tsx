import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { SKILL_OFFERS, canSelectSkill, type SkillJob, type SkillName } from "@alpacawork/contract";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { ReadFailure } from "@/components/ui/loadable";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { problemText } from "@/features/forms/problem-text";
import { useSkillInstall, useSkills } from "@/data/skills";
import { BetaMark, FailureLine, Loading, RecommendedMark, StepButtons } from "./parts";

/**
 * Step 3: the offered skills, each by what it changes, the recommended ones ticked and those without a cost marked, a beta one marked. The button names what it installs, and pressing it is the
 * approval; once every ticked skill is installed the setup goes on by itself. A skill that failed says why on its row
 * and stays ticked, so the same button tries it again. Listing never contacts where a skill comes from.
 */
export function SkillsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { t } = useTranslation("setup");
  const skills = useSkills();
  const { install, start, follow } = useSkillInstall();
  const [ticked, setTicked] = useState<Set<SkillName> | null>(null);
  const statuses = skills.data?.skills;
  useEffect(() => {
    if (!statuses || ticked) return;
    setTicked(new Set(SKILL_OFFERS.filter(offer => offer.recommended).map(offer => offer.name)));
  }, [statuses]);
  // An install still running when the step opens (left and come back to, or reloaded) is followed, not offered again.
  const running = skills.data?.job && !skills.data.job.finished ? skills.data.job : null;
  useEffect(() => { if (running && install.phase === "idle") void follow(running); }, [running?.id]);
  // The rows' install state: the job running, or the one just finished.
  const job: SkillJob | null = install.phase === "running" || install.phase === "finished" ? install.job : null;
  const installing = install.phase === "running" || !!running;
  // Every chosen skill went in: said once, as the setup moves on (a failure stays here, on its row).
  useEffect(() => {
    if (install.phase !== "finished" || !install.job.items.every(item => item.state === "done")) return;
    notify.success(t("skills.done", { count: install.job.items.length }));
    onNext();
  }, [install]);
  if (skills.isError) return <ReadFailure what={t("skills.title")} error={skills.error} retry={() => void skills.refetch()} />;
  if (!statuses || !ticked) return <Loading />;
  const installed = (name: SkillName) => !!statuses.find(status => status.name === name)?.installed;
  const selectable = (name: SkillName) => { const status = statuses.find(each => each.name === name); return !!status && canSelectSkill(status); };
  const toInstall = SKILL_OFFERS.map(offer => offer.name).filter(name => ticked.has(name) && !installed(name) && selectable(name));
  const toggle = (name: SkillName, on: boolean) => setTicked(before => { const next = new Set(before); if (on) next.add(name); else next.delete(name); return next; });
  return <div data-setup-panel="skills">
    <ul className="m-0 -mt-3 list-none p-0">
      {SKILL_OFFERS.map(offer => {
        const done = installed(offer.name);
        const item = job?.items.find(each => each.name === offer.name);
        return <li key={offer.name} data-setup-skill={offer.name} className="border-b border-line">
          <label className={cn("grid cursor-pointer grid-cols-[22px_minmax(0,1fr)] items-start gap-x-3 py-3", (done || installing) && "cursor-default")}>
            <input type="checkbox" checked={done || ticked.has(offer.name)} disabled={done || installing || !selectable(offer.name)}
              onChange={event => toggle(offer.name, event.target.checked)} className="mt-0.75 size-4.5 cursor-pointer accent-ink disabled:cursor-default" />
            {/* What it changes, then how, then which skill and where it comes from: the name means little before it is used. */}
            <span className="min-w-0">
              {/* The state sits on the heading's line only, so the lines under it keep the row's width; where the heading
                  leaves no room for it (a phone), it drops under the heading rather than squeeze it. */}
              <span className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-semibold [word-break:auto-phrase]">{t(`skills.items.${offer.name}.title`)}</span>
                {/* Marked only where nothing is given up for it: a recommended one that costs time and tokens is ticked, not urged. */}
                {offer.recommended && !offer.cost && <RecommendedMark className="self-center" />}
                {offer.beta && <BetaMark className="self-center" />}
                {done ? <span className="ml-auto text-sm whitespace-nowrap text-done">{t("skills.installed")}</span>
                  : item?.state === "installing" && installing ? <span className="ml-auto text-sm whitespace-nowrap text-muted">{t("skills.installing")}</span> : null}
              </span>
              <span className="mt-0.5 block text-sm text-muted [word-break:auto-phrase]">{t(`skills.items.${offer.name}.what`)}</span>
              <span className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-soft">
                <code className="font-mono text-muted [overflow-wrap:anywhere]">{offer.name}</code>
                {/* Only a skill fetched from elsewhere says where from; one that comes with alpacawork needs no word. */}
                {offer.from.kind === "repo" && <span className="[word-break:auto-phrase]">
                  <Trans t={t} i18nKey="skills.from.repo" values={{ repo: offer.from.repo }}
                    components={{ repo: <a className="inline-link" href={`https://github.com/${offer.from.repo}`} target="_blank" rel="noreferrer" /> }} /></span>}
              </span>
            </span>
          </label>
          {/* Under the row's words, outside its label: a failure is read, not part of what the checkbox names. */}
          {item?.state === "failed" && !done && <FieldError className="-mt-2 mb-3 ml-[34px] [overflow-wrap:anywhere]">
            {t("skills.failed", { reason: t(`skills.reason.${item.reason}`) })}
            {/* Only a cause without words of its own carries the installer's (English) detail. */}
            {item.reason === "other" && item.detail && <span className="block text-xs text-soft">{item.detail}</span>}</FieldError>}
        </li>;
      })}
    </ul>
    <p className="mt-4 mb-0 text-sm text-muted [overflow-wrap:anywhere] [word-break:auto-phrase]">{t("skills.where", { place: skills.data!.place })}</p>
    <StepButtons back={{ onClick: onBack, disabled: installing }}
      failure={install.phase === "failed" ? <FailureLine text={t("skills.failedRequest")} detail={problemText(install.error)} /> : null}
      other={toInstall.length ? <Button variant="outline" data-setup-skip disabled={installing} className="min-h-11 narrow:w-full" onClick={onNext}>{t("skills.skip")}</Button> : null}>
      {toInstall.length
        ? <Button data-setup-install className="min-h-11 px-6 narrow:w-full" disabled={installing} onClick={() => void start(toInstall)}>
          {installing ? t("skills.installing") : t("skills.install", { count: toInstall.length })}</Button>
        : <Button data-setup-next className="min-h-11 px-6 narrow:w-full" onClick={onNext}>{t("next")}</Button>}
    </StepButtons>
  </div>;
}
