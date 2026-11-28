import { countPageOpened } from '@/features/telemetry/count';
import { isDatedRead } from '@/data/read-model';
import type { ReadAssessment } from '@/data/read-model';
import { rowTask } from '@/data/map';
import { type Busy } from "@alpacawork/contract";
import { useTimelineAxis } from "@/data/timeline-axis";
import { useLaneReads, useTimelineLanes } from "@/data/timeline-lanes";
import { errorText } from "@/data/client";
import { createContext, Fragment, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { TodayMarks } from "@/features/analysis/FaceSwitch";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import { isFinished } from "@alpacawork/contract/branch";
import { HOME_SECTIONS, userTurn } from "@alpacawork/contract";
import { turnKind } from "@/features/guide/guide-definition";
import type { TaskProjectedPageDTO, TaskPageRowDTO, TaskTimelineLaneDTO } from "@alpacawork/contract/control";
import { StateIcon } from "@/components/ui/state-label";
import { TaskId } from "@/components/ui/task-id";
import { Icon } from "@/components/ui/icon";
import { TextMark } from "@/components/ui/text-mark";
import { NativeSelect } from "@/components/ui/native-select";
import { TONE, useTaskLook } from "@/components/ui/tone";
import { SentArc } from "./SentArc";
import { useClosedCounts, useListPlace, useHomeList, usePeople, usePeopleFor, useReadIdsFor, useReadState, useTaskIndex, useWorkspaceInfo } from "@/data/queries";
import { resources } from "@/data/resources";
import { usePageSentinel } from "@/data/page-sentinel";
import type { Task, WorkspaceInfo } from "@/data/types";
import { isHand, type BelowRun, type Segment, type TaskHistory } from "@/domain/time-history";
import type { PeopleIndex, TimePeopleIndex } from "@/domain/people";
import { belowOf, chronologyKey, newTimeProjectionHeld, projectTimePeople, timeHistories, timeHistoryBases, type HeldBase, type HeldHistory } from "./time-people";
import { pageRow } from "@/data/read-model";
import { childProgress, childrenOf, descendants, pathTo, type TaskIndex } from "@/domain/tasks";
import { useTitleKeys } from "@/features/forms/title-keys";
import { finishWordsFor, useFinishWords } from "@/features/people/labels";
import { RowLines } from "./RowLines";
import { RowProjectTile } from "./RowProjectTile";
import { RowEnd, RowTime, RowTimeRoom } from "./RowStatus";
import { capitalized, dayClock } from "@/domain/day-clock";
import type { FinishWords } from "@/domain/finish-words";
import { saysRuns } from "@/domain/row-status";
import { advanceNow, useNow } from "@/state/clock";
import { useTimeView } from "@/state/time-view";
import { useNarrow, useViewStore } from "@/state/view-store";
import { ListScroll } from "@/features/shell/ListScroll";
import { BarRoom } from "@/features/chrome/Bar";
import { cn } from "@/lib/utils";
import { titleColumnWidth } from "@/state/screen-settings";
import { useListWidth } from "@/lib/use-list-width";
import { atOf, EDGE_HALO, EdgeLayer, buildAxis, futureBandWidth, futureWords, type FutureWords, Ground, StripGround, Lane, laneMarks, lineOf, lineReports, ProbeRule, shownScaleMs, stretchReport, stripAxis, stripKeys, TimeClock, clockHeight, textScale, rowTurn, TurnEdge, wordsW, type RowTurn, useStrip, useStripProbe, showZoom, StripPress, wholeIn, xOf, type Level, type MarkAt, type Piece, type Scale } from "./time-line";
import { drawnTaskIds, useListNavigationSource } from "./list-navigation";
import { ShelvedRow } from "./ShelvedRow";
import { PageReadFailure, type PageRead, type ReadView } from "./PageReadFailure";
import { Welcome } from "./Welcome";
import { scrollMotion, useListMotion, useTint } from "@/lib/motion";
import { sameDrawingSource, type DrawingSource } from "@/lib/drawing";
import { useWorkspaceSelector } from "@/data/workspace-store";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { useConnection } from "@/data/connection";
import { PullMark, usePullToRefresh } from "./pull-refresh";
import { ReadFailure, ReadNote } from "@/components/ui/loadable";
import { useDeviceValue } from "@/lib/device-storage";
import { HeadingAgents, HeadingSpeedUnit, HeadingTokenSpeed, RowTokenSpeed, SPEED_LANE, SpeedLane, speedLane } from "./token-speed";
import { isOpen, SECTION_START, sectionFold, sectionsOpen, storedWith } from "./section-fold";
import { useOfflineShown } from "@/data/reach";
import { useListEntrance } from "./list-entrance";


/** The flat home list and its time strips. */
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const PERIODS = [30 * MINUTE, HOUR, 6 * HOUR, DAY, 7 * DAY] as const;
const MOBILE_PERIOD_W = 72;

function periodText(ms: number, locale: string): string {
  const format = (value: number, unit: Intl.NumberFormatOptions["unit"]) =>
    new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
  if (ms === 7 * DAY) return format(1, "week");
  if (ms === HOUR) return format(1, "hour");
  if (ms < 2 * HOUR) return format(Math.round(ms / MINUTE), "minute");
  if (ms < 2 * DAY) return format(Math.round(ms / HOUR * (ms < 10 * HOUR ? 10 : 1)) / (ms < 10 * HOUR ? 10 : 1), "hour");
  return format(Math.round(ms / DAY * 10) / 10, "day");
}

/** One displayed scale, derived from the same axis that wheel and key zoom write. */
function Period({ pieces, screen, layout, futureWidth, fullScale, onScale, onShowAll }: {
  pieces: Piece[]; screen: number; layout: number; futureWidth: number; fullScale: number;
  onScale: (ms: number) => void; onShowAll: () => void;
}) {
  const { t, i18n } = useTranslation("tree");
  // A period is the zoom's, for `layout`; all of time is what fits in what is in sight (`screen`).
  const scale = shownScaleMs(pieces, layout, futureWidth);
  const fitted = wholeIn(pieces, screen);
  const choices: { value: string; ms: number; text: string }[] = [];
  let named: number | undefined;
  for (const ms of PERIODS) {
    if (!(ms < fullScale * 0.98)) continue;
    if (named === undefined && Math.abs(scale / ms - 1) <= 0.01) named = ms;
    choices.push({ value: String(ms), ms, text: periodText(ms, i18n.language) });
  }
  const value = fitted ? "all" : named ? String(named) : "custom";
  if (value === "custom") choices.push({ value, ms: scale, text: periodText(scale, i18n.language) });
  choices.sort((a, b) => a.ms - b.ms);
  return <span data-time-period className="relative ml-auto flex h-full flex-none items-center bg-bg narrow:absolute narrow:top-full narrow:left-0 narrow:z-20 narrow:ml-0 narrow:h-11 narrow:border-r narrow:border-rule"
    // As wide as its longest period at the reader's text size.
    style={{ width: MOBILE_PERIOD_W * textScale() }}>
    <NativeSelect data-span value={value} aria-label={t("timeView.scaleLabel")} title={t("timeView.scaleLabel")}
      onChange={(event) => event.target.value === "all" ? onShowAll() : onScale(Number(event.target.value))}
      className="h-full min-h-6 w-full appearance-none border-0 bg-bg py-0 ps-1.5 pe-5 text-xs text-ink [text-align-last:right] narrow:[text-align-last:auto] hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-2px] focus-visible:outline-ink narrow:min-h-11">
      {choices.map((choice) => <option key={choice.value} value={choice.value} disabled={choice.value === "custom"}>{choice.text}</option>)}
      <option value="all">{t("timeView.scaleAll")}</option>
    </NativeSelect>
    <Icon name="down" aria-hidden="true" className="pointer-events-none absolute end-1 size-3 text-muted" />
  </span>;
}
/** In progress, Needs attention, Awaiting review, Waiting, Not started, On hold and Done: the home list's sections, in the order they are drawn. */
type HomeSection = (typeof HOME_SECTIONS)[number];
type HomeRow = WorkspaceInfo["home"][number];
/**
 * `lifted`: a task shown on its own row away from its parent; its row starts with the way up to it. `row`: the home
 * list's row it is drawn for (the request it is listed under, its summary); null on a row of Done's pages the home list does not hold.
 */
type Node = { task: Task; path: string[]; lifted: boolean; row: HomeRow | null;
  /** A row of a list kept as of an earlier time (`datedRows`): drawn, but no fact of the workspace's and never read. */
  dated?: boolean };
type Group = { nodes: Node[] };
type Shared = {
  drawing: DrawingSource;
  index: TaskIndex; people: PeopleIndex; timePeople: TimePeopleIndex | null; narrow: boolean; selected: string | null; screen: number; lead: number;
  /** The speed column's width at the title column's end, within `lead`; 0 when there is none. Only In progress rows
   *  and their heading draw it: every other row's title runs on over its width. */
  lane: number;
  /** The strips are always beside the rows on a wide sheet; on a narrow one only when asked for (Time). */
  strips: boolean;
};
/** `open` and `hidden` as sectionFold says. `count` is the server's. */
type Section = { section: HomeSection; count: number; open: boolean; hidden: number | null; tree: Group };
/** A wide row's height, its strip's too: a 14px title with room above and below. */
const WIDE_ROW = 32;
const NONE: ReadonlySet<string> = new Set();
const NO_SECTIONS: ReadonlySet<HomeSection> = new Set();
const without = <T,>(set: ReadonlySet<T>, item: T): ReadonlySet<T> => { const next = new Set(set); next.delete(item); return next; };
const sameVisibleRows = (a: ReadonlySet<string> | null, b: ReadonlySet<string>) => {
  if (a === null || a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
};
/** A fetched window is retained through small axis shifts; zooming far enough asks for detail. */
export function timelineWindow(old: { from: number; to: number } | null, seen: { from: number; to: number }) {
  const step = 5 * 60_000;
  if (old && seen.from >= old.from && seen.to <= old.to && seen.to - seen.from >= (old.to - old.from) * 0.6) return old;
  const next = { from: Math.floor(seen.from / step) * step - step,
    to: Math.ceil(seen.to / step) * step + step };
  return old?.from === next.from && old.to === next.to ? old : next;
}
type RowTime = {
  histories: ReadonlyMap<string, TaskHistory | null> | null; scale: Scale; pieces: Piece[]; now: number;
  seen: { from: number; to: number } | null; show: (from: number, to: number) => void;
};
const RowTimeContext = createContext<RowTime | null>(null);
const useRowTime = () => {
  const value = useContext(RowTimeContext);
  if (!value) throw new Error("Time row needs its clock and scale");
  return value;
};

/** The list with its time strips. */
/** `entering`: drawn in place of the analysis just now, so its lines come in (useListEntrance). */
export function TimeTree({ entering = false }: { entering?: boolean }) {
  const { t, i18n } = useTranslation("tree");
  const { t: pt } = useTranslation("people");
  const index = useTaskIndex();
  const drawing = useWorkspaceSelector(data => data.drawing);
  const people = usePeople();
  const info = useWorkspaceInfo();
  const now = useNow();
  const narrow = useNarrow();
  const chosen = useTimeView((state) => state.viewMs);
  const selected = useViewStore((state) => state.selected);
  const readerOpen = useViewStore((state) => state.reader.open);
  const stripsAsked = useTimeView((state) => state.strips);
  const selectedHere = readerOpen ? selected : null;
  // The home list as the server projects it for the project in view: its rows by section and each section's count.
  const home = useHomeList();
  // The page's opening time ends where its list first shows rows.
  useEffect(() => { if (home.rows.length) countPageOpened(); }, [home.rows.length]);
  // Whether each section is open is kept on this device; a section opened for the task in the detail, and one whose rows
  // past its first few are shown, are so for this visit only.
  const stored = useDeviceValue(sectionsOpen);
  const [opened, setOpened] = useState<ReadonlySet<HomeSection>>(NO_SECTIONS);
  const [more, setMore] = useState<ReadonlySet<HomeSection>>(NO_SECTIONS);
  const fold = { stored, opened, more };
  const doneOpen = isOpen("done", fold);
  // Done: the finished rows of the project in view (its nested projects' included), as the index pages and counts them.
  const project = useViewStore((state) => state.project);
  const closedCounts = useClosedCounts();
  // A scope holding no Task at all (one asked by an agent included) says how work starts in the list's place
  // (useListPlace).
  const welcome = useListPlace() === "welcome";
  const finishedOptions = resources.finished(info.root, null, project);
  const finished = useInfiniteQuery({ ...finishedOptions, enabled: doneOpen });
  const finishedRead = useReadState(finishedOptions.queryKey);
  const finishedDated = useDatedRows(finished.data, finishedRead.assessment);
  const finishedPageIds = useMemo(() => {
    const ids = new Set<string>();
    if (finished.data) for (const page of finished.data.pages) for (const row of page.rows) ids.add(row.id);
    return ids;
  }, [finished.data]);
  // The task open in the detail, in the project in view, is a row of Done when its list row says it is (doneRow): Done
  // opens for it, and its page brings the row.
  const openedDone = !!selectedHere && doneRow(index.byId.get(selectedHere));
  const finishedSentinel = useRef<HTMLDivElement>(null);
  const toggleSection = (section: HomeSection, open: boolean) => {
    sectionsOpen.set(storedWith(sectionsOpen.get(), section, !open));
    if (open) setOpened((was) => without(was, section));
  };
  const box = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null), markRef = useRef<HTMLDivElement>(null);
  usePageSentinel(finishedSentinel, finished, box);
  // Rows outside the vertical viewport keep their space, but have no time drawing to recompute
  // for each zoom. Keep one small screen margin so ordinary scrolling reveals a finished strip.
  const [visibleRows, setVisibleRows] = useState<ReadonlySet<string> | null>(() => typeof IntersectionObserver === "undefined" ? null : new Set());
  const { tree, sections, selectedAt } = useMemo(() => {
    // Each Task the home list lists has its own row, in its section, in the order the server lists them.
    const listed: Record<HomeSection, { task: Task; row: HomeRow | null; dated?: boolean }[]> = { doing: [], error: [], review: [], awaited: [], held: [], todo: [], done: [] };
    for (const row of home.rows) {
      const task = index.byId.get(row.taskId);
      if (task) listed[row.section].push({ task, row });
    }
    // The home list's rows are of work not finished: Done lists what its loaded pages list, in their order.
    // A list kept as of an earlier time draws its own rows (`datedRows`); a row the workspace holds is drawn as it holds it.
    for (const id of finishedPageIds) {
      const task = index.byId.get(id), dated = finishedDated?.get(id);
      if (dated) listed.done.push({ task: dated, row: null, dated: true });
      else if (task) listed.done.push({ task, row: null });
    }
    // Where the task open in the detail is listed, so its section, and its rows past the first few, open for it. A row of
    // Done is so before its page brings it.
    let selectedAt: { section: HomeSection; at: number } | null = openedDone ? { section: "done", at: 0 } : null;
    if (!selectedAt && selectedHere) for (const section of HOME_SECTIONS) {
      const at = listed[section].findIndex(({ task }) => task.id === selectedHere);
      if (at >= 0) { selectedAt = { section, at }; break; }
    }
    // A section is drawn while it holds something, its heading included: Done holds its finished Tasks and the
    // shelved ones at its end.
    const holds = { ...home.counts, done: closedCounts.finished + closedCounts.shelved };
    const nodes: Node[] = [];
    const sections: Section[] = HOME_SECTIONS.filter((section) => !welcome && holds[section] > 0).map((section) => {
      const all = listed[section];
      const { open, shown, hidden } = sectionFold(section, all.length, { stored, opened, more });
      return { section, count: section === "done" ? closedCounts.finished : home.counts[section], open, hidden, tree: {
        nodes: all.slice(0, shown).map(({ task, row, dated }) => {
          const up = !!task.parent && !dated;
          const path: string[] = [];
          if (up) {
            const lineage = pathTo(task.id, index);
            for (let at = 0; at < lineage.length - 1; at++) path.push(lineage[at]!.id);
          }
          const node = { task, path, lifted: up, row, dated };
          nodes.push(node);
          return node;
        }) } };
    });
    return { tree: { nodes }, sections, selectedAt };
  }, [welcome, index, home, stored, opened, more, selectedHere, closedCounts, finishedPageIds, finishedDated, openedDone]);
  const navigation = useMemo(() => ({ ids: drawnTaskIds(tree), open: openDetail }), [tree]);
  useListNavigationSource(navigation);
  // Only a change to the drawn rows/section furniture can rearrange this fixed-height list. Selecting a row
  // changes its ring, not its place; do not remeasure every row or restart its visibility observer for that.
  const rowLayout = useMemo(() => JSON.stringify(sections.map(({ section, tree, hidden, open }) => [section,
    tree.nodes.map(({ task }) => task.id), hidden !== null, open])), [sections]);
  useLayoutEffect(() => {
    const root = box.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const bounds = root.getBoundingClientRect();
    const rows = root.querySelectorAll<HTMLElement>("li[data-row]");
    for (const row of rows) {
      const position = row.getBoundingClientRect();
      if (position.bottom > bounds.top - 300 && position.top < bounds.bottom + 300 && row.dataset.row)
        visible.add(row.dataset.row);
    }
    setVisibleRows(was => sameVisibleRows(was, visible) ? was : new Set(visible));
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.row;
        if (!id) continue;
        if (entry.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      setVisibleRows(was => sameVisibleRows(was, visible) ? was : new Set(visible));
    }, { root, rootMargin: "300px 0px" });
    rows.forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [rowLayout]);
  // A task added, moving to another section or leaving one: the rows glide to their new places.
  // Measure row rearrangements within their sheet: pulling moves that whole sheet, not its rows.
  useListMotion(sheetRef, [rowLayout]);
  // Opening a task in the detail opens its section, and its rows past the first few, for this visit; before paint, so its row
  // is on the list with its ring. Closing the section afterwards is the reader's to do.
  useLayoutEffect(() => {
    if (!selectedAt) return;
    const { section, at } = selectedAt;
    if (!isOpen(section, { stored: sectionsOpen.get(), opened })) setOpened((was) => new Set(was).add(section));
    if (at >= (SECTION_START[section].rows ?? Infinity)) setMore((was) => was.has(section) ? was : new Set(was).add(section));
  }, [selectedHere, selectedAt?.section]);
  const strips = !narrow || stripsAsked;

  const rowNodes = tree.nodes;
  const visibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of rowNodes) {
      if (visibleRows === null || visibleRows.has(node.task.id)) ids.add(node.task.id);
    }
    return [...ids];
  }, [rowNodes, visibleRows]);
  // The chronology is read for the strips; a phone's list without them (Time not asked for) reads none.
  const needsTimeline = strips && visibleIds.length > 0;
  const [windowRange, setWindowRange] = useState<{ from: number; to: number } | null>(null);
  const range = windowRange ?? { from: now - 24 * 3_600_000, to: now };
  const offline = useConnection((state) => state.offline);
  const offlineShown = useOfflineShown();
  const timeline = useLaneReads(info.root, visibleIds, { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
    offline, needsTimeline && windowRange !== null);
  const timelineLanes = useTimelineLanes(info.root);
  // The time projection reads chronology, not a task's title, body, progress or
  // Run activity sample. Keep its identity when those unrelated fields change.
  const chronology = useMemo(() => chronologyKey(people), [people]);
  useEffect(advanceNow, [chronology]);
  // What stays the same between reads stays the same object, so a row that nothing happened to is not drawn again.
  const projection = useRef(newTimeProjectionHeld()), heldBases = useRef(new Map<string, HeldBase>()), heldHistories = useRef(new Map<string, HeldHistory>());
  // Only strips consume the acquired chronology. Keep held identities while Time is hidden;
  // reopening projects the latest people and pages, including before the axis is ready.
  const projected = useMemo(() => strips ? projectTimePeople(people, timelineLanes, projection.current) : null, [chronology, timelineLanes, strips]);
  const timePeople = projected?.timePeople ?? null;
  // The Runs under each row come from the window the list reads now.
  const heldBelow = useRef({ lanes: [] as readonly TaskTimelineLaneDTO[], below: new Map<string, BelowRun[]>() });
  const below = useMemo(() => belowOf(timeline.shown, heldBelow.current), [timeline.shown]);
  // A phone's list has no history consumers. Keep the held row identities, but do not
  // build or project histories for clock ticks and chronology changes while Time is hidden.
  const bases = useMemo(() => projected ? timeHistoryBases(projected.timePeople, projected.notes, below, heldBases.current) : null, [projected, below]);
  const histories = useMemo(() => bases ? timeHistories(bases, now, heldHistories.current) : null, [bases, now]);
  const laneIds = useMemo(() => rowNodes.map(node => node.task.id), [rowNodes]);
  const axis = useTimelineAxis(info.root, laneIds, strips);
  const axisReady = axis.busy !== undefined;
  // Hold newly published activity while reading back in time or manipulating the strip. Window reads never feed this.
  const axisSnapshot = useRef<{ busy: Busy; earliest: number | null } | null>(null);
  const onNow = useRef<() => boolean>(() => true);
  if (!axisSnapshot.current || chosen === null || onNow.current())
    axisSnapshot.current = { busy: axis.busy ?? [], earliest: axis.earliest };
  const axisBusy = axisSnapshot.current.busy;
  const earliest = axisSnapshot.current.earliest ?? now - 86_400_000;
  /** The strip reaches back to 5 minutes before the oldest history, or before a screen at the zoom if that is further. */
  const startAt = (ms: number) => Math.min(earliest, now - ms) - 5 * MINUTE;
  const list = useListWidth(box, 1200), { width: sheet, zoomWidth } = list;
  // The title column: narrower when the sheet itself is narrow (the detail is open beside it), so the time keeps its room.
  // Beside it, before the time, the column of the In progress rows' output speed (speedLane).
  const lane = narrow || !strips || sheet < 600 ? 0 : speedLane(sheet);
  const lead = narrow ? 0 : Math.min(titleColumnWidth(sheet) + lane, Math.max(0, sheet - 120));
  // The width the zoom is for (useStrip): a reader past half the screen only hides the strip's oldest part.
  const laid = Math.max(sheet, zoomWidth) - lead;
  // Hidden strips need only the clock-width minimum, not each row's end prediction.
  const futureLabels: FutureWords[] = [];
  if (strips) rowNodes.forEach((node) => {
    const label = futureWords(stripFinish(node, finishWordsFor(node.task.id, index, people, now, pt, i18n.language)), now);
    if (label) futureLabels.push(label);
  });
  const futureWidth = futureBandWidth(futureLabels);
  // All of time is drawn from the zoom that shows the history; the strip zooms out from it until all of it is in sight.
  const viewMs = chosen === "all" ? showZoom(earliest, now, Math.max(120, sheet - lead), Math.max(120, laid), futureWidth).viewMs
    : chosen ?? 24 * 3_600_000;
  const from = startAt(viewMs);
  // A fitted axis can enlarge linear time after long quiet gaps fold. Use its scale near now as well as the zoom scale.
  const fitted = buildAxis(from, now, now, axisBusy, Math.max(120, sheet - lead), viewMs);
  const tail = fitted.at(-1);
  const fittedPerMs = tail && tail.to > tail.from ? (tail.x1 - tail.x0) / (tail.to - tail.from) : 0;
  // Keep 2px of rounding room so the last pixel stays inside the future band.
  const room = (ms: number) => Math.min(ms * (futureWidth - 2) / Math.max(60, laid - futureWidth),
    fittedPerMs > 0 ? (futureWidth - 2) / fittedPerMs : Number.POSITIVE_INFINITY);
  const strip = useStrip(box, list, lead, { from: startAt, end: (ms) => now + room(ms), now, busy: axisBusy, viewMs, all: chosen === "all", futureWidth, setViewMs: useTimeView.getState().setViewMs }, strips && axisReady, drawing);
  onNow.current = strip.onNow;
  const { pieces, seen, to } = strip;
  const fullScale = useMemo(() => {
    if (!strips) return null;
    const duration = Math.max(0, now - earliest);
    const air = Math.max(MINUTE, duration * 0.06);
    const fullViewMs = Math.max(20 * MINUTE, duration + 2 * air);
    const full = stripAxis({ from: startAt, end: () => now, now, busy: axisBusy, viewMs: fullViewMs, futureWidth }, strip.screen);
    return shownScaleMs(full, strip.layout, futureWidth);
  }, [strips, earliest, now, axisBusy, futureWidth, strip.screen, strip.layout]);
  useEffect(() => {
    if (!seen || !needsTimeline) return;
    setWindowRange((old) => timelineWindow(old, seen));
  }, [seen, needsTimeline]);
  const scale = useMemo<Scale>(() => ({ x: (at) => xOf(pieces, at), from: pieces[0]?.from ?? from, to, width: strip.width }), [pieces, from, to, strip.width]);
  const showAll = () => rowNodes.length && strip.showAll(earliest, now);
  // If nothing has happened in the current window, initially fit the acquired chronology.
  const settled = useRef(false);
  useEffect(() => { strip.restart(); settled.current = false; }, []);
  useEffect(() => {
    // Fitted to the list's own axis, never to one standing in for it.
    if (!seen || !axisReady || axis.standIn || settled.current) return;
    settled.current = true;
    const happens = earliest >= seen.from && earliest <= seen.to
      || axisBusy.some(([from, to]) => (to ?? now) >= seen.from && from <= seen.to);
    if (rowNodes.length && !happens) showAll();
  }, [seen, axis.standIn]);
  const nowSeen = !seen || seen.to >= now;
  // Once its rows, and the time on their strips where strips are shown, are drawn.
  useListEntrance(box, entering, rowNodes.length > 0 && (!strips || axisReady && visibleIds.length > 0), lead);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => stripKeys(event, strip, showAll,
    (box.current?.getBoundingClientRect().left ?? 0) + lead + strip.screen / 2);
  const shared = useMemo<Shared>(() => ({ drawing, index, people, timePeople, narrow, selected: readerOpen ? selected : null,
    screen: strip.screen, lead, lane, strips: strips && axisReady }),
    [drawing, index, people, timePeople, narrow, readerOpen, selected, strip.screen, lead, lane, strips, axisReady]);
  const stripRef = useRef(strip);
  stripRef.current = strip;
  const showTime = useMemo(() => (start: number, end: number) => stripRef.current.show(start, end), []);
  const rowTime = useMemo<RowTime>(() => ({ histories, scale, pieces, now, seen, show: showTime }),
    [histories, scale, pieces, now, seen, showTime]);
  // A pull briefly opens a new stream itself. As with the progress line, only the shown offline state
  // disables it: a blip is treated as the progress line treats it, and the hook owns ending any pull when it is disabled.
  usePullToRefresh(box, sheetRef, markRef, narrow && !offlineShown, () => useConnection.getState().refresh());
  // A phone has one 44px clock row (h-11, which grows with the reader's text size as the clock does); only an actual
  // clock row reserves its own height.
  // A list with no section drawn has no time to read: no clock row and no ground either.
  const empty = sections.length === 0;
  const k = textScale(), row = 44 * k;
  const head = empty ? 0 : !narrow ? clockHeight(k) + 1 : strips ? row + 1 : 0;

  // The frozen top and columns layer inside this isolated sheet.
  return (
    <ListScroll ref={box} data-time-tree style={{ scrollPaddingTop: `calc(var(--bar-in) + ${head}px)`, ...narrow && { overscrollBehaviorY: "none" } }} tabIndex={0} onKeyDown={strips ? keys : undefined} aria-description={strips ? t("timeView.help") : undefined}
      className="isolate outline-none focus-visible:ring-1 focus-visible:ring-line">
      <div className="sticky left-0 w-0"><BarRoom /></div>
      <div ref={sheetRef} style={{ width: lead + strip.width, "--head": `${head}px` } as CSSProperties} className="relative min-w-full">
        {strips && axisReady && !narrow && !empty && <Ground pieces={pieces} width={strip.width} now={now} lead={lead} seen={seen} />}
        {narrow && <div style={frozen(shared)} className="sticky left-0 h-0"><PullMark mark={markRef} /></div>}
        {/* The frozen top: the title column and the clock over the strip, kept under what is left
            of the bar over the list. */}
        {head > 0 && <div className={cn("sticky top-(--bar-h) translate-y-[calc(var(--bar-in)-var(--bar-h))] z-20 flex border-b border-rule bg-bg transition-transform duration-(--motion-base) ease-(--bar-ease) motion-reduce:transition-none", narrow && "flex-col")}>
          {(!narrow || strips) && <div data-time-corner style={{ width: narrow ? strip.screen : lead }}
            className={cn("sticky left-0 z-10 flex flex-none items-center gap-2 bg-bg px-1 text-xs text-muted", narrow ? "h-0" : "h-7.5 border-r border-rule")}>
            {strips && !nowSeen && <button type="button" data-to-now onClick={strip.toNow}
              className="ml-auto flex flex-none items-center gap-0.5 rounded-sm px-1 font-medium text-ink hover:bg-hover narrow:absolute narrow:top-full narrow:right-0 narrow:ml-0 narrow:min-h-11 narrow:min-w-11 narrow:justify-center narrow:bg-bg">{t("timeView.toNow")}<Icon name="right" className="size-3" /></button>}
            {fullScale !== null && <Period pieces={pieces} screen={strip.screen} layout={strip.layout} futureWidth={futureWidth} fullScale={fullScale}
              onScale={strip.toScale} onShowAll={showAll} />}
          </div>}
          {strips && <div className="flex-none narrow:flex narrow:h-11 narrow:items-center"><TimeClock place="list" pieces={pieces} width={strip.width} now={now} onShowAll={showAll} seen={seen} inset={narrow && !nowSeen ? 72 * k : 0} insetStart={narrow ? MOBILE_PERIOD_W * k : 0} /></div>}
        </div>}
        {/* Only when no axis is drawn. Out of reach with none read here it says the axis is not on this device, not the
            failure again; an axis drawn in its stead (one read earlier, out of reach only) needs no note. */}
        {axis.error && !axisReady && <div style={frozen(shared)}>{offline ? <ReadNote kind="absent" className="px-1 py-1.5">{t("timeView.axisAbsent")}</ReadNote>
          : <ReadFailure error={axis.error} retry={axis.retry} />}</div>}
        {/* A failed strip read must not move its rows and thereby change which rows are read. */}
        {needsTimeline && windowRange !== null && <div data-timeline-read
          style={{ ...frozen(shared), top: `calc(var(--bar-in) + ${head}px)` }} className="sticky left-0 z-30 h-0">
          <div className="bg-bg">{timeline.absent ? <ReadNote kind="absent" className="py-1.5 pr-2 pl-4" />
            : timeline.error && !offline && <ReadFailure error={timeline.error} retry={timeline.retry} />}</div>
        </div>}
        <RowTimeContext.Provider value={rowTime}>
          {<>
            {sections.map((section, at) => <Fragment key={section.section}>
              <SectionHead section={section} first={at === 0} shared={shared} onToggle={() => toggleSection(section.section, section.open)} />
              <Rows group={section.tree} shared={shared} visibleRows={visibleRows} />
              {section.section === "done" && section.open && <div className="bg-bg"><PageTail page={finished} read={finishedRead} sentinel={finishedSentinel} shared={shared} /></div>}
              {section.hidden !== null &&
                <div data-group-more={section.section} data-motion-key={`more:${section.section}`} className="border-b border-rule">
                  <div style={frozen(shared)} className={cn("sticky left-0 bg-bg pl-list-text", columnEdge(shared))}>
                    <button type="button" aria-expanded={section.hidden === 0} onClick={() => setMore((was) => was.has(section.section) ? without(was, section.section) : new Set(was).add(section.section))}
                      className="flex min-h-8 items-center gap-1 pr-2 text-sm text-muted hover:text-ink narrow:min-h-11">
                      {section.hidden > 0 ? t("home.more", { count: section.hidden }) : t("home.less")}</button>
                  </div>
                </div>}
              {section.section === "done" && section.open && <div className="bg-bg"><div data-time-shelved style={frozen(shared)} className="sticky left-0 py-1">
                <ul className="m-0 list-none p-0"><ShelvedRow /></ul></div></div>}
            </Fragment>)}
          </>}
        </RowTimeContext.Provider>
        {/* The rule down the sheet at the pointed time; on a narrow screen the titles lie across the strips, so the clock alone says it. */}
        {!narrow && <ProbeRule place="list" pieces={pieces} lead={lead} scroller={box} />}
        {/* In the sheet a pull moves; as wide as the list's box, whatever the strip's width. */}
        {welcome && <div style={{ width: sheet }} className="sticky left-0"><Welcome /></div>}
      </div>
    </ListScroll>
  );
}

