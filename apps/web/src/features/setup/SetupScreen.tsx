import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { installSetupTexts } from "@alpacawork/i18n/setup";
import { setupSteps, type SetupStep } from "@alpacawork/contract";
import { Icon } from "@/components/ui/icon";
import { ReadFailure } from "@/components/ui/loadable";
import { cn } from "@/lib/utils";
import { useFirstRun, useFirstRunChange } from "@/data/first-run";
import { useFrameSelector } from "@/data/workspace-store";
import { LanguageSwitch, ThemeSwitch } from "./corner";
import { Loading } from "./parts";
import { leaveSetup } from "./entrance";
import { AgentsStep } from "./AgentsStep";
import { SkillsStep } from "./SkillsStep";
import { ProjectStep } from "./ProjectStep";
import logo from "../../../public/icons/icon-192-2c.png?inline";

/**
 * The setup a new workspace opens on, in three steps: the agents, the skills, the project. Each step saves when it is
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
  const lead = { agents: [t("agents.lead"), t("agents.later")], skills: [t("skills.lead")],
    project: [t("project.lead"), t("project.policyLead")] }[step];
  return <Frame aside={<>
    <Steps current={step} onPick={go} />
    <h1 className="m-0 mt-6 text-xl font-semibold narrow:mt-4">{{ agents: t("agents.title"), skills: t("skills.title"), project: t("project.title") }[step]}</h1>
    {lead.map((line, at) => <p key={at} className={cn("m-0 mt-3 text-base text-muted [word-break:auto-phrase]", at > 0 && "narrow:hidden")}>{line}</p>)}
  </>}>
    {step === "agents" && <AgentsStep onNext={() => go("skills")} />}
    {step === "skills" && <SkillsStep onBack={() => go("agents")} onNext={() => go("project")} />}
    {(step === "project" || projectSeen) && <div hidden={step !== "project"}>
      <ProjectStep projectId={state.project} active={step === "project"} onBack={() => go("skills")} onFinish={finish} />
    </div>}
  </Frame>;
}

/** 1 Agents — 2 Skills — 3 Project: a step done can be gone back to; the ones ahead wait. */
function Steps({ current, onPick }: { current: SetupStep; onPick: (step: SetupStep) => void }) {
  const { t } = useTranslation("setup");
  const at = setupSteps.indexOf(current);
  const names = { agents: t("steps.agents"), skills: t("steps.skills"), project: t("steps.project") };
  return <ol aria-label={t("steps.label")} className="m-0 flex list-none flex-wrap items-center gap-x-2 gap-y-1 p-0 text-sm" data-setup-steps>
    {setupSteps.map((step, index) => <Fragment key={step}>
      {index > 0 && <li aria-hidden className="inline-flex h-6 items-center text-soft">—</li>}
      <li data-setup-step={step} aria-current={index === at ? "step" : undefined}>
        {index < at ? <button type="button" onClick={() => onPick(step)} className="inline-flex h-6 items-center gap-1 align-top text-muted hover:text-ink">
          <Icon name="check" className="size-3.5" />{names[step]}</button>
          : <span className={cn("inline-flex h-6 items-center align-top", index === at ? "font-semibold text-ink" : "text-soft")}>{index + 1} {names[step]}</span>}
      </li>
    </Fragment>)}
  </ol>;
}

/** The header with the corner's choices, then the step's description on the left and its settings on the right. */
function Frame({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return <div data-setup-screen className="min-h-dvh bg-bg text-ink">
    <header className="flex items-center justify-between gap-3 px-8 py-4 narrow:px-4 narrow:py-3">
      <span className="inline-flex items-center gap-2 text-lg font-semibold">
        <img src={logo} alt="" className="size-7 rounded-full" />alpacawork</span>
      <div className="flex items-center gap-2"><ThemeSwitch /><LanguageSwitch /></div>
    </header>
    <main className="mx-auto grid w-full max-w-272 grid-cols-[minmax(16rem,1fr)_minmax(0,40rem)] items-start gap-16 px-8 pt-12 pb-16 max-[60rem]:grid-cols-1 max-[60rem]:gap-6 narrow:px-4 narrow:pt-4">
      <div className="min-w-0">{aside}</div>
      <section className="min-w-0 rounded-pane border-hairline border-lit-line bg-lit p-7 narrow:p-5">{children}</section>
    </main>
  </div>;
}
