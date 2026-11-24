import { useTranslation } from "react-i18next";
import type { RunStep } from "@alpacawork/contract/run";
import { cn } from "@/lib/utils";

/* Hallmark · component: an agent's steps (its own tool calls) · genre: modern-minimal · theme: the app's own tokens (ink,
 * soft, muted, error) · states: folded (the latest step on one line) · open (that step in full, the steps before it one
 * line each) · each step running (a pulsing dot), done (✓) or failed (a red ✗, with what came back) */

/** Codex names its items by their type; said as the tool names other agents give. Any other tool keeps its own name. */
const ITEM_NAMES: Record<string, string> = { command_execution: "Bash", file_change: "Edit", web_search: "WebSearch", mcp_tool_call: "MCP", collab_tool_call: "Agent" };
const toolName = (tool: string) => ITEM_NAMES[tool] ?? tool;
/** A file's name is at the end of its path: cut short, these lose their start. */
const atEnd = (step: RunStep) => step.kind === "file" || step.kind === "edit";
/** What came back says something of these alone (a command's output, what a search found); a read file's first line does not. */
const tellsResult = (step: RunStep) => step.state === "failed" || step.kind === "command" || step.kind === "search";

/** Going, done or failed, told by the mark's shape as well as its colour, and in words to a screen reader. */
function Mark({ state }: { state: RunStep["state"] }) {
  const { t } = useTranslation("people");
  return <span data-run-step-mark className={cn("w-3 flex-none text-center font-sans", state === "running" ? "motion-safe:animate-pulse" : state === "failed" ? "text-error" : "text-muted")}>
    <span aria-hidden>{state === "running" ? <span className="inline-block size-1.5 translate-y-[-1px] rounded-full bg-current" /> : state === "failed" ? "✗" : "✓"}</span>
    <span className="sr-only">{state === "running" ? t("now.step.state.running") : state === "failed" ? t("now.step.state.failed") : t("now.step.state.done")}</span></span>;
}
const tone = (step: RunStep) => step.state === "running" ? "text-ink" : "text-soft";
/** What was run or came back, on one line as written: its spaces kept, cut at the end. */
const ONE_LINE = "min-w-0 overflow-hidden text-ellipsis whitespace-pre font-mono";
/** A tool's name gives way before what it ran: it never takes more than this of the line. */
const TOOL = "max-w-[40%] flex-none truncate font-medium";
function Tool({ step }: { step: RunStep }) { return <span className={TOOL}>{toolName(step.tool)}</span>; }

/** One step on one line: the tool, the agent's own words for it when it gave them, then as much of what it ran as fits. */
function StepLine({ step }: { step: RunStep }) {
  return <div className={cn("flex min-w-0 items-baseline gap-1.5", tone(step))}>
    <Mark state={step.state} /><Tool step={step} />
    {step.about && <span dir="auto" className="max-w-[62%] flex-none truncate">{step.about}</span>}
    {atEnd(step)
      ? <span dir="rtl" className={cn(ONE_LINE, "text-left")}><bdi>{step.text}</bdi></span>
      : <span dir="auto" className={cn(ONE_LINE, step.about && "text-muted")}>{step.text}</span>}
  </div>;
}
/** What came back, on one line: its first line and how many follow. */
function StepResult({ step }: { step: RunStep }) {
  const { t } = useTranslation("people");
  if (!step.result || !tellsResult(step)) return null;
  return <div data-run-step-result className="col-start-2 flex min-w-0 items-baseline gap-1.5 text-muted">
    <span aria-hidden className="flex-none">⎿</span>
    <span dir="auto" className={ONE_LINE}>{step.result.text}</span>
    {step.result.more > 0 && <span className="flex-none">{t("now.step.moreLines", { count: step.result.more })}</span>}
  </div>;
}
/**
 * One step read in full: what it ran as written, its spaces kept (a long line wraps to three), the count of its further
 * lines always in sight under that, and what came back.
 */
function StepDetail({ step }: { step: RunStep }) {
  const { t } = useTranslation("people");
  const text = <div className="min-w-0"><div dir="auto" className="line-clamp-3 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{step.text}</div>
    {step.more > 0 && <div className="text-muted">{t("now.step.moreLines", { count: step.more })}</div>}</div>;
  return <div className={cn("grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-1.5", tone(step))}>
    <Mark state={step.state} />
    <div className="flex min-w-0 items-baseline gap-1.5"><Tool step={step} />
      {step.about ? <span dir="auto" className="min-w-0 [overflow-wrap:anywhere]">{step.about}</span> : <div className="min-w-0 flex-1">{text}</div>}</div>
    {step.about && <div className="col-start-2 min-w-0">{text}</div>}
    <StepResult step={step} />
  </div>;
}

/**
 * What an agent is doing, from its own tool calls. Folded, the latest step alone on one line, so the place it stands
 * in keeps its height while steps go by. Open, that step in full and the `trail` steps before it, one line each (a
 * failed one keeps what came back). `newestFirst` where the place reads downward into the past (History); a
 * conversation reads the other way.
 */
export function RunSteps({ steps, open, trail = 5, newestFirst, className }: { steps: readonly RunStep[]; open: boolean; trail?: number; newestFirst?: boolean; className?: string }) {
  const latest = steps.at(-1);
  if (!latest) return null;
  if (!open) return <div data-run-steps="folded" data-run-step={latest.state} className={cn("min-w-0 text-xs", className)}><StepLine step={latest} /></div>;
  const before = trail > 0 ? steps.slice(-(trail + 1), -1) : [];
  const rows = [...before.map(step => <li key={step.id} data-run-step={step.state} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-1.5">
    <div className="col-span-2 min-w-0"><StepLine step={step} /></div>{step.state === "failed" && <StepResult step={step} />}</li>),
    <li key={latest.id} data-run-step={latest.state} data-run-step-latest className="min-w-0"><StepDetail step={latest} /></li>];
  return <ol data-run-steps="open" className={cn("m-0 flex list-none flex-col gap-1 p-0 text-xs", className)}>{newestFirst ? rows.reverse() : rows}</ol>;
}