const Rows = memo(function Rows({ group, shared, visibleRows }: { group: Group; shared: Shared; visibleRows: ReadonlySet<string> | null }) {
  return <ol className="relative m-0 list-none p-0">
    {group.nodes.map((node) => <TaskRow key={node.task.id} node={node} shared={shared} visibleRows={visibleRows} />)}
  </ol>;
});

function PageTail({ page, read, sentinel, shared }: { page: PageRead; read: ReadView; sentinel: RefObject<HTMLDivElement | null>; shared: Shared }) {
  return <div ref={sentinel} data-page-tail style={frozen(shared)} className="sticky left-0 min-h-2 text-xs text-muted">
    {(page.isPending && page.isFetching || page.isFetchingNextPage) && <RegionSkeleton shape="rows" />}
    <PageReadFailure page={page} read={read} />
  </div>;
}

/**
 * A page list's rows as its own Query holds them, when that list is shown but is no longer the latest (read-model: an
 * active obsolete read, display without project). They keep their acquired rows and never join the
 * workspace's rows, counts, chronology or what is read (serverReadFacts projects current lists alone).
 */
const datedTasks = new WeakMap<TaskPageRowDTO, Task>();
function useDatedRows(data: InfiniteData<TaskProjectedPageDTO> | undefined, assessment: ReadAssessment): ReadonlyMap<string, Task> | null {
  const dated = isDatedRead(assessment);
  return useMemo(() => {
    if (!data || !dated) return null;
    const rows = new Map<string, Task>();
    for (const page of data.pages) for (const row of page.rows) {
      let task = datedTasks.get(row);
      if (!task) { task = rowTask(pageRow(row)); datedTasks.set(row, task); }
      rows.set(row.id, task);
    }
    return rows;
  }, [data, dated]);
}

