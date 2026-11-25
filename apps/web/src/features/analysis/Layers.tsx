import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { ReadFailure } from "@/components/ui/loadable";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { useBreakdown, useUnitList, useUnitValues } from "./data";
import { duration, format, instant, spanLabel, tokenColumn } from "./format";
import { listColumn, listHeading, listTitle, showsDays, writeValue } from "./lists";
import { ModelName, PointerTip, ReadPart, rowName, Square, tip, useChoices } from "./parts";
import type { ListRow, UnitValues } from "./contract";
import type { AnalysisPlace, ListPlace, Span } from "./place";

export { CardPane } from "./ShareCard";

/** A task's outcome: its colour and its word. */
const OUTCOME = { passed: "bg-done", reworked: "bg-reworked", stopped: "bg-stopped" } as const;
const outcomeWord = (row: ListRow, say: (key: string) => string) => say(`outcome.${row.outcome ?? "none"}`);

/** The tasks of one number: how many, for which days, and each task with its own value for it, most first. */
export function ListPane({ place, project, days }: { place: AnalysisPlace; project: string | null; days: { from: string; to: string } | null }) {
  const { t } = useTranslation("analysis");
  const list = place.list!;
  const query = useUnitList(project, place.span, list);
  const row = useRowOf(project, place.span, list);
  const pages = query.data?.pages ?? [];
  const first = pages[0];
  const rows = pages.flatMap(page => page.rows);
  const zone = first?.head.timeZone ?? "UTC";
  // A row is named as its breakdown names it (its key is not its name); a whole of skills, tools or MCP by the breakdown.
  const member = row ? rowName(row, t("tasks.noAgent")) : list.member === null ? list.group && t(`usage.by.${list.group}`) : null;
  const span = first?.head.period ?? days;
  const spanWords = !list.days && span ? spanLabel(span.from, span.to) : null;
  // Until its first page has come, the list stands as every part does (ReadPart): its shape, its failure, or offline.
  if (!first) return <ReadPart set={{ data: null, current: false, reads: [query] }} skeleton={<RegionSkeleton shape="analysisList" />}>{() => null}</ReadPart>;
  const left = first.total - rows.length;
  // A list of a chart's bin says its days and what it lists on one line; a number's list says its span under it.
  const title = listHeading(list, first.total);
  const dayOf = (row: ListRow) => row.finishedAt ? instant(row.finishedAt, zone).split(" ")[0]! : null;
  const noDays = !showsDays(list, list.days ?? span);
  const columns = noDays ? "grid-cols-[44px_minmax(0,1fr)_minmax(64px,auto)]" : "grid-cols-[44px_minmax(0,1fr)_48px_minmax(64px,auto)]";
  return <div className="animate-rise">
    <h3 className="text-heading font-semibold">{list.days ? `${spanLabel(list.days.from, list.days.to)}${t("sep")}${title}` : title}</h3>
    <p className="mt-0.5 text-xs text-soft">{member}{member && spanWords && t("sep")}{spanWords}</p>
    {rows.length ? <>
      {/* A heading that wraps (a narrow window, a long language) makes the line taller, never runs into the first row. */}
      <div className={cn("mt-4 grid min-h-7 items-end gap-x-3 border-b border-rule pb-1.5 text-xs text-soft", columns)}>
        <span>{t("list.task")}</span><span />{!noDays && <span className="text-end [word-break:auto-phrase]">{t("list.day")}{!list.value && " ▼"}</span>}
        <span className="text-end whitespace-nowrap">{listColumn(list)}{list.value && " ▼"}</span>
      </div>
      <ul>{rows.map(row => <li key={row.id} className="border-b border-rule">
        <button type="button" data-unit-row={row.id} onClick={() => useViewStore.getState().showAnalysis({ ...place, unit: row.id })}
          className={cn("grid h-9.75 w-full items-center gap-x-3 rounded-sm text-start text-base hover:bg-hover", columns)}>
          <span className="text-muted">{row.id}</span>
          <span dir="auto" className="truncate">{row.title}</span>
          {!noDays && <span className="text-end text-soft">{dayOf(row) ?? ""}</span>}
          <span className="text-end font-semibold whitespace-nowrap">
            {list.value && row.value !== null ? writeValue(list.value, row.value)
              : <span className="inline-flex items-center font-normal text-muted">{row.outcome && <Square className={OUTCOME[row.outcome]} />}{outcomeWord(row, t)}</span>}
          </span>
        </button>
      </li>)}</ul>
      {/* The next page comes in where its rows will stand; a page that could not be read says so, with a way to ask again. */}
      {query.isFetchingNextPage ? <RegionSkeleton shape="analysisRows" />
        : query.isFetchNextPageError ? <ReadFailure error={query.error} className="mt-2.5" retry={() => void query.fetchNextPage()} />
        : left > 0 && query.hasNextPage && <button type="button" onClick={() => void query.fetchNextPage()}
          className="-mx-1 mt-2.5 rounded-sm px-1 text-base text-muted decoration-ink underline-offset-4 hover:bg-hover hover:text-ink hover:underline">{t("list.more", { count: left })}</button>}
    </> : <p className="mt-4 text-soft">{t("list.empty")}</p>}
  </div>;
}

/** The breakdown's row a list was opened from: the answer that drew it (already read), and its row by key. */
function useRowOf(project: string | null, span: Span, list: ListPlace) {
  const bucket = useChoices(state => state.bucket);
  const group = list.group ?? "model", row = list.group !== null && list.member !== null;
  // The same read as the breakdown's own (already held when the list was opened from it).
  const read = useBreakdown(list.set === "used" ? "usage" : "tasks", project, span, bucket, group, row);
  const rows: (Parameters<typeof rowName>[0] & { key: string })[] = read.data?.breakdown.rows ?? [];
  return row ? rows.find(each => each.key === list.member) ?? null : null;
}

/** One task: its time drawn as the list draws time (the AI at work, your turn, paused), what you sent as marks, then its values, only those that are not zero. */
export function UnitPane({ unit }: { unit: string }) {
  const { t } = useTranslation("analysis");
  const query = useUnitValues(unit);
  if (!query.data) return <ReadPart set={{ data: null, current: false, reads: [query] }} skeleton={<RegionSkeleton shape="analysisTask" />}>{() => null}</ReadPart>;
  const values = query.data, row = values.unit;
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
  return <div className="animate-rise">
    <h3 dir="auto" className="text-heading font-semibold">{row.title}</h3>
    <p className="mt-2 inline-flex items-center text-muted">
      <Square className={row.outcome ? OUTCOME[row.outcome] : "bg-rule"} />{outcomeWord(row, t)}{lead !== null && <span className="ms-3">{duration(lead)}</span>}
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
    <p className="mt-7"><Button variant="outline" onClick={() => useViewStore.getState().openFromAnalysis(values.unit.id)}>{t("values.open")}</Button></p>
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
