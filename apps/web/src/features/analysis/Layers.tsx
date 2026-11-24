import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { closeAnalysisLayer } from "@/state/history-step";
import { useNarrow, useViewStore } from "@/state/view-store";
import { useWorkspaceInfo } from "@/data/queries";
import { cn } from "@/lib/utils";
import { useUnitList, useUnitValues } from "./data";
import { duration, format, instant, spanLabel } from "./format";
import { listColumn, listTitle, listUnit, writeValue } from "./lists";
import { Square, tip } from "./parts";
import type { ListRow, UnitValues } from "./contract";
import type { AnalysisPlace } from "./place";

/** A task's outcome: its colour and its word. */
const OUTCOME = { passed: "bg-done", reworked: "bg-reworked", stopped: "bg-stopped" } as const;
const outcomeWord = (row: ListRow, say: (key: string) => string) => say(`outcome.${row.outcome ?? "none"}`);

/**
 * What a number opens: the list of the tasks behind it, then one task's values. The same surface as the reader on the
 * list of tasks (lit, a hairline edge, 12px from the right and the top), the page behind it kept as it is; on a phone a
 * sheet from the bottom. × and a press behind it close every layer; the list's way back and Back close one.
 */
export function Layers({ place, project, days }: { place: AnalysisPlace; project: string | null; days: { from: string; to: string } | null }) {
  const { t } = useTranslation("analysis");
  const narrow = useNarrow();
  const surface = useRef<HTMLElement>(null);
  const depth = (place.list ? 1 : 0) + (place.unit ? 1 : 0);
  const back = place.list && place.unit;
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closeAnalysisLayer(depth - 1); } };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [depth]);
  useEffect(() => { surface.current?.querySelector<HTMLElement>("[data-layer-focus]")?.focus({ preventScroll: true }); }, [place.list, place.unit]);
  if (!depth) return null;
  return <>
    <div aria-hidden className="fixed inset-0 z-(--layer-reader)" onClick={() => closeAnalysisLayer(0)} />
    <aside ref={surface} role="dialog" aria-label={place.unit ?? (place.list ? listTitle(place.list) : "")}
      className={cn("fixed z-(--layer-reader) flex flex-col border-hairline border-lit-line bg-lit shadow-float",
        narrow ? "inset-x-0 top-[18%] bottom-0 animate-sheet rounded-t-pane before:absolute before:top-1.5 before:left-1/2 before:-ms-4.5 before:h-1 before:w-9 before:rounded-xs before:bg-lit-line"
          : "top-window right-window bottom-window w-[min(548px,calc(100%-24px))] animate-side rounded-pane")}>
      <div className={cn("flex min-h-12 items-center gap-2 pt-3.5 pe-3 pb-1.5 ps-5", narrow && "pt-4.5 pe-2 ps-4")}>
        {back && <button type="button" data-layer-focus onClick={() => closeAnalysisLayer(1)}
          className="-ms-2 inline-flex h-7 items-center gap-0.5 rounded-md ps-1 pe-2.5 text-muted hover:bg-hover hover:text-ink">
          <Icon name="left" className="size-3.5" />{t("list.back")}</button>}
        {place.unit && <span className="text-muted">{place.unit}</span>}
        <span className="me-auto" />
        <Button variant="ghost" size="icon" aria-label={t("list.close")} title={t("list.close")} data-layer-focus={back ? undefined : ""}
          onClick={() => closeAnalysisLayer(0)}><Icon name="close" /></Button>
      </div>
      <div data-analysis-layer className="min-h-0 flex-1 overflow-auto px-5 narrow:px-4">
        {place.unit ? <UnitPane key={place.unit} unit={place.unit} />
          : place.list && <ListPane key={JSON.stringify(place.list)} place={place} project={project} days={days} />}
      </div>
    </aside>
  </>;
}