/**
 * A heading's line: its square, name, count and way in on one baseline, the marks centred on the words' capitals. On a phone it is a finger's 44px, and its words sit
 * low in it, 6px over the rule as on a computer (h-8 pb-1.5), so a heading stands with the rows under it, not halfway
 * between the groups. The 44px and the rule are the heading's height either way.
 */
const HEAD_LINE = "flex items-center gap-1.5 narrow:min-h-11 narrow:pt-3 narrow:pb-0.5";
const HEAD_PRESS = "rounded-sm hover:underline hover:underline-offset-3 active:text-muted";
/** A section's colour, on the small square before its name (system.md: the name itself is in ink), so every name starts on one line. */
const SECTION_MARK: Record<HomeSection, string> = { error: "bg-error", review: "bg-turn", awaited: "bg-muted", held: "bg-muted", doing: "bg-working", todo: "bg-todo", done: "bg-done" };

/**
 * A section's heading: its name and how many. A section with none is not drawn. Pressing the heading opens or closes the section, every section alike.
 */
function SectionHead({ section, first, shared, onToggle }: { section: Section; first: boolean; shared: Shared; onToggle: () => void }) {
  const { t } = useTranslation("tree");
  const name = { doing: t("home.running"), error: t("home.error"), review: t("home.turn"), awaited: t("home.awaited"), held: t("home.held"), todo: t("home.todo"), done: t("home.finished") }[section.section];
  return <div data-section={section.section} data-motion-key={`section:${section.section}`} className="flex border-b border-rule">
    <div style={frozen(shared)} className={cn("sticky left-0 flex h-8 bg-bg pl-list-text items-baseline-last pb-1.5 text-base font-semibold text-ink narrow:h-11 narrow:items-center narrow:pb-0",
      !first && "h-12 pt-4 narrow:h-13 narrow:pt-2", columnEdge(shared))}>
      {/* Its words, the name's and the agents' and speed's after it, stand on one baseline (the line's last, so the
          heading still ends 6px over the rule); its marks centre on the capitals of the words beside them (CapCentred). */}
      <h2 className="m-0 flex min-w-0 flex-1 items-baseline pr-2 text-base font-semibold">
        <button type="button" aria-expanded={section.open} onClick={onToggle} className={cn(HEAD_LINE, HEAD_PRESS, "flex-none")}>
          <span className="flex items-baseline gap-1.5">
            {/* The square stands on the list's mark line, where a row's unread dot does; the name starts on the rows' icons. */}
            <TextMark className="-mr-1.5 w-0">
              <i className={cn("relative left-[calc(var(--spacing-list-mark)-var(--spacing-list-text))] size-2 flex-none -translate-x-1/2 rounded-xs", SECTION_MARK[section.section])} />
            </TextMark>
            <span>{name}</span>
            <span className="font-normal tabular-nums text-muted">{section.count}</span>
            <TextMark><Icon name="right" className={cn("size-3 text-muted transition-transform motion-reduce:transition-none", section.open && "rotate-90")} /></TextMark>
          </span>
        </button>
        {section.section === "done" && <TodayMarks />}
        {section.section === "doing" && <span className="ml-auto flex min-w-0 shrink items-baseline narrow:pr-1.5"><HeadingAgents tops={sectionTops(section)} narrow={shared.narrow} timeApart={shared.lane > 0} /></span>}
      </h2>
      {shared.lane > 0 && section.section === "doing" && <SpeedLane width={shared.lane} className={cn(shared.lane < SPEED_LANE && "pr-3")}><HeadingTokenSpeed tops={sectionTops(section)} compact={shared.lane < SPEED_LANE} /></SpeedLane>}
      {shared.lane > 0 && section.section === "doing" && <RowTimeRoom>{shared.lane < SPEED_LANE && <HeadingSpeedUnit tops={sectionTops(section)} />}</RowTimeRoom>}
    </div>
  </div>;
}

