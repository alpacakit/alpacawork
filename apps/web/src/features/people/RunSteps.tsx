import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RUN_STEPS_PAGE_LIMIT, type RunStep, type RunStepDetail, type RunStepEntry, type RunStepText } from "@alpacawork/contract/run";
import { readRunStep, readRunSteps } from "@/data/run-steps";
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
  return <div data-work-line {...data} className={cn("flex min-w-0 items-baseline gap-1.5 text-soft", className)}>
    <WorkMark />
    {label !== undefined ? <span className="min-w-0 flex-1 truncate">{label}</span>
      : step ? <LineWords line={step} /> : <span className="min-w-0 flex-1 truncate">{idle}</span>}
    {end}
  </div>;
}

/** A Run's steps as far as they are listed: from step `from` (counted from the Run's first, 0) to the latest, of `total`. */
export type ListedSteps = { from: number; total: number; steps: readonly RunStepEntry[] };
export type StepsRead = { run?: string; listed: ListedSteps | null; failed: boolean; earlier: () => void };
/** How many steps a Run has taken, as far as they were read. */
export const stepCount = (read: StepsRead) => read.listed?.total;
/** The steps a list starts with, and how many more a press on "earlier" adds. */
const FIRST = 12, EARLIER = 24;
/** Every step from `from` to the latest, a page at a time. */
async function readFrom(run: string, from: number, signal: AbortSignal): Promise<ListedSteps> {
  const steps: RunStepEntry[] = [];
  for (let at = from; ;) {
    const page = await readRunSteps(run, { from: at, limit: RUN_STEPS_PAGE_LIMIT }, signal);
    steps.push(...page.steps);
    at += page.steps.length;
    if (!page.steps.length || at >= page.total) return { from, total: page.total, steps };
  }
}
/**
 * The steps of Run `run`, read while `shown`: the latest few first, earlier ones a page at a time on `earlier`, and those
 * listed read again whenever `version` changes (any step the screen was told of started or ended). Nothing is read
 * while they are not shown.
 */
export function useRunSteps(run: string | undefined, shown: boolean, version = ""): StepsRead {
  const [state, setState] = useState<{ run?: string; listed: ListedSteps | null; failed: boolean }>({ listed: null, failed: false });
  // Where the list starts, kept apart so a read again starts there whatever came back last.
  const start = useRef<{ run: string; from: number } | null>(null);
  const live = shown && state.run === run;
  useEffect(() => {
    if (!run || !shown) { start.current = null; return; }
    const abort = new AbortController();
    const from = start.current?.run === run ? start.current.from : null;
    const read = from === null
      ? readRunSteps(run, { limit: FIRST }, abort.signal).then(page => ({ from: page.from, total: page.total, steps: page.steps }))
      : readFrom(run, from, abort.signal);
    read.then(listed => { start.current = { run, from: listed.from }; setState({ run, listed, failed: false }); },
      () => { if (!abort.signal.aborted) setState(previous => ({ ...previous, run, failed: true })); });
    return () => abort.abort();
  }, [run, shown, version]);
  const earlier = useCallback(() => {
    const listed = state.listed;
    if (!run || !listed || listed.from === 0) return;
    const from = Math.max(0, listed.from - EARLIER);
    readRunSteps(run, { from, limit: listed.from - from }).then(page => {
      setState(previous => previous.run !== run || previous.listed?.from !== listed.from ? previous
        : { run, failed: false, listed: { from, total: Math.max(page.total, listed.total), steps: [...page.steps, ...listed.steps] } });
      start.current = { run, from };
    }, () => setState(previous => ({ ...previous, failed: true })));
  }, [run, state.listed]);
  return live ? { ...state, earlier } : { listed: null, failed: false, earlier };
}