/** The tasks of one number: how many, for which days, and each task with its own value for it, most first. */
function ListPane({ place, project, days }: { place: AnalysisPlace; project: string | null; days: { from: string; to: string } | null }) {
  const { t } = useTranslation("analysis");
  const list = place.list!;
  const query = useUnitList(project, place.span, list);
  const projects = useWorkspaceInfo(info => info.projects);
  const pages = query.data?.pages ?? [];
  const first = pages[0];
  const rows = pages.flatMap(page => page.rows);
  const zone = first?.head.timeZone ?? "UTC";
  const member = list.group === "project" ? projects.find(project => project.id === list.member)?.title ?? list.member : list.member;
  const span = first?.head.period ?? days;
  if (!first) return query.isError ? <p className="text-soft">{query.error.message}</p> : <RegionSkeleton shape="rows" rows={6} className="mt-4" />;
  const left = first.total - rows.length;
  return <div className="animate-rise">
    <h3 className="text-xl font-semibold">{t("list.title", { title: listTitle(list), n: first.total.toLocaleString(), unit: listUnit(list, first.total) })}</h3>
    <p className="mt-0.5 text-xs text-soft">{[member, span && spanLabel(span.from, span.to)].filter(Boolean).join(t("sep"))}</p>
    {rows.length ? <>
      <div className="mt-4 grid h-7 grid-cols-[44px_minmax(0,1fr)_40px_minmax(64px,auto)] items-center gap-x-3 border-b border-rule text-xs text-soft">
        <span>{t("list.task")}</span><span /><span className="text-end">{t("list.day")}{!list.value && " ▼"}</span>
        <span className="text-end whitespace-nowrap">{listColumn(list)}{list.value && " ▼"}</span>
      </div>
      <ul>{rows.map(row => <li key={row.id} className="border-b border-rule">
        <button type="button" onClick={() => useViewStore.getState().showAnalysis({ ...place, unit: row.id })}
          className="grid h-8.75 w-full grid-cols-[44px_minmax(0,1fr)_40px_minmax(64px,auto)] items-center gap-x-3 rounded-sm text-start hover:bg-hover">
          <span className="text-muted">{row.id}</span>
          <span dir="auto" className="truncate">{row.title}</span>
          <span className="text-end text-soft">{row.finishedAt ? instant(row.finishedAt, zone).split(" ")[0] : ""}</span>
          <span className="text-end font-semibold whitespace-nowrap">
            {list.value && row.value !== null ? writeValue(list.value, row.value)
              : <span className="inline-flex items-center font-normal text-muted">{row.outcome && <Square className={OUTCOME[row.outcome]} />}{outcomeWord(row, t)}</span>}
          </span>
        </button>
      </li>)}</ul>
      {left > 0 && query.hasNextPage && <button type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}
        className="mt-2.5 text-muted underline decoration-line underline-offset-4 hover:decoration-ink">{t("list.more", { count: left })}</button>}
    </> : <p className="mt-4 text-soft">{t("list.empty")}</p>}
  </div>;
}