/** The section's rows that no other row in it holds. */
function sectionTops(section: Section) {
  const ids = new Set(section.tree.nodes.map(({ task }) => task.id));
  return section.tree.nodes.filter(({ task, path }) => !path.some((id) => id !== task.id && ids.has(id))).map(listedTask);
}

/**
 * The title column's edge on a computer: one line down the whole list, through the headings and the "N more" lines as
 * through the rows, so the titles and the time read as two panes. A phone's rows lie across the strips and have none.
 */
const columnEdge = (shared: Shared) => !shared.narrow && "border-r border-rule";
/** What stays at the left while the strip scrolls: as wide as the title column, or the screen on a narrow one. */
const frozen = (shared: Shared) => ({ width: shared.narrow ? shared.screen : shared.lead });

type TaskRowProps = { node: Node; shared: Shared; visibleRows: ReadonlySet<string> | null };
const sameRowItems = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, at) => item === b[at]);
const sameRowScope = (a: TaskRowProps, b: TaskRowProps) => {
  const id = a.node.task.id;
  if (id !== b.node.task.id || a.node.task !== b.node.task ||
    a.node.lifted !== b.node.lifted || a.node.row !== b.node.row || a.node.dated !== b.node.dated || !sameRowItems(a.node.path, b.node.path)) return false;
  const x = a.shared, y = b.shared;
  if (!sameDrawingSource(x.drawing, y.drawing) || x.narrow !== y.narrow || x.screen !== y.screen || x.lead !== y.lead || x.lane !== y.lane || x.strips !== y.strips ||
    (x.selected === id) !== (y.selected === id) ||
    (a.visibleRows?.has(id) ?? true) !== (b.visibleRows?.has(id) ?? true)) return false;
  // Node props and viewport membership live outside Shared and must be checked first.
  // With the same Shared, its subtree, counts and chronology are the same inputs.
  if (x === y) return true;
  // A home row's own subtree supplies its progress and rolled-up marks. A change
  // elsewhere in the index does not change its label or its strip.
  const before = [a.node.task, ...descendants(id, x.index)];
  const after = [b.node.task, ...descendants(id, y.index)];
  if (!sameRowItems(before, after)) return false;
  for (const task of before) {
    const taskId = task.id;
    const left = x.index.childCounts?.[taskId], right = y.index.childCounts?.[taskId];
    if (left?.live !== right?.live || left?.finished !== right?.finished) return false;
    if (x.timePeople !== y.timePeople) {
      const beforeRuns = x.timePeople?.runsByTask.get(taskId), afterRuns = y.timePeople?.runsByTask.get(taskId);
      if (x.timePeople?.tasks.get(taskId) !== y.timePeople?.tasks.get(taskId) ||
        (beforeRuns?.length ?? 0) !== (afterRuns?.length ?? 0) ||
        beforeRuns?.some((run, at) => run !== afterRuns?.[at])) return false;
    }
  }
  for (const ancestor of a.node.path) if (x.index.byId.get(ancestor) !== y.index.byId.get(ancestor)) return false;
  return true;
};