const BLOCK = "m-0 max-h-64 overflow-auto rounded-sm border border-line bg-bg p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]";
/** What a step ran or got back, as written, saying how much was left out past the limit. */
function StepText({ text, tone, ...data }: { text: RunStepText; tone: string; "data-run-step-input"?: true; "data-run-step-output"?: true }) {
  const { t } = useTranslation("people");
  return <pre dir="auto" {...data} className={cn(BLOCK, tone)}>{text.text}
    {text.omitted > 0 && <span className="block font-sans text-muted">{t("now.step.omitted", { count: text.omitted })}</span>}</pre>;
}
/** What one step ran and got back, read when it is opened and again when its state changes. */
function useStepDetail(run: string, n: number, open: boolean, state: string) {
  const [detail, setDetail] = useState<{ key: string; value: RunStepDetail | null; failed: boolean } | null>(null);
  const key = `${run}:${n}:${state}`;
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    readRunStep(run, n, abort.signal).then(value => setDetail({ key, value, failed: false }),
      () => { if (!abort.signal.aborted) setDetail({ key, value: null, failed: true }); });
    return () => abort.abort();
  }, [run, n, open, key]);
  // While a changed step is read again, what was read before stays in place.
  return open ? detail : null;
}
/** One step of the list: its line, and on a press what it ran and what came back, in full. */
function StepRow({ run, step }: { run: string; step: RunStepEntry }) {
  const { t } = useTranslation("people");
  const [open, setOpen] = useState(false);
  const detail = useStepDetail(run, step.n, open, step.state);
  return <li data-run-step={step.state} className="min-w-0">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
      className="flex w-full min-w-0 cursor-pointer items-baseline gap-1.5 rounded-sm py-0.5 text-left text-soft outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-ring narrow:py-1.5">
      <span data-run-step-mark className={cn("w-2.5 flex-none text-center font-sans", step.state === "failed" ? "text-error" : step.state === "running" ? "text-working motion-safe:animate-pulse" : "text-muted")}>
        <span aria-hidden>{step.state === "running" ? "●" : step.state === "failed" ? "✗" : "✓"}</span>
        <span className="sr-only">{step.state === "running" ? t("now.step.state.running") : step.state === "failed" ? t("now.step.state.failed") : t("now.step.state.done")}</span></span>
      <LineWords line={step} />
    </button>
    {open && <div className="mt-1 mb-2 ml-4 flex min-w-0 flex-col gap-1">
      {detail?.value ? <>
        <StepText data-run-step-input text={detail.value.input} tone="text-ink" />
        {detail.value.output && <StepText data-run-step-output text={detail.value.output} tone={step.state === "failed" ? "text-error" : "text-soft"} />}</>
        : detail?.failed ? <Message tone="error" size="line" title={t("now.step.unreadableOne")} className="text-xs" />
        : <span className="text-muted">{t("now.step.reading")}</span>}
    </div>}
  </li>;
}
const NOTE = "py-0.5 text-muted narrow:py-1.5";
/**
 * A Run's steps, oldest first, one line each, each opening to what it ran and what came back. It starts at the latest
 * few; steps that come after are added under them, so what is being read stays where it is, and a press at the top
 * reads the ones before, a page at a time, back to the Run's first.
 */
export function StepList({ steps, className }: { steps: StepsRead; className?: string }) {
  const { t } = useTranslation("people");
  const { listed, run } = steps;
  if (!listed || !run) return steps.failed ? <Message tone="error" size="line" title={t("now.step.unreadable")} className={cn("text-xs", NOTE, className)} /> : null;
  if (!listed.steps.length) return <Message tone="empty" size="line" quiet title={t("now.step.none")} className={cn("text-xs", NOTE, className)} />;
  return <ol data-run-steps="open" className={cn("m-0 flex list-none flex-col p-0 text-xs", className)}>
    {listed.from > 0 && <li><button type="button" data-run-steps-more onClick={steps.earlier}
      className={cn("cursor-pointer rounded-sm underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-ring", NOTE)}>
      {t("now.step.older", { count: Math.min(EARLIER, listed.from), rest: listed.from })}</button></li>}
    {steps.failed && <li><Message tone="error" size="line" title={t("now.step.unreadable")} className={cn("text-xs", NOTE)} /></li>}
    {listed.steps.map(step => <StepRow key={step.n} run={run} step={step} />)}</ol>;
}
