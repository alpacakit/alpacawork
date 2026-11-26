import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { useAt, useTrace } from "./data";
import { duration, instant, share } from "./format";
import { Square, tip } from "./parts";
import { PART_COLOR, SPAN_LOOKS } from "./timeline-kinds";
import type { AtView, Finding, TraceMark, TraceSpan, TraceView } from "./contract";

type Window = { from: number; to: number };
const MINUTE = 60_000, HOUR = 60 * MINUTE;
/** A window short enough to draw each step of the Runs in it (a longer one shows the Runs only). */
const STEPS_WITHIN = 4 * HOUR;
/** The least a window shows, whatever it is zoomed to. */
const LEAST = 5 * MINUTE;

/** The window around a finding: its own time, with a fifth of it (and at least a few minutes) on each side. */
export function windowAround(at: number, length: number, whole: Window): Window {
  at = Math.min(Math.max(at, whole.from), whole.to);
  const pad = Math.max(length / 5, 5 * MINUTE), from = Math.max(whole.from, at - pad), to = Math.min(whole.to, at + length + pad);
  return to - from >= LEAST ? { from, to } : { from: Math.max(whole.from, at - LEAST / 2), to: Math.min(whole.to, at + LEAST / 2) };
}
/** The window zoomed in (`factor` < 1) or out around `at`, kept within the whole task. */
export function zoomed(window: Window, factor: number, at: number, whole: Window): Window {
  const length = Math.min(whole.to - whole.from, Math.max(LEAST, (window.to - window.from) * factor));
  const from = Math.min(Math.max(whole.from, at - (at - window.from) * length / (window.to - window.from)), whole.to - length);
  return { from, to: from + length };
}

/**
 * The task's timeline, entered from a finding: the wall time split into parts (the whole task), then the lanes (the task,
 * those under it, each placement that ran) over a window, with the instant shown as a line one can drag (a seek bar) or
 * step from event to event, and what was going on at that instant (`analysis at`). The scene is the URL's (`at`,
 * `finding`), the same address an AI is given.
 */