const TaskRow = memo(function TaskRow({ node, shared, visibleRows }: TaskRowProps) {
  const { t: pt } = useTranslation("people");
  const { index, narrow } = shared;
  const { path } = node;
  const task = listedTask(node);
  const titleKeys = useTitleKeys(task);
  const label = useRef<HTMLDivElement>(null);
  useTint(label, `row:${task.id}`, task.hash, shared.drawing);
  const title = useRef<HTMLButtonElement>(null);
  const endId = useId(), timeId = useId();
  // A working row beside the speed column says its time at the row's end (RowTime), outside its end's words.
  const timeApart = shared.lane > 0 && node.row?.section === "doing";
  const enter = useRef<(() => void) | null>(null);
  const look = useTaskLook(task);
  const stateWord = look.word;
  // The title column and strip have the same height; a wide row is always WIDE_ROW.
  const h = narrow ? NARROW_STRIP_LEVEL.height : WIDE_STRIP_LEVEL.height;
  // A home row's summary is the server's: its children finished of all. A row without a home summary uses the index's child
  // counts.
  const summary = node.row?.summary ?? null;
  const hasChildren = childrenOf(task.id, index).length > 0
    || ((index.childCounts?.[task.id]?.live ?? 0) + (index.childCounts?.[task.id]?.finished ?? 0) > 0);
  const progress = summary ? summary.total > 0 ? summary : null : hasChildren ? childProgress(task.id, index) : null;
  // A computer's row takes one ground under its title and its time: the picked row's, or a thinner one while pointed at.
  const picked = !narrow && shared.selected === task.id;
  const ground = picked ? "bg-row-picked-solid" : narrow ? "bg-bg" : "bg-bg group-hover:bg-row-hover-solid";
  const people = usePeopleFor(task.id, true);
  const displayLook = look;
  // A dot for what changed since it was read. It hangs left of the row's first line, centred on the
  // list's mark line as a heading's square is, so the state icons start on one vertical line whether a row is read or not.
  const readHere = useReadIdsFor(task.id).has(task.id);
  const unreadTask = !node.dated && !readHere;
  const unread = unreadTask && <i aria-hidden="true" data-unread
    className={cn("size-1.5 -translate-x-1/2 rounded-full bg-changed", narrow ? "block" : "absolute top-1/2 left-list-mark -translate-y-1/2")} />;
  // The title's press, in either form: it opens the task and carries the row's keys.
  const press = (content: ReactNode, className: string, describedBy?: string) => <button ref={title} type="button" data-read={task.id} onClick={() => openDetail(task.id)}
    aria-describedby={describedBy}
    onKeyDown={(event) => {
      if (event.key === "ArrowRight" && enter.current) { event.preventDefault(); enter.current(); }
      else titleKeys(event);
    }}
    className={className}>{content}</button>;
  return (
    <li data-row={task.id} data-row-section={node.row?.section} data-row-turn={node.row?.section === "review" ? turnKind(task) : undefined} data-depth={0} data-held={task.state === "held" || undefined} data-dated={node.dated || undefined}>
      <div data-row-head data-motion-key={task.id}
        className={cn("group relative flex border-b border-rule", narrow && "flex-col",
          picked ? "bg-row-picked [--row-ground:var(--color-row-picked-solid)]"
            : !narrow && "hover:bg-row-hover hover:[--row-ground:var(--color-row-hover-solid)]")}>
        <div ref={label} data-row-label style={narrow ? frozen(shared) : { ...frozen(shared), height: h }}
          className={cn("sticky left-0 z-2 flex flex-none items-stretch overflow-hidden", ground,
          columnEdge(shared), narrow && shared.selected === task.id && "ring-1 ring-muted ring-inset")}>
          {/* A row lifted away from its parent says that parent once, before its id. */}
          {narrow ? <RowLines task={task} people={people} unread={unread}
            lifted={node.lifted && path.length ? path.at(-1)! : null}
            counts={progress && <span data-row-progress className="flex-none">{pt("line.children", { done: progress.done, total: progress.total })}</span>}
            // On a phone the whole row is the title's press (44px and more), under the fold box.
            title={(content, layout, describedBy) => press(content, cn(layout, "narrow:after:absolute narrow:after:inset-0 narrow:after:content-['']"), describedBy)} />
          : <div className="relative flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 pl-list-lead">
            {unread}
            <span title={stateWord} className="relative flex flex-none">
              <Icon name={displayLook.icon} className={cn("size-list-icon", TONE[displayLook.tone])} aria-label={stateWord} />
              <SentArc task={task} />
            </span>
            {press(<>
              <RowProjectTile project={task.projectId} />
              <TaskId id={task.id} className="flex-none text-xs tabular-nums text-muted cap-box" />
              {/* The title keeps about half the line; what stands at its end (the agents first) gives way. */}
              <RowTitle title={task.title} className="min-w-[45%] flex-1 text-base text-ink" />
            </>, "flex min-w-[45%] flex-1 items-center gap-1.5 text-left after:absolute after:inset-0 after:content-['']", timeApart ? `${endId} ${timeId}` : endId)}
            {/* The row's one time at its end, with what is so of its state before it. It stands beside the press, as its time
                is a press of its own; the press's cover lies over the rest of it, so a press there still opens the task. */}
            <RowEnd id={endId} task={task} childCount={progress ? `${progress.done}/${progress.total}` : null}
              timeApart={timeApart} />
          </div>}
          {shared.lane > 0 && node.row?.section === "doing" && <>
            <SpeedLane width={shared.lane} className={cn("items-center", shared.lane < SPEED_LANE && "pr-3")}><RowTokenSpeed task={task} compact={shared.lane < SPEED_LANE} /></SpeedLane>
            <RowTime id={timeId} task={task} />
          </>}
        </div>
        {shared.strips && (visibleRows === null || visibleRows.has(task.id)
          ? <RowStrip node={node} shared={shared} height={h} title={title} enter={enter} />
          : <EmptyStrip height={h} />)}
      </div>
    </li>
  );
}, sameRowScope);

