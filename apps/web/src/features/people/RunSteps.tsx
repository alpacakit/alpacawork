import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type RunStep, type RunStepDetail, type RunStepEntry, type RunStepsPage, type RunStepText } from "@alpacawork/contract/run";
import { readRunStep, readRunSteps } from "@/data/run-steps";
import { ApiError } from "@/data/client";
import { Message } from "@/components/ui/message";
import { cn } from "@/lib/utils";

/* Hallmark · component: an agent's work line and its steps · genre: modern-minimal · theme: the app's own tokens (ink,
 * soft, muted, error, working, line) · states: folded (one line: the moving mark, the tool and what it runs) · open
 * (every step so far, one line each) · a step opened (what it ran and what came back, in full) · a step done (✓),
 * failed (red ✗) or of an unknown outcome (?) · reading · not readable · reduced motion (the mark's three dots stand still) */

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

/**
 * A Run's steps as far as they are listed: from step `from` (counted from the Run's first, 0) to the latest, of
 * `total`, of the index's `generation`, every change up to its `version` taken in. `known` is every step it has been
 * told of, those before where it starts too, so a page of earlier steps read before a change cannot undo it.
 */
export type ListedSteps = { from: number; total: number; version: number; generation: number; steps: readonly RunStepEntry[];
  known: ReadonlyMap<number, RunStepEntry> };
/** `again`: read the list anew from the Run's latest steps, as when an answer is of a newer generation than the list. */
export type StepsRead = { run?: string; listed: ListedSteps | null; failed: boolean; earlier: () => void; again: () => void };
/** How many steps a Run has taken, as far as they were read. */
export const stepCount = (read: StepsRead) => read.listed?.total;
/** The steps a list starts with, and how many more a press on "earlier" adds. */
const FIRST = 12, EARLIER = 24;
type Answer = Pick<RunStepsPage, "steps" | "total" | "generation">;
/**
 * The one way a list takes in an answer, whichever read it came from and in whatever order answers arrive: each step
 * keeps the newer of what it holds and what came (by the version it changed at), so an older answer never undoes a newer
 * one. The list shows from `from` (where it was gone back to; a page of earlier steps moves it up), new steps go at its
 * foot. Only a read of every change since the list's version (`caughtUp`) moves its version. An answer of another
 * generation (the output was replaced) is not this list's: null, to read the list again.
 */
export function takeIn(listed: ListedSteps | null, answer: Answer, at: { from?: number; caughtUp?: number } = {}): ListedSteps | null {
  if (listed && answer.generation !== listed.generation) return null;
  const from = Math.max(0, at.from ?? listed?.from ?? answer.steps[0]?.n ?? answer.total);
  const known = new Map(listed?.known);
  for (const step of answer.steps) {
    const before = known.get(step.n);
    if (!before || before.changed <= step.changed) known.set(step.n, step);
  }
  const steps: RunStepEntry[] = [];
  for (let n = from; known.has(n); n++) steps.push(known.get(n)!);
  return { from, steps, known, generation: answer.generation, total: Math.max(answer.total, listed?.total ?? 0, from + steps.length),
    version: at.caughtUp ?? listed?.version ?? 0 };
}
/** Every step that changed after `version`, a page at a time until the answer is the latest. */
async function readChanges(run: string, version: number, signal: AbortSignal): Promise<Answer & { version: number }> {
  const steps: RunStepEntry[] = [];
  for (let since = version; ;) {
    const page = await readRunSteps(run, { since }, signal);
    steps.push(...page.steps);
    since = page.version;
    if (page.complete) return { steps, total: page.total, generation: page.generation, version: page.version };
  }
}
/**
 * The steps of Run `run`, read while `shown`: the latest few first, and earlier ones a page at a time on `earlier`.
 * Whenever `signal` changes (a step of the Run started or ended, any of them), only what changed since the list's
 * version is read and taken in, so how far it was gone back and the steps opened in it stay as they are. Every answer
 * is taken in one way (takeIn). Nothing is read while they are not shown.
 */