/** One task: its time drawn as the list draws time (the AI at work, your turn, paused), what you sent as marks, then its values, only those that are not zero. */
function UnitPane({ unit }: { unit: string }) {
  const { t } = useTranslation("analysis");
  const query = useUnitValues(unit);
  if (!query.data) return query.isError ? <p className="text-soft">{query.error.message}</p> : <RegionSkeleton shape="rows" rows={6} className="mt-4" />;
  const values = query.data, row = values.unit;
  const you = values.time.review + values.time.answer;
  const lead = row.outcome && row.outcome !== "stopped" && row.finishedAt ? Date.parse(row.finishedAt) - Date.parse(row.requestedAt) : null;
  const usage = values.usage;
  const facts = ([[t("until.submits"), values.submits], [t("values.sendBacks"), values.sendBacks], [t("values.atReview"), values.instructionsAtReview],
    [t("values.afterAccept"), values.instructionsAfterAccept], [t("values.duringWork"), values.instructionsDuringWork],
    [t("until.questions"), values.questions], [t("values.answers"), values.answers]] as [string, number][]).filter(([, n]) => n);
  const used = ([
    [t("usage.launches"), usage.launches && format("times", usage.launches)],
    [t("usage.runMs"), usage.runMs && duration(usage.runMs)],
    [t("values.conversations"), usage.newConversations && format("plain", usage.newConversations)],
    [t("values.workers"), values.workers && format("plain", values.workers)],
    [t("values.children"), values.children && format("plain", values.children)],
    [t("usage.output"), usage.tokens.output && format("tokens", usage.tokens.output)],
    [t("values.inputCache"), usage.tokens.input + usage.tokens.cache && format("tokens", usage.tokens.input + usage.tokens.cache)],
  ] as [string, string | 0][]).filter(([, text]) => text) as [string, string][];
  return <div className="animate-rise">
    <h3 dir="auto" className="text-xl font-semibold">{row.title}</h3>
    <p className="mt-2 inline-flex items-center text-muted">
      <Square className={row.outcome ? OUTCOME[row.outcome] : "bg-rule"} />{outcomeWord(row, t)}{lead !== null && <span className="ms-3">{duration(lead)}</span>}
    </p>
    <Band values={values} />
    <p className="mt-3 flex flex-wrap gap-x-4.5 gap-y-1 text-muted">
      {you > 0 && <span className="inline-flex items-center"><Square className="bg-turn" />{t("time.you")}<b className="ms-1.5 font-semibold text-ink">{duration(you)}</b></span>}
      {values.time.ai > 0 && <span className="inline-flex items-center"><Square className="bg-working" />{t("time.ai")}<b className="ms-1.5 font-semibold text-ink">{duration(values.time.ai)}</b></span>}
      {values.time.other >= 60_000 && <span className="inline-flex items-center"><Square className="bg-rest" />{t("time.other")}<b className="ms-1.5 font-semibold text-ink">{duration(values.time.other)}</b></span>}
    </p>
    {facts.length > 0 && <p className="mt-2 flex flex-wrap gap-x-4.5 gap-y-1 text-muted">
      {facts.map(([name, n]) => <span key={name}>{name}<b className="ms-1.5 font-semibold text-ink">{n.toLocaleString()}</b></span>)}</p>}
    {used.length > 0 && <>
      <h4 className="mt-6 mb-2 text-xs font-normal text-soft">{t("values.usage")}</h4>
      <p className="flex flex-wrap gap-x-4.5 gap-y-1 text-muted">{used.map(([name, text]) => <span key={name}>{name}<b className="ms-1.5 font-semibold text-ink">{text}</b></span>)}</p>
    </>}
    {values.models.length > 0 && <table className="mt-2.5 w-full border-collapse">
      <thead><tr className="h-7.5 border-b border-rule text-xs text-soft">
        <th className="text-start font-normal">{t("values.models")}</th><th className="ps-3 text-end font-normal">{t("usage.launches")}</th>
        <th className="ps-3 text-end font-normal">{t("usage.runMs")}</th><th className="ps-3 text-end font-normal">{t("usage.output")}</th></tr></thead>
      <tbody>{values.models.map(model => <tr key={model.label} className="h-7.5 border-b border-rule">
        <td>{model.label}</td><td className="ps-3 text-end">{format("times", model.launches)}</td>
        <td className="ps-3 text-end">{duration(model.runMs)}</td><td className="ps-3 text-end">{format("tokens", model.output)}</td></tr>)}</tbody>
    </table>}
    {values.prs.length > 0 && <>
      <h4 className="mt-6 mb-2 text-xs font-normal text-soft">{t("until.prs")}</h4>
      <p className="flex flex-wrap gap-x-4.5 gap-y-1">{values.prs.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">#{url.split("/").pop()}</a>)}</p>
    </>}
    {values.skills.length > 0 && <>
      <h4 className="mt-6 mb-2 text-xs font-normal text-soft">{t("values.skills")}</h4>
      <p className="flex flex-wrap gap-x-4.5 gap-y-1 text-muted">{values.skills.map(skill => <span key={skill}>{skill}</span>)}</p>
    </>}
    {values.tools.length > 0 && <>
      <h4 className="mt-6 mb-2 text-xs font-normal text-soft">{t("values.tools")}</h4>
      <p className="flex flex-wrap gap-x-4.5 gap-y-1 text-muted">{values.tools.slice(0, 8).map(tool =>
        <span key={tool.name}>{tool.name}<b className="ms-1.5 font-semibold text-ink">{tool.calls.toLocaleString()}</b></span>)}</p>
    </>}
    <p className="mt-7"><Button variant="outline" onClick={() => useViewStore.getState().openFromAnalysis(values.unit.id)}>{t("values.open")}</Button></p>
  </div>;
}

const BAND = { doing: "bg-working", yours: "bg-turn", paused: "bg-rest" } as const;
/** The task's own time from its request to its end (or now): its pieces, with what you sent marked above. */
function Band({ values }: { values: UnitValues }) {
  const { t } = useTranslation("analysis");
  const zone = values.head.timeZone, row = values.unit;
  if (!values.band.length) return null;
  const start = Date.parse(values.band[0]!.from), end = Date.parse(values.band[values.band.length - 1]!.to), span = Math.max(1, end - start);
  const ending = row.outcome === "stopped" && row.finishedAt ? t("values.stopped", { at: instant(row.finishedAt, zone) })
    : row.outcome && row.finishedAt ? t("values.accepted", { at: instant(row.finishedAt, zone) }) : t("outcome.none");
  return <div className="relative mt-5 pt-3">
    <div className="absolute inset-x-0 top-0 h-2.5">
      {values.marks.map((mark, at) => <em key={at} style={{ left: `${Math.min(100, (Date.parse(mark.at) - start) / span * 100)}%` }}
        className="absolute bottom-0 -ms-px h-2 w-0.5 rounded-[1px] bg-turn" {...tip(t(`values.marks.${mark.kind}`))} />)}
    </div>
    <div className="flex h-2 gap-px">
      {values.band.map((piece, at) => {
        const width = Date.parse(piece.to) - Date.parse(piece.from);
        return width > 0 && <i key={at} style={{ flex: width }} className={cn("block min-w-px rounded-[1.5px]", BAND[piece.kind])}
          {...tip(`${t(`values.band.${piece.kind}`)} ${duration(width)}`)} />;
      })}
    </div>
    <div className="mt-1.5 flex justify-between gap-3 text-xs text-soft"><span>{instant(row.requestedAt, zone)}</span><span>{ending}</span></div>
  </div>;
}