function EmptyStrip({ height }: { height: number }) {
  const { scale } = useRowTime();
  return <svg data-time-strip width={scale.width} height={height} className="block flex-none" aria-hidden="true" />;
}

/**
 * A row's title, in every form a row takes (a phone's one- and two-line rows, a computer's): one line that runs to the
 * row's right edge and is cut there with "…". A line clamp would wrap first and break a long Latin word ("main-conversation")
 * only at its own breaks, leaving the line short before its "…". The form sets the size, weight and colour.
 */
function RowTitle({ title, className }: { title: string; className?: string }) {
  return <span data-row-title className={cn("min-w-0 cap-truncate", className)}>{title}</span>;
}

function openDetail(id: string, key?: string, returnTo?: HTMLElement) {
  useTimeView.getState().pick(id, key ?? null);
  useViewStore.getState().openTask(id, { reader: true, pane: "task", event: key ?? null, returnTo });
}

/** A node's task as its row in the home list is drawn: with the section the row is listed in. */
const listedTask = (node: Node): Task => node.row ? { ...node.task, homeRow: node.row } : node.task;

/** A row's end words on its strip: none on an Awaiting review row (saysRuns), whose icon says the review. */
const stripFinish = (node: Node, finish: FinishWords | null) => saysRuns(listedTask(node)) ? finish : null;