export function Timeline({ task, trace, findings }: { task: string; trace: TraceView; findings: Finding[] }) {
  const { t } = useTranslation("analysis");
  const zone = trace.head.timeZone;
  // The whole task, as the trace reads it: to now while it can change, else to the last thing that moved it.
  const whole = useMemo(() => ({ from: Date.parse(trace.head.from), to: Math.max(Date.parse(trace.head.to), Date.parse(trace.head.from) + LEAST) }),
    [trace.head.from, trace.head.to]);
  const scene = useViewStore(state => state.scene);
  const finding = findings.find(each => each.id === scene?.finding) ?? null;
  const [window, setWindow] = useState<Window>(whole);
  // A finding chosen (here, from the causes, or by the URL) brings its window; the whole task otherwise.
  useEffect(() => {
    setWindow(finding ? windowAround(Date.parse(finding.at), finding.durationMs, whole) : whole);
  }, [finding, whole]);
  const at = scene?.at ? Date.parse(scene.at) : null;
  const [dragging, setDragging] = useState<number | null>(null);
  const shownAt = dragging ?? at;
  const steps = window.to - window.from <= STEPS_WITHIN;
  const detail = useTrace(task, { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() }, true, steps);
  const shown = steps && detail.data && !detail.isPlaceholderData ? detail.data : trace;
  const setAt = (ms: number) => useViewStore.getState().setScene({ finding: scene?.finding ?? null, at: new Date(Math.round(ms)).toISOString() });
  // The events one steps between: every mark and the start of every span drawn (the steps too, where they are), in time order.
  const events = useMemo(() => [...new Set([...trace.marks, ...shown.marks].map(mark => Date.parse(mark.at))
    .concat([...trace.spans, ...shown.spans].map(span => Date.parse(span.from))))].sort((a, b) => a - b), [trace, shown]);
  const step = (direction: -1 | 1) => {
    const from = shownAt ?? (direction > 0 ? whole.from - 1 : whole.to + 1);
    const next = direction > 0 ? events.find(ms => ms > from) : [...events].reverse().find(ms => ms < from);
    if (next === undefined) return;
    setAt(next);
    if (next < window.from || next > window.to) setWindow(zoomed({ from: next - (window.to - window.from) / 2, to: next + (window.to - window.from) / 2 }, 1, next, whole));
  };
  const zoom = (factor: number) => setWindow(zoomed(window, factor, shownAt ?? (window.from + window.to) / 2, whole));
  return <section data-timeline className="mt-10 scroll-mt-4">
    <h3 className="mb-3 text-heading font-semibold">{t("timeline.title")}</h3>
    <Parts trace={trace} />
    {finding && <FindingSteps finding={finding} findings={findings} onAt={at === Date.parse(finding.at)} />}
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <b className="me-auto text-base font-semibold tabular-nums">{shownAt !== null ? instant(new Date(shownAt).toISOString(), zone) : t("timeline.pick")}
        {shownAt !== null && <span className="ms-2 text-xs font-normal text-soft">{t("timeline.since", { time: duration(shownAt - whole.from) })}</span>}</b>
      <span className="flex gap-2">
        <Button variant="outline" onClick={() => step(-1)}><Icon name="left" className="size-3.5" />{t("timeline.previous")}</Button>
        <Button variant="outline" onClick={() => step(1)}>{t("timeline.next")}<Icon name="right" className="size-3.5" /></Button>
      </span>
      <span className="flex gap-2">
        <Button variant="outline" aria-label={t("timeline.zoomOut")} title={t("timeline.zoomOut")} onClick={() => zoom(2)}>−</Button>
        <Button variant="outline" aria-label={t("timeline.zoomIn")} title={t("timeline.zoomIn")} onClick={() => zoom(0.5)}>+</Button>
        <Button variant="outline" onClick={() => setWindow(whole)}>{t("timeline.whole")}</Button>
      </span>
    </div>
    {at !== null && <Moment task={task} at={scene!.at!} />}
    <Lanes trace={shown} lanes={trace.lanes} window={window} findings={findings} at={shownAt} zone={zone}
      onDrag={ms => setDragging(ms)} onLetGo={ms => { setDragging(null); setAt(ms); }} />
    {!steps && <p className="mt-1 text-xs text-soft">{t("timeline.stepsHidden")}</p>}
    {steps && shown.cursor && <p className="mt-1 text-xs text-soft">{t("timeline.partial")}</p>}
    <Legend />
    {at !== null && <Situation task={task} at={scene!.at!} zone={zone} />}
  </section>;
}

/**
 * The finding the timeline was entered from, while its instant is the one shown, with the way to the finding before or
 * after it (in the causes' order), so the next place is a press away, not a scroll back to the list.
 */
function FindingSteps({ finding, findings, onAt }: { finding: Finding; findings: Finding[]; onAt: boolean }) {
  const { t } = useTranslation("analysis");
  const at = findings.indexOf(finding);
  const go = (to: Finding | undefined) => { if (to) useViewStore.getState().setScene({ finding: to.id, at: to.at }); };
  return <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
    <p className={cn("me-auto min-w-0 font-semibold", !onAt && "text-muted")}>
      <span className="me-2 text-xs font-normal text-soft">{at + 1}/{findings.length}</span>{t(`rule.${finding.rule}`)}
      <span className="ms-2 font-normal text-muted">{duration(finding.durationMs)}</span>
      {finding.line && <span dir="auto" className="block text-xs font-normal text-muted line-clamp-2">「{finding.line}」</span>}</p>
    <span className="flex gap-2">
      <Button variant="outline" disabled={at <= 0} onClick={() => go(findings[at - 1])}><Icon name="up" className="size-3.5" />{t("timeline.previousFinding")}</Button>
      <Button variant="outline" disabled={at >= findings.length - 1} onClick={() => go(findings[at + 1])}>{t("timeline.nextFinding")}<Icon name="down" className="size-3.5" /></Button>
    </span>
  </div>;
}

