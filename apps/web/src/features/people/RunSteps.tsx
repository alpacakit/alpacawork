import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RunFullStep, RunStep, RunStepsRead } from "@alpacawork/contract/run";
import { readRunSteps } from "@/data/run-steps";
import { Message } from "@/components/ui/message";
import { cn } from "@/lib/utils";

/* Hallmark · component: an agent's work line and its steps · genre: modern-minimal · theme: the app's own tokens (ink,
 * soft, muted, error, working, line) · states: folded (one line: the moving mark, the tool and what it runs) · open
 * (every step so far, one line each) · a step opened (what it ran and what came back, in full) · a step done (✓) or
 * failed (red ✗) · reading · not readable · reduced motion (the mark's three dots stand still) */

/** Codex names its items by their type; said as the tool names other agents give. Any other tool keeps its own name. */
const ITEM_NAMES: Record<string, string> = { command_execution: "Bash", file_change: "Edit", web_search: "WebSearch", mcp_tool_call: "MCP", collab_tool_call: "Agent" };
const toolName = (tool: string) => ITEM_NAMES[tool] ?? tool;
/** A file's name is at the end of its path: cut short, these lose their start. */
const atEnd = (kind: string) => kind === "file" || kind === "edit";
/** What was run, on one line as written: its spaces kept, cut at the end. */
const ONE_LINE = "min-w-0 overflow-hidden text-ellipsis whitespace-pre font-mono";
/** What it ran keeps at least a few letters in sight on one line, however long the tool's name and the agent's words. */
const TARGET = "flex-1 min-w-[8ch]";
/** A tool's name gives way before what it ran: it never takes more than this of the line. */
const TOOL = "max-w-[40%] flex-none truncate font-medium";
/** A group that turns about the mark's own centre. */
const ABOUT_CENTRE = "[transform-box:view-box] origin-center";

/**
 * An agent at work, drawn as vectors so it stays sharp at any size: three dots go once round, gather into one and part
 * again. It says only that the agent is going, where one agent's work is open to read; under reduced motion the three
 * dots stand still.
 */
export function WorkMark({ className }: { className?: string }) {
  return <svg aria-hidden data-work-mark viewBox="0 0 24 24" fill="currentColor" className={cn("size-3.5 flex-none self-center overflow-visible text-working", className)}>
    <g className={cn(ABOUT_CENTRE, "motion-safe:animate-mark-weave-turn")}>
      {[0, 1, 2].map(arm => <g key={arm} className={ABOUT_CENTRE} style={{ rotate: `${arm * 120}deg` }}>
        <circle cx="12" cy="12" r="3" className="[translate:0_-8px] motion-safe:animate-mark-weave-dot" /></g>)}
    </g>
  </svg>;
}

type Line = Pick<RunStep, "tool" | "kind" | "about" | "text">;
/** The tool, the agent's own words for it when it gave them, then as much of what it ran as fits: one line. */
function LineWords({ line }: { line: Line }) {
  return <>
    <span className={TOOL}>{toolName(line.tool)}</span>
    {line.about && <span dir="auto" className="min-w-0 max-w-[62%] truncate">{line.about}</span>}
    {atEnd(line.kind)
      ? <span dir="rtl" className={cn(ONE_LINE, TARGET, "text-left")}><bdi>{line.text}</bdi></span>
      : <span dir="auto" className={cn(ONE_LINE, TARGET, line.about && "text-muted")}>{line.text}</span>}
  </>;
}

/**
 * What an agent is doing now, on one line that keeps its height: the moving mark, then its latest step, or `idle` (the
 * words for an agent that has run nothing yet). `label` takes the step's place where the steps are listed under it (how
 * many there are). `end` closes the line (seconds, a chevron).
 */
export function WorkLine({ step, idle, label, end, className, ...data }: { step: RunStep | undefined; idle?: string; label?: string; end?: ReactNode; className?: string;
  [data: `data-${string}`]: true | undefined }) {
  if (!step && !idle && !label) return null;
  return <div data-work-line {...data} className={cn("flex min-w-0 items-baseline gap-1.5 text-xs text-soft", className)}>
    <WorkMark />
    {label !== undefined ? <span className="min-w-0 flex-1 truncate">{label}</span>
      : step ? <LineWords line={step} /> : <span className="min-w-0 flex-1 truncate">{idle}</span>}
    {end}
  </div>;
}

export type StepsRead = { read: RunStepsRead | null; failed: boolean };
/** How many steps a Run has taken, as far as they were read. */
export const stepCount = (read: RunStepsRead | null) => read ? read.steps.length + read.older : undefined;
/**
 * Every step of Run `run`, read while `shown` and again whenever `version` changes (the latest step the screen was
 * told of, while the Run goes on); nothing is read while they are not shown.
 */