export function useRunSteps(run: string | undefined, shown: boolean, signal: string | number = ""): StepsRead {
  const [state, setState] = useState<{ run?: string; listed: ListedSteps | null; failed: boolean }>({ listed: null, failed: false });
  const current = useRef(state);
  current.current = state;
  const live = shown && !!run && state.run === run;
  // A list of a replaced output is read again from its latest steps.
  const [restart, setRestart] = useState(0);
  const take = useCallback((answer: Answer, at?: Parameters<typeof takeIn>[2]) => {
    const previous = current.current;
    if (previous.run !== run || !previous.listed) return;
    const listed = takeIn(previous.listed, answer, at);
    if (!listed) { setRestart(count => count + 1); return; }
    // Held at once, so an answer taken in right after builds on this one.
    current.current = { run, failed: false, listed };
    setState(current.current);
  }, [run]);
  // The signal the list is up to date with: a first read is, so only a later change reads what changed.
  const told = useRef(signal);
  useEffect(() => {
    told.current = signal;
    if (!run || !shown) { setState({ listed: null, failed: false }); return; }
    const abort = new AbortController();
    readRunSteps(run, { limit: FIRST }, abort.signal).then(page =>
      setState({ run, failed: false, listed: takeIn(null, page, { caughtUp: page.version }) }),
    () => { if (!abort.signal.aborted) setState({ run, listed: null, failed: true }); });
    return () => abort.abort();
  }, [run, shown, restart]);
  // Read again by what changed since the version held; a read under way finishes first, then the next takes its version.
  const reading = useRef<Promise<unknown>>(Promise.resolve());
  const loaded = live && !!state.listed;
  useEffect(() => {
    if (!run || !loaded || told.current === signal) return;
    told.current = signal;
    const abort = new AbortController();
    reading.current = reading.current.then(async () => {
      const held = current.current.listed;
      if (abort.signal.aborted || !held || current.current.run !== run) return;
      try {
        const changes = await readChanges(run, held.version, abort.signal);
        take(changes, { caughtUp: changes.version });
      } catch { if (!abort.signal.aborted) setState(previous => ({ ...previous, failed: true })); }
    });
    return () => abort.abort();
  }, [run, loaded, signal, take]);
  const earlier = useCallback(() => {
    const listed = current.current.listed;
    if (!run || !listed || listed.from === 0) return;
    const from = Math.max(0, listed.from - EARLIER);
    readRunSteps(run, { from, limit: listed.from - from }).then(page => take(page, { from }),
      () => setState(previous => ({ ...previous, failed: true })));
  }, [run, take]);
  const again = useCallback(() => setRestart(count => count + 1), []);
  return live ? { ...state, earlier, again } : { listed: null, failed: false, earlier, again };
}

const BLOCK = "m-0 max-h-64 overflow-auto rounded-sm border border-line bg-bg p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]";
/** What a step ran or got back, as written, saying how much was left out past the limit. */
function StepText({ text, tone, ...data }: { text: RunStepText; tone: string; "data-run-step-input"?: true; "data-run-step-output"?: true }) {
  const { t } = useTranslation("people");
  return <pre dir="auto" {...data} className={cn(BLOCK, tone)}>{text.text}
    {text.omitted > 0 && <span className="block font-sans text-muted">{t("now.step.omitted", { count: text.omitted })}</span>}</pre>;
}
/**
 * What one step ran and got back, read when it is opened and again when it changes. It is shown only when it is of
 * the list's generation and not older than the step as the list holds it, so the opened text is always that line's.
 * Of a newer generation, or not found (the output it was read from is no longer there), the list is read anew
 * (`again`), and this step is read again once the list holds it.
 */