/** The instant shown in one line, over the lanes: its part of the wall time, the AIs running and the questions open. */
function Moment({ task, at }: { task: string; at: string }) {
  const { t } = useTranslation("analysis");
  const view = useAt(task, at).data;
  if (!view) return <p className="mt-3 h-5" />;
  return <p data-moment="" className="mt-3 flex flex-wrap items-center gap-x-3 text-xs text-muted">
    {view.part && <span className="inline-flex items-center"><Square className={PART_COLOR[view.part]} /><b className="font-semibold text-ink">{t(`part.${view.part}`)}</b></span>}
    <span>{t("timeline.runningCount", { count: view.runs.length })}</span>
    <span>{t("timeline.openCount", { count: view.questions.length })}</span>
  </p>;
}

/** What the lanes' colours are, by the kinds of span and mark drawn (SPAN_LOOKS, MARK_COLOR). */
function Legend() {
  const { t } = useTranslation("analysis");
  const items: [string, string, "bar" | "mark"][] = [["bg-working", t("span.run"), "bar"], ["bg-error", t("legend.failedRun"), "bar"],
    ["bg-turn", t("span.question"), "bar"], ["bg-new", t("span.queued"), "bar"], ["bg-ink/70", t("span.step"), "mark"],
    ["bg-turn", t("mark.instruction"), "mark"], ["bg-done", t("mark.answer"), "mark"], ["bg-reworked", t("mark.question-withdrawn"), "mark"]];
  return <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">{items.map(([color, name, shape]) =>
    <li key={name} className="inline-flex items-center">
      <i aria-hidden className={cn("me-1.5 inline-block rounded-[1px]", color, shape === "bar" ? "h-2 w-3" : "h-2.5 w-0.5")} />{name}</li>)}
    <li className="inline-flex items-center"><i aria-hidden className="me-1.5 inline-block h-1 w-3 rounded-[1px] bg-working" />{t("legend.state")}</li>
  </ul>;
}

/** The wall time of the task and those under it, split into parts that do not overlap, each with its time and share. */
function Parts({ trace }: { trace: TraceView }) {
  const { t } = useTranslation("analysis");
  const { wall, categories } = trace.breakdown;
  const parts = categories.filter(part => part.ms > 0);
  return <div>
    <p className="mb-1.5 text-xs text-muted">{t("timeline.parts", { time: duration(wall) })}</p>
    <div className="flex h-2.5 gap-px">{parts.map(part =>
      <i key={part.key} style={{ flex: part.ms }} className={cn("block min-w-px rounded-[1.5px]", PART_COLOR[part.key])} data-tip-tap=""
        {...tip(`${t(`part.${part.key}`)} ${duration(part.ms)}${t("sep")}${share(part.ms / Math.max(1, wall))}`)} />)}</div>
    <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs narrow:grid-cols-1">{parts.map(part =>
      <li key={part.key} className="flex items-center"><Square className={PART_COLOR[part.key]} /><span className="me-auto text-muted">{t(`part.${part.key}`)}</span>
        <b className="font-semibold tabular-nums">{duration(part.ms)}</b><span className="ms-2 w-9 text-end text-soft tabular-nums">{share(part.ms / Math.max(1, wall))}</span></li>)}</ul>
  </div>;
}

/** The step between round instants on the axis of a window: about five of them. */
const axisStep = (window: Window) => [MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR]
  .find(each => (window.to - window.from) / each <= 6) ?? 48 * HOUR;