export function useRunSteps(run: string | undefined, shown: boolean, version = ""): StepsRead {
  const [state, setState] = useState<StepsRead & { run?: string }>({ read: null, failed: false });
  useEffect(() => {
    if (!run || !shown) return;
    const abort = new AbortController();
    readRunSteps(run, abort.signal).then(read => setState({ run, read, failed: false }),
      () => { if (!abort.signal.aborted) setState(previous => ({ ...previous, run, failed: true })); });
    return () => abort.abort();
  }, [run, shown, version]);
  return shown && state.run === run ? state : { read: null, failed: false };
}

const BLOCK = "m-0 max-h-64 overflow-auto rounded-sm border border-line bg-bg p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]";
/** What a step ran or got back, in full up to the read's limit, saying so where it was cut. */
function StepText({ text, cut, tone, ...data }: { text: string; cut: boolean; tone: string; "data-run-step-input"?: true; "data-run-step-output"?: true }) {
  const { t } = useTranslation("people");
  return <pre dir="auto" {...data} className={cn(BLOCK, tone)}>{text}{cut && <span className="block font-sans text-muted">{t("now.step.cut")}</span>}</pre>;
}
/** One step of the list: its line, and on a press what it ran and what came back, in full. */
function StepRow({ step }: { step: RunFullStep }) {
  const { t } = useTranslation("people");
  const [open, setOpen] = useState(false);
  const first = step.input.text.split("\n")[0] ?? "";
  return <li data-run-step={step.state} className="min-w-0">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
      className="flex w-full min-w-0 cursor-pointer items-baseline gap-1.5 rounded-sm py-0.5 text-left text-soft outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-ring narrow:py-1.5">
      <span data-run-step-mark className={cn("w-2.5 flex-none text-center font-sans", step.state === "failed" ? "text-error" : step.state === "running" ? "text-working motion-safe:animate-pulse" : "text-muted")}>
        <span aria-hidden>{step.state === "running" ? "●" : step.state === "failed" ? "✗" : "✓"}</span>
        <span className="sr-only">{step.state === "running" ? t("now.step.state.running") : step.state === "failed" ? t("now.step.state.failed") : t("now.step.state.done")}</span></span>
      <LineWords line={{ ...step, text: first }} />
    </button>
    {open && <div className="mt-1 mb-2 ml-4 flex min-w-0 flex-col gap-1">
      <StepText data-run-step-input text={step.input.text} cut={step.input.cut} tone="text-ink" />
      {step.output && <StepText data-run-step-output text={step.output.text} cut={step.output.cut} tone={step.state === "failed" ? "text-error" : "text-soft"} />}
    </div>}
  </li>;
}
const PAGE = 12;
const NOTE = "py-0.5 text-muted narrow:py-1.5";
/**
 * Every step of a Run so far, oldest first, one line each, each opening to what it ran and what came back. It starts at
 * the latest `PAGE`; steps that come after are added under them, so what is being read stays where it is, and a press
 * at the top shows the ones before, back to the first the read holds.
 */
export function StepList({ steps, className }: { steps: StepsRead; className?: string }) {
  const { t } = useTranslation("people");
  const { read } = steps;
  // Counted from the Run's first step, so the list's top stays put while steps are added at its foot.
  const total = read ? read.steps.length + read.older : 0;
  const [from, setFrom] = useState<number | null>(null);
  if (!read) return steps.failed ? <Message tone="error" size="line" title={t("now.step.unreadable")} className={cn("text-xs", NOTE, className)} /> : null;
  if (!read.steps.length) return <Message tone="empty" size="line" quiet title={t("now.step.none")} className={cn("text-xs", NOTE, className)} />;
  const start = Math.max(read.older, from ?? total - PAGE);
  if (from === null) setFrom(start);
  const shown = read.steps.slice(start - read.older);
  return <ol data-run-steps="open" className={cn("m-0 flex list-none flex-col p-0 text-xs", className)}>
    {start > read.older ? <li><button type="button" data-run-steps-more onClick={() => setFrom(Math.max(read.older, start - PAGE * 2))}
      className={cn("cursor-pointer rounded-sm underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-ring", NOTE)}>
      {t("now.step.older", { count: start - read.older })}</button></li>
      : (read.older > 0 || read.unread) && <li className={NOTE}>{t("now.step.notShown")}</li>}
    {shown.map(step => <StepRow key={step.id} step={step} />)}</ol>;
}
