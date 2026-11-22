import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { installSetupTexts } from "@alpacawork/i18n/setup";
import { setupSteps, type SetupStep } from "@alpacawork/contract";
import { Icon } from "@/components/ui/icon";
import { ReadFailure } from "@/components/ui/loadable";
import { cn } from "@/lib/utils";
import { useFirstRun, useFirstRunChange } from "@/data/first-run";
import { useFrameSelector } from "@/data/workspace-store";
import { Loading } from "./parts";
import { leaveSetup } from "./entrance";
import { DisplayStep } from "./DisplayStep";
import { AgentsStep } from "./AgentsStep";
import { SkillsStep } from "./SkillsStep";
import { ProjectStep } from "./ProjectStep";
import logo from "../../../public/icons/icon-192-2c.png?inline";

/**
 * The setup a new workspace opens on, in four steps: the language and theme, the agents, the skills, the project. Each step saves when it is
 * left forward, and the step reached is recorded, so a reload opens where the person was. Finishing opens the page on
 * the project, in the same document.
 */
export function SetupScreen() {
  installSetupTexts();
  const ready = useFrameSelector(data => data !== null);
  return ready ? <Setup /> : <Frame><Loading /></Frame>;
}

function Setup() {
  const { t } = useTranslation("setup");
  const read = useFirstRun();
  const change = useFirstRunChange();
  const state = read.data?.state;
  const [step, setStep] = useState<SetupStep | null>(null);
  // The project step keeps what was typed while the person goes back to an earlier step.
  const [projectSeen, setProjectSeen] = useState(false);
  useEffect(() => {
    if (!read.data) return;
    // Nothing to set up (made before setup existed, or finished on another screen): the page.
    if (!state || state.finishedAt) { leaveSetup(new URL("/", location.href)); return; }
    setStep(was => was ?? state.step);
  }, [read.data]);
  useEffect(() => { if (step === "project") setProjectSeen(true); }, [step]);
  if (read.isError) return <Frame><ReadFailure what={t("title")} error={read.error} retry={() => void read.refetch()} /></Frame>;
  if (!state || !step) return <Frame><Loading /></Frame>;
  /** Where to reopen is only remembered: a failure to note it is not said, and the step is shown all the same. */
  const go = (next: SetupStep) => {
    setStep(next);
    change.mutate({ kind: "step", step: next });
  };
  const finish = async () => {
    await change.mutateAsync({ kind: "finish" });
    const url = new URL("/", location.href);
    url.searchParams.set("project", state.project);
    leaveSetup(url);
  };
  const lead = { display: t("display.lead"), agents: t("agents.lead"), skills: t("skills.lead"), project: t("project.lead") }[step];
  // The step's name is the page's heading: it rises in again whenever the step changes, so a move is seen at once.
  return <Frame aside={<>
    <Steps current={step} onPick={go} />
    <div key={step} className="animate-welcome">
      {/* Beside the settings the column is narrow: a step down keeps a short name such as "First project" on one line. */}
      <h1 className="m-0 mt-8 text-display font-semibold [word-break:auto-phrase] min-[60rem]:text-[1.875rem] narrow:mt-6">{{ display: t("display.title"), agents: t("agents.title"), skills: t("skills.title"), project: t("project.title") }[step]}</h1>
      {/* Phrase breaks with lines of even length: filled line by line, the narrow column left a run of short lines. A
          phrase longer than the line still breaks inside it: the column's width (the settings take 37rem) avoids that beside
          the settings, and a phone, whose full-width lines are long enough, fills them instead of narrowing them to balance. */}
      <p className="m-0 mt-3 text-md text-muted text-balance [word-break:auto-phrase] narrow:text-wrap">{lead}</p>
    </div>
  </>}>
    {step === "display" && <DisplayStep onNext={() => go("agents")} />}
    {step === "agents" && <AgentsStep onBack={() => go("display")} onNext={() => go("skills")} />}
    {step === "skills" && <SkillsStep onBack={() => go("agents")} onNext={() => go("project")} />}
    {(step === "project" || projectSeen) && <div hidden={step !== "project"}>
      <ProjectStep projectId={state.project} active={step === "project"} onBack={() => go("skills")} onFinish={finish} />
    </div>}
  </Frame>;
}

/**
 * Where the person is, as a bar of one part per step under "Step 2 of 4": the parts up to this step filled, each named under
 * its part. A step done can be gone back to from its name; the ones ahead wait.
 */
function Steps({ current, onPick }: { current: SetupStep; onPick: (step: SetupStep) => void }) {
  const { t } = useTranslation("setup");
  const at = setupSteps.indexOf(current);
  const names = { display: t("steps.display"), agents: t("steps.agents"), skills: t("steps.skills"), project: t("steps.project") };
  return <nav aria-label={t("steps.label")}>
    <p className="m-0 text-sm font-semibold text-muted" data-setup-step-count>{t("steps.of", { at: at + 1, total: setupSteps.length })}</p>
    {/* Each part is at least as wide as its name, so no name breaks in the narrow column beside the settings. */}
    <ol className="m-0 mt-2 flex list-none gap-1.5 p-0 text-sm" data-setup-steps>
      {setupSteps.map((step, index) => <li key={step} data-setup-step={step} aria-current={index === at ? "step" : undefined} className="flex-[1_1_auto] whitespace-nowrap">
        <span aria-hidden className={cn("block h-1 rounded-full", index <= at ? "bg-ink" : "bg-line")} />
        {index < at ? <button type="button" onClick={() => onPick(step)} className="mt-1 inline-flex min-h-8 items-center gap-1 text-muted hover:text-ink pointer-coarse:min-h-11">
          <Icon name="check" className="size-3.5 flex-none" />{names[step]}</button>
          : <span className={cn("mt-1 inline-flex min-h-8 items-center pointer-coarse:min-h-11", index === at ? "font-semibold text-ink" : "text-soft")}>{names[step]}</span>}
      </li>)}
    </ol>
  </nav>;
}

/** The header, then the step's description on the left and its settings on the right. */
function Frame({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return <div data-setup-screen className="min-h-dvh bg-bg text-ink">
    <header className="flex flex-wrap items-center justify-between gap-3 px-8 py-4 narrow:px-4 narrow:py-3">
      <span className="inline-flex items-center gap-2 text-lg font-semibold">
        <img src={logo} alt="" className="size-7 rounded-full" />alpacawork</span>
    </header>
    <main className="mx-auto grid w-full max-w-272 grid-cols-[minmax(16rem,1fr)_minmax(0,37rem)] items-start gap-16 px-8 pt-12 pb-16 max-[60rem]:grid-cols-1 max-[60rem]:gap-6 narrow:px-4 narrow:pt-4">
      <div className="min-w-0">{aside}</div>
      <section className="min-w-0 rounded-pane border-hairline border-lit-line bg-lit p-7 narrow:p-5">{children}</section>
    </main>
  </div>;
}