/** A tick's words: the day for a step of a day or more; else the clock, with the day where the day changes (and first). */
function tickWords(ticks: number[], written: (at: number) => string, step: number, tick: number) {
  const at = ticks.indexOf(tick), [day, clock] = written(at).split(" ");
  if (step >= 24 * HOUR) return day;
  return at === 0 || written(at - 1).split(" ")[0] !== day ? `${day} ${clock}` : clock;
}
/** Round instants for the axis of a window: about five, on whole minutes, hours or days. */
function axisTicks(window: Window): number[] {
  const step = axisStep(window);
  const out: number[] = [];
  for (let at = Math.ceil(window.from / step) * step; at <= window.to; at += step) out.push(at);
  return out;
}

const MARK_COLOR: Partial<Record<TraceMark["kind"], string>> = { instruction: "bg-turn", answer: "bg-done", "question-withdrawn": "bg-reworked",
  report: "bg-ink/50", "command-stopped": "bg-error", change: "bg-changed" };

/**
 * The lanes over a window: each lane its name and its spans (by kind, SPAN_LOOKS) and marks; the findings numbered on the
 * axis; the instant shown as a line. Pressing or dragging anywhere on the lanes moves the instant, as a seek bar does.
 */
function Lanes({ trace, lanes, window, findings, at, zone, onDrag, onLetGo }: {
  trace: TraceView; lanes: TraceView["lanes"]; window: Window; findings: Finding[]; at: number | null; zone: string;
  onDrag: (ms: number) => void; onLetGo: (ms: number) => void;
}) {
  const { t } = useTranslation("analysis");
  const track = useRef<HTMLDivElement>(null);
  const length = window.to - window.from;
  const left = (ms: number) => (ms - window.from) / length * 100;
  const place = (from: number, to: number) => {
    const a = Math.max(from, window.from), b = Math.min(to, window.to);
    return b < a ? null : { left: `${left(a)}%`, width: `max(2px, ${(b - a) / length * 100}%)` };
  };
  const end = Date.parse(trace.head.to);
  const spansOf = useMemo(() => {
    const byLane = new Map<string, TraceSpan[]>();
    for (const span of trace.spans) byLane.set(span.lane, [...byLane.get(span.lane) ?? [], span]);
    return byLane;
  }, [trace.spans]);
  const marksOf = useMemo(() => {
    const byLane = new Map<string, TraceMark[]>();
    for (const mark of trace.marks) byLane.set(mark.lane, [...byLane.get(mark.lane) ?? [], mark]);
    return byLane;
  }, [trace.marks]);
  const depth = (lane: TraceView["lanes"][number]) => { let n = 0, up = lane.parent; while (up) { n++; up = lanes.find(each => each.id === up)?.parent ?? null; } return n; };
  const msAt = (event: { clientX: number }) => {
    const box = track.current!.getBoundingClientRect();
    return window.from + Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * length;
  };
  const press = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    onDrag(msAt(event));
  };
  const lit = at !== null && at >= window.from && at <= window.to;
  const ticks = axisTicks(window);
  const names = lanes.map(lane => <span key={lane.id} style={{ paddingInlineStart: `${depth(lane) * 0.5}rem` }}
    className="flex h-7 items-center text-[0.6875rem] leading-tight text-muted" title={lane.label}><span className="line-clamp-2">{lane.label}</span></span>);
  return <div className="mt-3 flex gap-x-2 text-xs">
    {/* The lanes' names, beside their tracks, under the axis's height. */}
    <div className="w-36 flex-none pt-9 narrow:w-20">{names}</div>
    <div ref={track} role="slider" tabIndex={0} aria-label={t("timeline.seek")} aria-valuemin={window.from} aria-valuemax={window.to}
      aria-valuenow={at ?? window.from} aria-valuetext={at !== null ? instant(new Date(at).toISOString(), zone) : undefined}
      onPointerDown={press} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onDrag(msAt(event)); }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onLetGo(msAt(event)); }}
      onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault();
        onLetGo(Math.min(window.to, Math.max(window.from, (at ?? window.from) + (event.key === "ArrowLeft" ? -1 : 1) * length / 50))); }}
      className="relative min-w-0 flex-1 cursor-col-resize touch-none rounded-xs focus-visible:outline-2 focus-visible:outline-ring">
      {/* The axis: round instants, and the findings by their numbers. */}
      <div className="relative h-9 border-b border-rule">
        {ticks.map(tick => <span key={tick} style={{ left: `${left(tick)}%` }} className="absolute bottom-0.5 -translate-x-1/2 whitespace-nowrap text-soft tabular-nums">
          {tickWords(ticks, at => instant(new Date(ticks[at]!).toISOString(), zone), axisStep(window), tick)}</span>)}
        {findings.map((finding, n) => { const ms = Date.parse(finding.at); return ms >= window.from && ms <= window.to &&
          <button key={finding.id} type="button" style={{ left: `${left(ms)}%` }} onPointerDown={event => event.stopPropagation()}
            onClick={() => useViewStore.getState().setScene({ finding: finding.id, at: finding.at })}
            className="absolute top-0 grid size-5.5 -translate-x-1/2 place-items-center rounded-full bg-turn text-[0.6875rem] font-semibold text-bg"
            {...tip(`${n + 1} ${t(`rule.${finding.rule}`)} ${duration(finding.durationMs)}`)}>{n + 1}</button>; })}
      </div>
      {lanes.map(lane => {
        const spans = spansOf.get(lane.id) ?? [], marks = marksOf.get(lane.id) ?? [];
        return <div key={lane.id} className="relative h-7 overflow-hidden border-b border-rule/60">
          {spans.map(span => { const box = place(Date.parse(span.from), span.to ? Date.parse(span.to) : end); if (!box) return null;
            const look = SPAN_LOOKS[span.kind];
            return <i key={span.id} style={look.band === "tick" ? { left: box.left } : box} data-tip-tap="" className={cn("absolute block rounded-[2px]", look.color(span),
              look.band === "full" ? "top-1.5 h-3.5" : look.band === "thin" ? "top-5.5 h-1" : "top-1 h-1.5 w-px")}
              {...tip(spanWords(span, t, zone))} />; })}
          {marks.map(mark => { const ms = Date.parse(mark.at); return ms >= window.from && ms <= window.to &&
            <i key={mark.id} style={{ left: `${left(ms)}%` }} data-tip-tap="" className={cn("absolute top-0 block h-1.5 w-0.5 -translate-x-1/2 rounded-[1px]", MARK_COLOR[mark.kind] ?? "bg-ink/40")}
              {...tip(markWords(mark, t, zone))} />; })}
        </div>;
      })}
      {lit && <i aria-hidden style={{ left: `${left(at!)}%` }} className="pointer-events-none absolute top-0 bottom-0 block w-0.5 -translate-x-1/2 bg-ink" />}
    </div>
  </div>;
}
type Say = (key: string, options?: Record<string, unknown>) => string;
function spanWords(span: TraceSpan, t: Say, zone: string) {
  const range = t("range", { from: instant(span.from, zone), to: span.to ? instant(span.to, zone) : t("timeline.now") });
  const what = span.kind === "run" ? `${span.run}${span.model ? ` ${span.model}` : ""}` : span.kind === "step" ? span.line
    : span.kind === "question" ? t(SPAN_LOOKS.question.name(span)) : t(`span.${span.kind}`, { state: span.kind === "task-state" ? t(`state.${span.state}`) : "" });
  const length = span.to ? `${t("sep")}${duration(Date.parse(span.to) - Date.parse(span.from))}` : "";
  return `${what}${length}${t("sep")}${range}`;
}
function markWords(mark: TraceMark, t: Say, zone: string) {
  const line = mark.kind === "instruction" ? mark.firstLine : mark.kind === "report" ? mark.title : null;
  return `${t(`mark.${mark.kind}`)} ${instant(mark.at, zone)}${line ? `\n${line}` : ""}`;
}