/** The clock and moving scale reach only the strip; the row's controls keep their identity. */
function RowStrip({ node, shared, height, title, enter }: { node: Node; shared: Shared; height: number;
  title: RefObject<HTMLButtonElement | null>; enter: RefObject<(() => void) | null> }) {
  const { histories, scale, pieces, now, seen, show } = useRowTime();
  return <Strip node={node} narrow={shared.narrow} height={height} title={title} enter={enter} history={histories?.get(node.task.id) ?? null}
    scale={scale} pieces={pieces} now={now} seen={seen} show={show} />;
}

// The line stands low in the row, so the room above it shows how many work at once; its marks and words sit on it.
const NARROW_STRIP_LEVEL: Readonly<Level> = { height: 22, base: 16, unit: 7, rise: 13 };
const WIDE_STRIP_LEVEL: Readonly<Level> = { height: WIDE_ROW, base: 22, unit: 10, rise: 18 };

/** One row's line, drawn again only when its own history or the shared clock and scale change. */
const Strip = memo(function Strip({ node, narrow, height, title, enter, history, scale, pieces, now, seen, show }: { node: Node; narrow: boolean; height: number;
  title: RefObject<HTMLButtonElement | null>; enter: RefObject<(() => void) | null>; history: TaskHistory | null } & Omit<RowTime, "histories">) {
  const { t } = useTranslation("tree");
  const { t: pt, i18n } = useTranslation("people");
  const { task } = node;
  const finish = stripFinish(node, useFinishWords(task.id));
  const strip = useRef<SVGSVGElement>(null);
  const line = useMemo(() => lineOf(history, now, scale), [history, now, scale]);
  const marks = useMemo(() => laneMarks(history), [history]);
  const open = (key?: string) => openDetail(task.id, key);
  const reportAt = (time: number) => stretchReport(line.stretches, lineReports(history), time, now);
  const probe = useStripProbe({ place: "list", row: task.id, pieces, stretches: line.stretches, hands: line.hands, now,
    back: () => title.current?.focus() });
  useLayoutEffect(() => {
    enter.current = history ? () => { if (strip.current) probe.enter(strip.current); } : null;
    return () => { enter.current = null; };
  }, [enter, history, probe.enter]);
  const level = narrow ? NARROW_STRIP_LEVEL : WIDE_STRIP_LEVEL;
  const clock = (at: number) => dayClock(at, now, pt, i18n.language);
  const turn = useMemo(() => rowTurn(task), [task]);
  const edge = history && seen ? edgeOf(task, history, line.hands, marks, seen, now, scale, turn) : null;
  // The turn's note keeps clear of now's rule: on a strip too narrow for "From …" it writes the time alone, or only its
  // icon. The room is judged by a long time ("yesterday 13:56"), not the row's own, so every row writes the same form.
  const turnNote = (at: number) => {
    const room = seen ? scale.x(Math.min(now, seen.to)) - scale.x(seen.from) - 40 : 0, k = textScale(), long = clock(now - 26 * HOUR);
    return wordsW(t("timeView.edge.since", { time: long }), k) <= room ? t("timeView.edge.since", { time: clock(at) })
      : wordsW(long, k) <= room ? capitalized(clock(at)) : "";
  };
  return <svg ref={strip} data-time-strip width={scale.width} height={height} tabIndex={-1} className="flex-none cursor-pointer outline-none"
    onClick={(event) => { const hit = reportAt(atOf(pieces, event.clientX - event.currentTarget.getBoundingClientRect().left));
      open(hit?.event.key); }} {...probe.strip}
    role="img" aria-label={[task.title, finish?.long].filter(Boolean).join(", ")}>
    <rect x={0} y={0} width={scale.width} height={height} fill="transparent" />
    {narrow && <StripGround pieces={pieces} width={scale.width} height={height} now={now} />}
    {history && <Lane line={line} marks={marks} scale={scale} level={level} now={now} turnFrom={turn?.at ?? null}
      finish={finish} onPick={(key) => { probe.mark.hide(); open(key); }} probe={probe.mark} />}
    {edge && seen && (edge.kind === "turn" ? <TurnEdge turn={edge.turn} x={scale.x(seen.from) + 14} y={level.base}
      onPick={() => { probe.mark.hide(); open(edge.turn.key); }} probe={probe.mark} words={turnNote(edge.turn.at)}
      heard={t("timeView.edge.turn", { kind: edge.turn.why === "question" ? t("ui:turn.question") : t("ui:state.waitingReview"), time: clock(edge.turn.at) })} />
      : <EdgeNote edge={edge} x={edge.side === "left" ? scale.x(seen.from) + 6 : scale.x(seen.to) - 6} y={level.base} clock={clock}
        onGo={() => show(edge.go[0], edge.go[1])} />)}
  </svg>;
});