function useStepDetail(run: string, step: RunStepEntry, generation: number, open: boolean, again: () => void) {
  const [detail, setDetail] = useState<{ value: RunStepDetail | null; failed: boolean } | null>(null);
  const { n, changed } = step;
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    readRunStep(run, n, abort.signal).then(value => {
      if (value.generation > generation) again();
      setDetail({ value, failed: false });
    }, error => {
      if (abort.signal.aborted) return;
      if (error instanceof ApiError && error.code === "not_found") { again(); setDetail(null); return; }
      setDetail({ value: null, failed: true });
    });
    return () => abort.abort();
  }, [run, n, changed, open, generation, again]);
  if (!open || !detail) return null;
  return detail.value && (detail.value.generation !== generation || detail.value.changed < changed) ? null : detail;
}
/** One step of the list: its line, and on a press what it ran and what came back, in full. */
function StepRow({ run, step, generation, open, toggle, again }: { run: string; step: RunStepEntry; generation: number; open: boolean;
  toggle: () => void; again: () => void }) {
  const { t } = useTranslation("people");
  const detail = useStepDetail(run, step, generation, open, again);
  return <li data-run-step={step.state} className="min-w-0">
    <button type="button" aria-expanded={open} onClick={toggle}
      className="flex w-full min-w-0 cursor-pointer items-baseline gap-1.5 rounded-sm py-0.5 text-left text-soft outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-ring narrow:py-1.5">
      <span data-run-step-mark className={cn("w-2.5 flex-none text-center font-sans", step.state === "failed" ? "text-error" : step.state === "running" ? "text-working motion-safe:animate-pulse" : "text-muted")}>
        <span aria-hidden>{step.state === "running" ? "●" : step.state === "failed" ? "✗" : step.state === "unknown" ? "?" : "✓"}</span>
        <span className="sr-only">{step.state === "running" ? t("now.step.state.running") : step.state === "failed" ? t("now.step.state.failed")
          : step.state === "unknown" ? t("now.step.state.unknown") : t("now.step.state.done")}</span></span>
      <LineWords line={step} />
    </button>
    {open && <div className="mt-1 mb-2 ml-4 flex min-w-0 flex-col gap-1">
      {detail?.value ? <>
        <StepText data-run-step-input text={detail.value.input} tone="text-ink" />
        {detail.value.output && <StepText data-run-step-output text={detail.value.output} tone={step.state === "failed" ? "text-error" : "text-soft"} />}
        {step.state === "unknown" && <Message tone="caution" size="line" quiet title={t("now.step.unknown")} className="text-xs" />}</>
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
  // The steps opened, by their place in the Run (`n`, one per step whatever its tool call's ID) and the step there. A
  // list read anew keeps open those whose place still holds the same step; the rest are closed.
  const [opened, setOpened] = useState<ReadonlyMap<number, string>>(new Map());
  const held = listed?.steps;
  useEffect(() => {
    if (!held) return;
    const at = new Map(held.map(step => [step.n, step.id]));
    setOpened(previous => [...previous].every(([n, id]) => at.get(n) === id) ? previous
      : new Map([...previous].filter(([n, id]) => at.get(n) === id)));
  }, [listed?.generation]); // eslint-disable-line react-hooks/exhaustive-deps -- pruned only when a list is read anew
  if (!listed || !run) return steps.failed ? <Message tone="error" size="line" title={t("now.step.unreadable")} className={cn("text-xs", NOTE, className)} /> : null;
  if (!listed.steps.length) return <Message tone="empty" size="line" quiet title={t("now.step.none")} className={cn("text-xs", NOTE, className)} />;
  const toggle = (step: RunStepEntry) => setOpened(previous => {
    const next = new Map(previous);
    if (!next.delete(step.n)) next.set(step.n, step.id);
    return next;
  });
  return <ol data-run-steps="open" className={cn("m-0 flex list-none flex-col p-0 text-xs", className)}>
    {listed.from > 0 && <li><button type="button" data-run-steps-more onClick={steps.earlier}
      className={cn("cursor-pointer rounded-sm underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-ring", NOTE)}>
      {t("now.step.older", { count: Math.min(EARLIER, listed.from), rest: listed.from })}</button></li>}
    {steps.failed && <li><Message tone="error" size="line" title={t("now.step.unreadable")} className={cn("text-xs", NOTE)} /></li>}
    {listed.steps.map(step => <StepRow key={`${listed.generation}:${step.n}`} run={run} step={step} generation={listed.generation}
      open={opened.get(step.n) === step.id} toggle={() => toggle(step)} again={steps.again} />)}</ol>;
}
