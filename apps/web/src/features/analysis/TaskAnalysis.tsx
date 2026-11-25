import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/data/client";
import { cn } from "@/lib/utils";
import { useUnitValues } from "./data";
import { duration, format, instant, tokenColumn } from "./format";
import { ModelName, PointerTip, ReadPart, Square, tip } from "./parts";
import type { UnitValues } from "./contract";

const OUTCOME = { passed: "bg-done", reworked: "bg-reworked", stopped: "bg-stopped" } as const;

/** One task: its time drawn as the list draws time (the AI at work, your turn, paused), what you sent as marks, then its values, only those that are not zero. */
export function TaskAnalysis({ taskId, title = false }: { taskId: string; title?: boolean }) {
  const { t } = useTranslation("analysis");
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const query = useUnitValues(taskId);
  const values = query.data;
  const row = values?.unit;
  // Its own title only where the reader has none to show yet (the task still looked up), or the values are another's.
  const heading = (title || row && row.id !== taskId) && row && <h3 dir="auto" className="mb-1 text-heading font-semibold">
    {row.id !== taskId && <span className="me-2 text-muted">{row.id}</span>}{row.title}
  </h3>;
  if (query.error instanceof ApiError && query.error.code === "not_found") return <>{heading}<p className="text-muted">{t("values.empty")}</p></>;
  if (!values || !row) return <>{heading}<ReadPart set={{ data: null, current: false, reads: [query] }}
    skeleton={<RegionSkeleton shape="analysisTask" />}>{() => null}</ReadPart></>;
  const you = values.time.review + values.time.answer;
  const lead = row.outcome && row.outcome !== "stopped" && row.finishedAt ? Date.parse(row.finishedAt) - Date.parse(row.requestedAt) : null;
  const usage = values.usage;
  // The models' output in one step, the largest's (one column reads alike).
  const output = tokenColumn(values.models.map(model => model.output));
  // What took a task out of "no fixes" (more than one review, a send-back, an instruction in review or after acceptance)
  // is drawn in the colour of "needed fixes" where the task needed them, so the reason reads from the values alone.
  const reworked = row.outcome === "reworked";
  const facts = ([[t("until.submits"), values.submits, values.submits > 1], [t("values.sendBacks"), values.sendBacks, true],
    [t("values.atReview"), values.instructionsAtReview, true], [t("values.afterAccept"), values.instructionsAfterAccept, true],
    [t("values.duringWork"), values.instructionsDuringWork, false], [t("until.questions"), values.questions, false],
    [t("values.answers"), values.answers, false]] as [string, number, boolean][]).filter(([, n]) => n)
    .map(([name, n, why]) => ({ name, value: format(name === t("until.questions") ? "questions" : "times", n), why: reworked && why }));
  const used = ([
    [t("usage.launches"), usage.launches && format("times", usage.launches)],
    [t("usage.runMs"), usage.runMs && duration(usage.runMs)],
    [t("values.conversations"), usage.newConversations && format("conversations", usage.newConversations)],
    [t("values.workers"), values.workers && format("people", values.workers)],
    [t("values.children"), values.children && format("tasks", values.children)],
    [t("usage.output"), usage.tokens.output && format("tokens", usage.tokens.output)],
    [t("values.inputCache"), usage.tokens.input + usage.tokens.cache && format("tokens", usage.tokens.input + usage.tokens.cache)],
  ] as [string, string | 0][]).filter(([, text]) => text) as [string, string][];
  return <div ref={setRoot} data-task-analysis className="pb-6">
    <PointerTip root={root} />
    {heading}
    <p className="mt-2 inline-flex items-center text-muted">
      <Square className={row.outcome ? OUTCOME[row.outcome] : "bg-rule"} />{t(`outcome.${row.outcome ?? "none"}`)}{lead !== null && <span className="ms-3">{duration(lead)}</span>}
    </p>
    <Band values={values} />
    <Facts className="mt-4" items={[
      ...you > 0 ? [{ color: "bg-turn", name: t("time.you"), value: duration(you) }] : [],
      ...values.time.ai > 0 ? [{ color: "bg-working", name: t("time.ai"), value: duration(values.time.ai) }] : [],
      ...values.time.other >= 60_000 ? [{ color: "bg-rest", name: t("time.other"), value: duration(values.time.other) }] : [],
      ...facts]} />
    {used.length > 0 && <>
      <h4 className="mt-8 mb-3 text-xs font-normal text-soft">{t("values.usage")}</h4>
      <Facts items={used.map(([name, value]) => ({ name, value }))} />
    </>}
    {values.models.length > 0 && <table className="mt-2.5 w-full border-collapse">
      <thead><tr className="h-9 border-b border-rule text-xs text-soft">
        <th className="text-start font-normal">{t("values.models")}</th><th className="ps-3 text-end font-normal">{t("usage.launches")}</th>
        <th className="ps-3 text-end font-normal">{t("usage.runMs")}</th><th className="ps-3 text-end font-normal">{output.unit ? t("table.head", { name: t("usage.output"), unit: output.unit }) : t("usage.output")}</th></tr></thead>
      <tbody>{values.models.map(model => <tr key={model.key} className="h-10 border-b border-rule">
        <td><ModelName model={model.model} /></td><td className="ps-3 text-end">{format("times", model.launches)}</td>
        <td className="ps-3 text-end">{duration(model.runMs)}</td><td className="ps-3 text-end tabular-nums">{output.write(model.output)}</td></tr>)}</tbody>
    </table>}
    {values.prs.length > 0 && <>
      <h4 className="mt-8 mb-3 text-xs font-normal text-soft">{t("until.prs")}</h4>
      <p className="flex flex-wrap gap-x-4.5 gap-y-1">{values.prs.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">#{url.split("/").pop()}</a>)}</p>
    </>}
    {values.skills.length > 0 && <>
      <h4 className="mt-8 mb-3 text-xs font-normal text-soft">{t("values.skills")}</h4>
      <p className="flex flex-wrap gap-x-4.5 gap-y-1 text-muted">{values.skills.map(skill => <span key={skill}>{skill}</span>)}</p>
    </>}
    {values.tools.length > 0 && <>
      <h4 className="mt-8 mb-3 text-xs font-normal text-soft">{t("values.tools")}</h4>
      <p className="flex flex-wrap gap-x-4.5 gap-y-1 text-muted">{values.tools.slice(0, 8).map(tool =>
        <span key={tool.name}>{tool.name}<b className="ms-1.5 font-semibold text-ink">{format("times", tool.calls)}</b></span>)}</p>
    </>}
  </div>;
}

/**
 * A task's values as the lead numbers are drawn: each its name over its value (with its colour where the chart has one),
 * four to a line on one grid, so a name never parts from its value at a line's end.
 */
function Facts({ items, className }: { items: { name: string; value: string; color?: string; why?: boolean }[]; className?: string }) {
  if (!items.length) return null;
  return <dl className={cn("grid grid-cols-4 gap-x-4 gap-y-4 narrow:grid-cols-3", className)}>
    {items.map(item => <div key={item.name} className="min-w-0">
      <dt className="flex items-center text-xs text-muted">{item.color && <Square className={item.color} />}{item.name}</dt>
      <dd className={cn("text-base font-semibold tabular-nums", item.why && "text-turn")}>{item.value}</dd>
    </div>)}
  </dl>;
}

const BAND = { doing: "bg-working", yours: "bg-turn", paused: "bg-rest" } as const;
/** The task's own time from its request to its end (or now): its pieces, with what you sent marked above. */
function Band({ values }: { values: UnitValues }) {
  const { t } = useTranslation("analysis");
  const zone = values.head.timeZone, row = values.unit;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const self = box.current;
    if (!self) return;
    const measure = () => setWidth(self.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(self);
    return () => watch.disconnect();
  }, []);
  if (!values.band.length) return null;
  const start = Date.parse(values.band[0]!.from), end = Date.parse(values.band[values.band.length - 1]!.to), span = Math.max(1, end - start);
  const ending = row.outcome === "stopped" && row.finishedAt ? t("values.stopped", { at: instant(row.finishedAt, zone) })
    : row.outcome && row.finishedAt ? t("values.accepted", { at: instant(row.finishedAt, zone) }) : t("outcome.none");
  const left = (at: string) => Math.min(100, (Date.parse(at) - start) / span * 100);
  const groups = markGroups(values.marks.map(mark => left(mark.at)), width);
  return <div className="relative mt-5 pt-3">
    <div ref={box} className="absolute inset-x-0 top-0 h-2.5">
      {values.marks.map((mark, at) => <i key={at} aria-hidden style={{ left: `${left(mark.at)}%` }} className="absolute bottom-0 -ms-px h-2 w-0.5 rounded-[1px] bg-turn" />)}
      {/* Marks a finger's width apart are one place to press or point at, and say each of theirs, in order. */}
      {groups.map(group => <em key={group[0]} data-tip-tap="" style={{ left: `${left(values.marks[group[0]!]!.at)}%`,
        width: `${left(values.marks[group[group.length - 1]!]!.at) - left(values.marks[group[0]!]!.at)}%` }}
        className="absolute inset-y-0 -ms-1.5 box-content px-1.5"
        {...tip(group.map(at => `${t(`values.marks.${values.marks[at]!.kind}`)} ${instant(values.marks[at]!.at, zone)}`).join("\n"))} />)}
    </div>
    <div className="flex h-2 gap-px">
      {values.band.map((piece, at) => {
        const width = Date.parse(piece.to) - Date.parse(piece.from);
        return width > 0 && <i key={at} style={{ flex: width }} className={cn("block min-w-px rounded-[1.5px]", BAND[piece.kind])} data-tip-tap=""
          {...tip(`${t(`values.band.${piece.kind}`)} ${duration(width)}${t("sep")}${t("range", { from: instant(piece.from, zone), to: instant(piece.to, zone) })}`)} />;
      })}
    </div>
    <div className="mt-1.5 flex justify-between gap-3 text-xs text-soft"><span>{instant(row.requestedAt, zone)}</span><span>{ending}</span></div>
  </div>;
}

/** Marks (their places in percent of a band `width` pixels wide) gathered where each is within a finger's reach of the one before. */
export function markGroups(lefts: number[], width: number, reach = 12): number[][] {
  const groups: number[][] = [];
  lefts.forEach((left, at) => {
    const group = groups[groups.length - 1];
    if (group && (left - lefts[group[group.length - 1]!]!) / 100 * width < reach) group.push(at); else groups.push([at]);
  });
  return groups;
}