/** What was going on at the instant shown, as `analysis at` answers it: the tasks, the AIs running, open questions, the history so far. */
function Situation({ task, at, zone }: { task: string; at: string; zone: string }) {
  const { t } = useTranslation("analysis");
  const read = useAt(task, at);
  const view: AtView | undefined = read.data;
  if (!view) return <p className="mt-6 text-soft">{read.isError ? t("timeline.failed") : t("timeline.reading")}</p>;
  return <div className={cn("mt-6 grid grid-cols-2 gap-x-8 gap-y-5 narrow:grid-cols-1", read.isPlaceholderData && "opacity-60")}>
    <h4 className="col-span-full -mb-3 font-semibold">{t("timeline.situation")}<span className="ms-2 text-xs font-normal text-soft">{t("timeline.situationNote")}</span></h4>
    <div>
      <h5 className="mb-1 text-xs text-soft">{t("timeline.tasks")}</h5>
      <ul className="space-y-0.5">{view.tasks.map(item => <li key={item.task} className="flex items-baseline gap-2">
        <span className="text-muted">{item.task}</span><span dir="auto" className="min-w-0 flex-1 truncate">{item.title}</span>
        <span className="text-xs whitespace-nowrap text-muted">{t(`state.${item.state}`)}</span></li>)}</ul>
      <h5 className="mt-4 mb-1 text-xs text-soft">{t("timeline.runs")}</h5>
      {view.runs.length ? <ul className="space-y-1.5">{view.runs.map(run => <li key={run.run}>
        <p><span className="text-muted">{run.run}</span> {run.agent}{run.model ? ` ${run.model}` : ""}<span className="ms-1 text-xs text-soft">{t(`role.${run.role}`)}</span></p>
        {run.current.map(each => <p key={each.step} className="truncate font-mono text-xs text-muted">{each.line}</p>)}
        {!run.current.length && run.steps === "not-recorded" && <p className="text-xs text-soft">{t("timeline.noSteps")}</p>}
      </li>)}</ul> : <p className="text-soft">{t("timeline.noRuns")}</p>}
    </div>
    <div>
      <h5 className="mb-1 text-xs text-soft">{t("timeline.questions", { count: view.questions.length })}</h5>
      {view.questions.length ? <ul className="space-y-1">{view.questions.map(question => <li key={question.question}>
        <p dir="auto" className="font-semibold">{question.title ?? t("task.question", { task: question.task })}</p>
        <p className="text-xs text-soft">{question.askedTo === "user" ? t("timeline.toUser") : question.askedTo}{t("sep")}{t("timeline.openSince", { at: instant(question.since, zone) })}</p>
      </li>)}</ul> : <p className="text-soft">{t("timeline.noQuestions")}</p>}
      <h5 className="mt-4 mb-1 text-xs text-soft">{t("timeline.history")}</h5>
      <ul className="space-y-1">{view.history.filter(line => line.kind !== "request_labeled").map(line => <li key={line.log} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-xs">
        <span className="text-soft tabular-nums">{instant(line.at, zone)}</span><span dir="auto" className="line-clamp-2">{line.title ?? historyWords(line.kind, t)}</span></li>)}</ul>
    </div>
  </div>;
}

/** A history line with no title, named by its kind as the timeline's marks name it where one does. */
const HISTORY_KINDS: Record<string, string> = { question_withdrawn: "mark.question-withdrawn", answered: "mark.answer", request_accepted: "mark.instruction",
  review_sent_back: "mark.instruction", reported: "mark.report", moved: "mark.moved", body_updated: "mark.values-changed", linked: "history.linked",
  created: "history.created", asked: "span.question", review_approved: "history.accepted", responsible_changed: "mark.assigned", placement_changed: "mark.assigned" };
const historyWords = (kind: string, t: Say) => HISTORY_KINDS[kind] ? t(HISTORY_KINDS[kind]) : kind;