type Edge = { side: "left" | "right"; kind: "done" | "stopped" | "todo" | "quiet" | "starts"; at: number; go: [number, number] }
  | { side: "left"; kind: "turn"; turn: RowTurn };
const overlaps = (segment: { from: number; to: number }, seen: { from: number; to: number }) => segment.to >= seen.from && segment.from <= seen.to;

/**
 * What a row writes at the strip's edge, or null when its line says it on screen: work, a mark, or a wait (for you,
 * a stop, children) inside what is shown.
 */
export function edgeOf(task: Task, own: TaskHistory, hands: Segment[], marks: MarkAt[], seen: { from: number; to: number }, now: number, scale: Pick<Scale, "x" | "from" | "to">, turn: RowTurn | null): Edge | null {
  const start = own.start;
  let last = start;
  for (const event of own.events) last = Math.max(last, event.at);
  for (const segment of own.segments) if (isHand(segment)) last = Math.max(last, segment.to);
  if (isFinished(task.state)) {
    const end = own.end ?? last;
    return end < seen.from ? { side: "left", kind: task.state === "done" ? "done" : "stopped", at: end, go: [start, end] } : start > seen.to ? { side: "right", kind: "starts", at: start, go: [start, end] } : null;
  }
  if (start > seen.to) return { side: "right", kind: "starts", at: start, go: [start, Math.min(now, last)] };
  if (task.state === "todo" && !hands.length) return { side: "left", kind: "todo", at: start, go: [start, now] };
  // What the turn waits on: its edge note takes over only when the whole glyph has left the view.
  if (turn && scale.x(turn.at) + 9 <= scale.x(seen.from)) return { side: "left", kind: "turn", turn };
  const shown = hands.some((hand) => overlaps(hand, seen)) || marks.some(({ event }) => event.at >= seen.from && event.at <= seen.to)
    || own.segments.some((segment) => !isHand(segment) && overlaps(segment, seen));
  if (shown) return null;
  if (last >= seen.from) return null;
  // A turn's mark that a fold holds at the screen's edge is still the row's note, not its last movement.
  return turn && turn.at < seen.from ? { side: "left", kind: "turn", turn }
    : { side: "left", kind: "quiet", at: last, go: [Math.max(start, last - 3_600_000), last] };
}


/**
 * The edge's note, with the state icon the title column uses, on the row's ground so the line under it does not run through.
 * The icon says the state, so the row writes only its time; the state's word stays in what is heard and pointed at.
 */
function EdgeNote({ edge, x, y, clock, onGo }: { edge: Exclude<Edge, { kind: "turn" }>; x: number; y: number; clock: (at: number) => string; onGo: () => void }) {
  const { t } = useTranslation("tree");
  const state = edge.kind === "done" || edge.kind === "stopped" || edge.kind === "todo" ? edge.kind : null;
  const left = edge.side === "left";
  const time = clock(edge.at);
  // Alone (beside a state icon, or as the whole quiet note) the time is a label: "Yesterday 16:51".
  const label = capitalized(time);
  const since = t("timeView.edge.since", { time });
  const heard = edge.kind === "done" ? t("timeView.edge.done", { time })
    : edge.kind === "stopped" ? t("timeView.edge.stopped", { time })
    : edge.kind === "todo" ? t("timeView.edge.todo", { time })
    : edge.kind === "quiet" ? label
    : since;
  const words = edge.kind === "todo" ? since : state ? label : heard;
  const text = left ? (state ? words : `‹ ${words}`) : `${words} ›`;
  const textX = left && state ? x + 15 : x;
  return <EdgeLayer><StripPress onPress={onGo} attributes={{ "data-edge": edge.kind }} className="group/edge">
    <title>{t("timeView.edge.go", { note: heard })}</title>
    {state && <>
      <circle cx={x + 6} cy={y} r={7.5} className="fill-[var(--row-ground,var(--bg))]" />
      <StateIcon state={state} x={x} y={y - 6} width={12} height={12} />
    </>}
    <text x={textX} y={y + 3.5} textAnchor={left ? "start" : "end"} strokeWidth={EDGE_HALO} paintOrder="stroke" strokeLinejoin="round"
      className={cn("text-xs tabular-nums group-hover/edge:fill-ink group-focus-visible/edge:fill-ink", "stroke-[var(--row-ground,var(--bg))]",
        state ? "fill-trail" : "fill-muted")}>{text}</text>
  </StripPress></EdgeLayer>;
}

/**
 * Whether a list row stands in the home list's Done section, by the home list's own rule (contract/home): a listed (active)
 * task right below its project, neither held nor waiting on the user, whose own state is finished.
 */
export function doneRow(task: Pick<Task, "kind" | "parent" | "hold" | "ball" | "baseState"> | undefined): boolean {
  return !!task && task.kind === "task" && task.parent === null && !task.hold
    && userTurn(task.ball) === null && isFinished(task.baseState);
}
