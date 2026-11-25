import { useLineClip, wholeLinesHeight } from "@/lib/use-line-clip";
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { orderRecordWords } from './StartOrder';
import { readQuery } from '@/data/read-model';
import { holdHistory, type HistoryReader } from '@/data/history-window';
import { historyCursor } from '@alpacawork/contract';
import { taskStatement } from '@alpacawork/contract/coordinator';
import { answerBodyFiles } from "@/features/coordinator/MessageFiles";
import { markdownMedia, markdownMediumId } from "@/domain/markdown";
import { errorText } from "@/data/client";
/* Hallmark · component: report feed · genre: modern-minimal · theme: existing app tokens
 */
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject, useDeferredValue } from "react";
import { followReference, noteReaderRows, readerHistoryPosition } from "@/state/reader-position";
import { usePeopleFor, useTaskHistory } from "@/data/queries";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { compareHistoryEvents, inGallery, reportEmbed } from "@alpacawork/contract";
import type { ControlRunDTO, HistoryCrewDTO, TaskHistoryDTO } from "@alpacawork/contract/control";
import { Button } from "@/components/ui/button";
import { PendingRegion } from "@/components/ui/loadable";
import { Message } from "@/components/ui/message";
import { beforeWork } from "@/domain/before-work";
import { resultLine } from "@/domain/report-labels";
import { causeReason, limitName } from "@/domain/run-labels";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { ON_RAIL, TimelineMark } from "@/components/ui/timeline-mark";
import { TONE, stateWord } from "@/components/ui/tone";
import { Icon, type IconName } from "@/components/ui/icon";
import { TextMark } from "@/components/ui/text-mark";
import { CopyButton } from "@/components/ui/copy-button";
import { taskFileUrl } from "@/data/task-file-url";
import { useTaskNames, useWorkspaceInfo, useWriteDisabled, useReadState } from "@/data/queries";
import { resources } from "@/data/resources";
import { usePageSentinel } from "@/data/page-sentinel";
import type { TaskDetail, TaskState } from "@/data/types";
import { isCurrentWait } from "@/domain/pending-report";
import { FINISH_MARK, firstReportMedia, isInstruction, reportEvent, reportTone, turnRecord, type ReportEvent } from "@/domain/report-events";
import { endAgents } from "@/domain/end-agent";
import { answerLine, historyRows, recordKey, rowTargets, sameRow, type HistoryRow, type NameEnd, type RowOutcome } from "@/domain/history-rows";
import { crewOf, type PeopleIndex } from "@/domain/people";
import { childWork, working, type ChildWork } from "@/domain/working";
import { isMedia } from "@/domain/task-files";
import { sameCalendarDay } from "@/domain/time";
import { dayClock, dayClockLabel, dayHeading } from "@/domain/day-clock";
import { useToday } from "@/state/clock";
import { agentModelName, modelLabel, peopleAgentNames, placementAgentLabel, runAgentLabel, samePeopleAgentNames, visibleAgentNames, type ModelName } from "@/domain/agent-label";
import { useActivityText, useDuration } from "@/features/people/labels";
import { StepList, WorkLine, stepCount, useRunSteps } from "@/features/people/RunSteps";
import { AgentLabel } from "@/features/people/AgentLabel";
import { ContextMeter } from "@/features/people/ContextMeter";
import { sameForFeed } from "@/domain/people";
import { reportCopy, taskCopy, textClip } from "@/lib/clipboard";
import { finishedBy } from "@/domain/tasks";
import { eventKey, logKey, type HistoryEvent } from "@/domain/history";
import { duration, easing, reducedMotion, useListMotion } from "@/lib/motion";
import { useTimeView } from "@/state/time-view";
import { useDialogStore } from "@/state/dialog-store";
import { useViewStore } from "@/state/view-store";
import { MarkdownBody, type GalleryImage, type MarkdownTask } from "./MarkdownBody";
import { fenceLabel } from "./embeds";
import { UrlImageSlider } from "./ImageSlider";
import { ReportBody } from "./ReportBody";
import { FeedTask, FeedWaitingActions } from './WaitingReportActions';
import { questionReports } from '@/domain/question-reports';
import { reviewReports } from '@/domain/review-reports';
import { AttachmentCards } from "./Attachments";
import { splitAttachments } from "@/domain/attachments";
import { TaskAbout } from "./TaskAbout";
import { MediaThumb } from "./TaskMedia";
import { ReadFailure, ReadNote } from "@/components/ui/loadable";
import { useConnection } from "@/data/connection";
import { scrollReport } from "./scroll-report";
import { keepPressedRow } from "./reading-position";

/** A report: its row opens as the one card open, the newest standing open until one is pressed. A member's words are worked on, not reported. */
const isCard = (report: ReportEvent) => !!(report.mark || report.userQuestion) && report.author?.kind !== "member";
/**
 * A quiet record that can stand open when no story is present. Shared with window protection. A dialogue stands where
 * it holds the Coordinator's words (the record with its reply, or the reply's row), not where its body is your words.
 */
/** A row says more open than who it was between: its words, a note, a question, causes, its repeats. Only such a row stands open unpressed. */
const saysMore = (row: HistoryRow) => Boolean(row.report.description || row.report.note || row.report.question || row.report.causes?.length || row.sameTitle || row.older.length);
const canStand = (report: ReportEvent) => !report.mark && !report.changed && !!report.description
  && ((report.by !== undefined && (isInstruction(report) || report.kind === "answer")) || report.kind === "dialogue" && (report.replyTo !== undefined || report.description !== report.text));

const sameImage = (a: GalleryImage, b: GalleryImage) => a.id === b.id && a.src === b.src && a.path === b.path && a.alt === b.alt
  && a.reportKey === b.reportKey && a.source === b.source;
const sameGallery = (drawn: GalleryImage[], next: GalleryImage[]) => drawn.length === next.length && drawn.every((image, at) => sameImage(image, next[at]!)) ? drawn : next;

/** A closed row's picture: under its ⌄ from the words' line, never up across it, its foot reaching into the head's own
 * room below (FEED_THUMB_FOOT) so a one-line row is no taller; its column keeps the ⌄ at the right edge every row shares.
 * Under a Request whose result stands in that room (MemberResult), the picture keeps to its own head instead, and stands
 * over the result's press (z-1), so a press on the picture is the Request's. */
const FEED_THUMB = "relative z-1 col-start-3 row-start-2 h-8 w-12 flex-none self-start rounded-sm border border-line";
const FEED_THUMB_FOOT = "-mb-2";

/** How many rows a feed drawn afresh draws first: more than a tall screen holds closed. */
const FIRST_SCREEN_ROWS = 24;
/** The days with their newest rows, as many as FIRST_SCREEN_ROWS in all. */
function firstScreen<Day extends { rows: unknown[] }>(days: Day[]): Day[] {
  const drawn: Day[] = [];
  let left = FIRST_SCREEN_ROWS;
  for (const day of days) {
    if (left <= 0) break;
    drawn.push(day.rows.length <= left ? day : { ...day, rows: day.rows.slice(0, left) });
    left -= day.rows.length;
  }
  return drawn;
}

/** `waitFrom`: when the wait for this feed began (the task or pane opened), so its placeholders keep that wait's time. */
type FeedProps = { task: TaskDetail; people: PeopleIndex; onFollow: (id: string) => void; waitFrom?: number };
/**
 * A long feed follows an update in a render a key can interrupt (https://react.dev/reference/react/useDeferredValue);
 * while it follows, a render of the feed alone draws no row again (RecordRow). Reached by props and not by a store, so the update can be deferred.
 */
export const ReportFeed = memo(function ReportFeed(props: FeedProps) {
  const task = useDeferredValue(props.task), people = useDeferredValue(props.people);
  // A feed opened afresh (a row pressed in the list, or History chosen again) draws its rows in a render after the first
  // frame: the Task's head and tabs are seen at once, and the rows land under them a moment later. Drawn in one go, the
  // rows held the press for the whole reader. A deferred render is begun again by every update that comes before it
  // ends, so under live updates a long feed stayed empty until React forced it, seconds later: by the next frame the
  // rows are drawn in an ordinary render if the deferred one has not ended. Until they land they are still to come, as
  // while they are read: the same placeholder on the same wait (Reader's), so rows drawn soon after show none.
  const [mounted] = useState(() => performance.now());
  const waitFrom = props.waitFrom ?? mounted;
  const deferred = useDeferredValue(true, false);
  const [due, setDue] = useState(false);
  useEffect(() => {
    if (deferred || typeof requestAnimationFrame === "undefined") return;
    const frame = requestAnimationFrame(() => setDue(true));
    return () => cancelAnimationFrame(frame);
  }, [deferred]);
  const drawn = deferred || due;
  if (!drawn) return <div data-report-feed data-history-ready={false} className="pb-6"><RegionSkeleton shape="reports" waitFrom={waitFrom} /></div>;
  return <Feed {...props} task={task} people={people} waitFrom={waitFrom} />;
}, (a, b) => a.task === b.task && a.onFollow === b.onFollow && sameForFeed(a.people, b.people, a.task.id)
  && samePeopleAgentNames(a.people, b.people));
/**
 * The feed's words, read once by the feed for every row under it: a row's own `useTranslation` made a copy of the i18n
 * instance each time a row was first drawn, hundreds for a page of History.
 */
type FeedWordsValue = { reader: TFunction<"reader">; ui: TFunction<"ui">; people: TFunction<"people">; locale: string };
const FeedWords = createContext<FeedWordsValue | null>(null);
function useFeedWords(): FeedWordsValue {
  const words = useContext(FeedWords);
  if (!words) throw new Error("A feed row is drawn outside its feed");
  return words;
}
const Feed = memo(function Feed({ task, people, onFollow, waitFrom }: FeedProps) {
  const { t } = useTranslation("reader");
  const { t: ui } = useTranslation("ui"), { t: peopleWords, i18n } = useTranslation("people");
  const words = useMemo(() => ({ reader: t, ui, people: peopleWords, locale: i18n.language }), [t, ui, peopleWords, i18n.language]);
  const root = useWorkspaceInfo(info => info.root);
  const historyOptions = resources.history(root, task.id);
  const history = useTaskHistory(root, task.id);
  const historyRead = useReadState(historyOptions.queryKey);
  const offline = useConnection((state) => state.offline);
  const picked = useTimeView(state => state.picked?.taskId === task.id ? state.picked.key : null);
  const imageId = useViewStore(state => state.image);
  // Every row opens and closes on its own, a report's card as any other: pressed or named rows, each until pressed again.
  // They are kept in the step with where the reader stands (reader-position's rows), so the step shown again
  // (Back, Forward, a reload) lays them out as they were read. Unpressed, the newest report stands open, or what stands
  // in its place until one comes.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map(Object.entries(readerHistoryPosition(task.id)?.rows ?? {})));
  useEffect(() => noteReaderRows(task.id, chosen), [task.id, chosen]);
  const jumps = useRef(0);
  // The row a jump lands on lights as a row pointed at does, for the tint from when it is reached: each jump its
  // own, so a second press on the same link lights it again, and travel of any length leaves it lit as long.
  const [flash, setFlash] = useState<{ key: string; jump: number; landed: boolean } | null>(null);
  const event = useViewStore(state => state.event);
  const bottom = useRef<HTMLDivElement>(null);
  // History keeps its own refusal/scope gate, including while the body is being edited.
  const heldPages = historyRead.assessment.display ? history.data?.pages : undefined;
  // The first pages draw at once, as what was there before them is the shape of a read. Until the rows have caught up, History is still being read.
  const followedPages = useDeferredValue(heldPages), pages = heldPages && (followedPages ?? heldPages);
  // A feed drawn afresh draws a screen of rows first and the rest once that is painted: the rest are below the screen,
  // and drawing every row of a page held the first screen back by as long. One opened at a row (a link, a time mark, a
  // picture) draws them all at once, as it goes to that row, and so does one coming back to where it was read below its
  // top. Until the rest are down, History is still being read.
  const [whole, setWhole] = useState(() => !!(picked ?? event ?? imageId) || (readerHistoryPosition(task.id)?.scroll ?? 0) > 0), held = !!pages;
  useEffect(() => {
    if (whole || !held) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => { timer = setTimeout(() => setWhole(true), 0); });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [whole, held]);
  // A failed page's row leaves with the rows that replace it, or a reader at the end is moved up as the column shrinks between them.
  const failure = useDeferredValue(history.isError ? history.error : null);
  const folder = taskFileUrl(task.id, "");
  // The server's History, one row per record and newest first (the task's own and what it sees of its children): this
  // only says how each looks. A page read again after a write brings a record once more; it is drawn once.
  const named = useMemo(() => {
    const named = new Map<string, NonNullable<TaskHistoryDTO["tasks"]>[string]>();
    pages?.forEach(page => {
      for (const [id, task] of Object.entries(page.tasks ?? {})) named.set(id, task);
    });
    return named;
  }, [pages]);
  const events = useMemo(() => {
    const events = new Map<string, HistoryEvent>();
    pages?.forEach(page => page.events.forEach(event => events.set(eventKey(event), event)));
    return events;
  }, [pages]);
  // The list is read for the Tasks this History names alone (their titles and parents): a change to any other row, or
  // a Run's activity, rebuilds no row here.
  const namedIds = useMemo(() => {
    const ids = new Set<string>([task.id, ...(task.parent ? [task.parent] : [])]);
    for (const event of events.values()) {
      ids.add(event.taskId);
      if (event.dependencies) for (const id of [...event.dependencies.after, ...event.dependencies.previous]) ids.add(id);
    }
    for (const [id, each] of named) { ids.add(id); if (each.parentId) ids.add(each.parentId); }
    return [...ids].sort();
  }, [events, named, task.id, task.parent]);
  const everyName = useTaskNames(namedIds, false), shownName = useTaskNames(namedIds, true);
  // A failed Run still waiting for a decision can be closed from its row: only which of this History's Runs those are.
  const reviewRuns = useMemo(() => [...events.values()].filter(event => event.kind === "error"
    && people.runs.get(event.id)?.state === "needs_review").map(event => event.id).join(" "), [events, people.runs]);
  // Who stood at each end, as the rows say it: the placements and their Runs' agents, not their activity.
  const crewPeople = useAgentFacts(people);
  const reports = useMemo(() => {
    const waiting = new Set(reviewRuns.split(" "));
    const finished = finishedBy(task);
    const finish = finished && logKey(task.id, finished.id);
    const ordered = [...events.values()].sort(compareHistoryEvents);
    const ranks = new Map<string, number>();
    for (let at = 0; at < ordered.length; at++) ranks.set(eventKey(ordered[at]!), at);
    return reviewReports(questionReports(ordered.map(event => {
      const said = reportEvent(event, id => id === task.id ? turnRecord(task) : null);
      const words = event.dependencies ? orderRecordWords(event.dependencies, id => everyName.get(id)?.title
        ?? named.get(id)?.title, t) : null;
      const report = words ? { ...said, ...words } : said;
      // A failed Run that still waits for a decision on it can be closed from its row.
      return report.key === finish ? { ...report, finish: true }
        : report.kind === "error" && waiting.has(event.id) ? { ...report, runId: event.id } : report;
    }), task), task).map(report => isCurrentWait(task, report) ? { ...report, currentWait: true } : report).sort((a, b) => b.at.localeCompare(a.at) || (ranks.get(a.key) ?? Infinity) - (ranks.get(b.key) ?? Infinity) || b.key.localeCompare(a.key));
  }, [events, task, reviewRuns, everyName, named, t]);
  // Who each Task a row names is: the page says, finished Tasks too, and the live index is there for a page that does not.
  const rows = useMemo(() => {
    const taskOf = (id: string) => {
      return named.get(id) ?? shownName.get(id);
    };
    // Who stood at each end, when its record does not say: the placements and their Runs, the live ones and those each
    // page brings of the Tasks it names (end-agent).
    const crews: (readonly [string, HistoryCrewDTO])[] = [];
    for (const page of pages ?? []) {
      for (const [id, each] of Object.entries(page.tasks ?? {})) if (each.crew) crews.push([id, each.crew]);
    }
    const agentAt = endAgents(crewPeople, crews);
    // A Task right below its project has no parent Task: what it reports goes to you.
    return historyRows(reports, { id: task.id, parentId: task.parent }, taskOf, agentAt);
  }, [reports, named, pages, shownName, task.id, task.parent, crewPeople]);
  const targets = useMemo(() => rowTargets(rows), [rows]);
  const agentNames = useMemo(() => {
    const known: ModelName[] = [...peopleAgentNames(people)];
    for (const page of pages ?? []) for (const task of Object.values(page.tasks ?? {})) {
      if (!task.crew) continue;
      for (const run of task.crew.runs) known.push(agentModelName(run.modelId, run.effort, run.agent));
      for (const placement of task.crew.placements) known.push(agentModelName(null, null, placement.profileKey));
    }
    const names: string[] = [];
    const addFlow = (end: HistoryRow["flow"]["to"]) => {
      if (end?.profileKey && end.modelId !== undefined) known.push(agentModelName(end.modelId, end.effort, end.profileKey));
    };
    for (const row of rows) {
      if ("own" in row.name) {
        if (row.name.own.agent) names.push(row.name.own.agent);
      } else for (const end of row.name.ends) if (end.agent) names.push(end.agent);
      addFlow(row.flow.from);
      addFlow(row.flow.to);
    }
    return visibleAgentNames(names, known);
  }, [people, rows, pages, t]);
  const days = useMemo(() => feedDays(rows), [rows]);
  const partial = !whole && held && rows.length > FIRST_SCREEN_ROWS;
  const catchingUp = pages !== heldPages || partial;
  const today = useToday();
  const shown = rows.map(row => row.report);
  // Each gallery occurrence names a file; keep the first match across History updates.
  const galleryFiles = useMemo(() => {
    const files = new Map<string, TaskDetail["files"][number]>();
    for (const file of task.files) if (isMedia(file.name) && !files.has(file.name)) files.set(file.name, file);
    return files;
  }, [task.files]);
  // A gallery read again with the same images is the one already drawn, so the rows it is handed stay as they are.
  const drawnGallery = useRef<GalleryImage[]>([]);
  const gallery: GalleryImage[] = useMemo(() => {
    const images: GalleryImage[] = [];
    const append = (each: ReportEvent, key: string, description: ReportEvent["description"]) => {
      if (!description) return;
      // Shared with the body's own parse: the gallery adds its attachments to a copy.
      const media = [...markdownMedia(description)];
      if (isInstruction(each) && !key.endsWith(":note")) {
        let occurrence = 0;
        for (const item of media) if (item.kind === "file") occurrence++;
        for (const file of splitAttachments(description, folder).files) if (file.media)
          media.push({ kind: "file", occurrence: occurrence++, path: file.path, alt: file.name });
      }
      // A coordinator answer's kept copies stand for the local files it links to, as its body draws them.
      const published = !key.endsWith(":note") && each.answerFiles
        ? answerBodyFiles({ id: each.answerFiles.requestId, answerFiles: each.answerFiles.files }) : undefined;
      for (const medium of media) {
        const id = markdownMediumId(key, medium);
        if (medium.kind !== "file") {
          images.push({ id, reportKey: key, path: "", src: "", source: medium.source, alt: fenceLabel(t, medium) });
          continue;
        }
        const { path, alt } = medium;
        const copy = published?.find(file => file.path === path);
        if (copy) {
          if (copy.src && isMedia(copy.name)) images.push({ id, reportKey: key, path, alt, src: copy.src });
          continue;
        }
        const embed = reportEmbed(path);
        if (!embed || !inGallery(embed.kind)) continue;
        const safe = embed.path;
        const sourceId = each.sourceTaskId ?? task.id;
        const file = sourceId === task.id ? galleryFiles.get(safe) : undefined;
        if (sourceId === task.id && !file) continue;
        images.push({ id, reportKey: key, path: safe, alt, src: taskFileUrl(sourceId, safe, file?.revision) });
      }
    };
    for (const each of reports) {
      append(each, each.key, each.description);
      if (each.note?.description) append(each, `${each.key}:note`, each.note.description);
    }
    return sameGallery(drawnGallery.current, images);
  }, [reports, folder, task.id, galleryFiles, t]);
  drawnGallery.current = gallery;
  // What a row draws of its Task, held while those stay the same: the rest of it (its state, ball, usage, hash) changes
  // with every report that arrives, and would draw every row again. Answering reads the whole Task (FeedTask).
  const rowTask: RowTask = useMemo(() => ({ id: task.id, title: task.title, files: task.files, questions: task.questions }),
    [task.id, task.title, task.files, task.questions]);
  // An in-flight head is not an exhausted History. Both navigation entrances wait for the same adapter state.
  const historySearch = catchingUp || history.isPending || history.isFetching || history.isFetchingNextPage ? "reading"
    : history.isError ? "failed" : history.hasNextPage ? "older" : "end";
  const activeImage = imageId ? gallery.findIndex(item => item.id === imageId) : -1;
  const client = useQueryClient();
  const historyQuery = readQuery(client, historyOptions.queryKey);
  // Ask at acquisition time: scrolling and disclosures supply facts without another render or Query write.
  const needed = useRef<HistoryReader>(() => undefined);
  needed.current = incoming => {
    const area = feedList.current?.closest<HTMLElement>('[data-reader-content]');
    if (area && area.scrollTop > 0) return { kind: 'all' };
    const kept = new Set([picked, event, gallery[activeImage]?.reportKey].filter((key): key is string => !!key).map(recordKey));
    const viewport = area?.getBoundingClientRect();
    const visible = (node: Element) => {
      const box = node.getBoundingClientRect();
      return !!viewport && box.bottom > viewport.top && box.top < viewport.bottom && box.height > 0;
    };
    for (const row of feedList.current?.querySelectorAll<HTMLElement>('li[data-report-key]') ?? [])
      if (visible(row)) kept.add(row.dataset.reportKey!);
    for (const node of feedList.current?.querySelectorAll<HTMLElement>('[data-history-keep]') ?? [])
      for (const key of node.dataset.historyKeep!.split(' ')) kept.add(key);
    // A row is held through the oldest record it stands for.
    for (const row of rows) if (kept.has(row.key)) for (const each of row.older) kept.add(each.key);
    // Losing the default story must not unfold a quiet row that is currently visible in its place.
    if (firstReport && (standingCandidate && kept.has(standingCandidate.key)
      || incoming.some(each => canStand(reportEvent(each, id => id === task.id ? turnRecord(task) : null))))) kept.add(firstReport.key);
    let floor: string | undefined;
    for (const page of pages ?? []) for (const each of page.events) {
      if (!kept.has(eventKey(each))) continue;
      const cursor = historyCursor(each);
      if (floor === undefined || cursor < floor) floor = cursor;
    }
    return floor === undefined ? undefined : { kind: 'through', cursor: floor };
  };
  useLayoutEffect(() => historyQuery && holdHistory(historyQuery, incoming => needed.current(incoming)), [historyQuery]);

  useEffect(() => {
    if (!imageId || activeImage >= 0) return;
    if (historySearch === "older") void history.fetchNextPage();
    else if (historySearch === "end") useViewStore.getState().setImage(null);
  }, [imageId, activeImage, historySearch, history.fetchNextPage]);
  const firstReport = shown.find(isCard);
  // Until a report comes, the newest thing you or the Coordinator wrote stands open in its place: an instruction or an
  // answer with a body, or a dialogue with the Coordinator. It waits for History, which holds the instructions,
  // so an older one does not open first and fold again. The task's own text is Context, under the title.
  const historyUnavailable = !!historyRead.error && !historyRead.assessment.display;
  const standingCandidate = shown.find(canStand);
  const standing = firstReport || !history.data && !historyUnavailable ? null : standingCandidate?.key ?? null;
  // The URL's event opens its row.
  useEffect(() => {
    const row = event ? rows.find(each => each.key === targets.get(event)) : undefined;
    if (!row) return;
    setChosen(now => now.get(row.key) ? now : new Map(now).set(row.key, true));
  }, [rows, targets, event, setChosen]);
  const toggle = useCallback((row: HistoryRow, wasOpen: boolean) => {
    setChosen(now => new Map(now).set(row.key, !wasOpen));
    // Each row is its own address, a dialogue's reply too (history-rows' recordKey reads its record from it).
    const address = row.key;
    if (!wasOpen) useViewStore.getState().setEvent(address);
    else if (useViewStore.getState().event === address) useViewStore.getState().setEvent(null);
    // The row pressed stays where it was pressed, whatever else opens or closes with it (reading-position). The rows
    // are not drawn again yet; a restoration of where the reader was read has just stood aside for the new address.
    const pressed = feedList.current?.querySelector<HTMLElement>(`li[data-report-key="${CSS.escape(row.key)}"]`);
    if (pressed) keepPressedRow(pressed);
  }, [setChosen]);
  // A jump (a time mark, a link): name the row, flash it and bring it into view, reading older History pages until it is
  // there. It is used up once it lands, or once History has no page left, so a later redraw does not jump again.
  useEffect(() => {
    // The URL's row must be acquired even when Back/reload restores a saved scroll instead of jumping to it.
    const target = picked ?? event;
    if (!target) return;
    const found = reports.find(report => report.key === recordKey(target));
    // userQuestions can already draw an old question before History reaches its position. Acquire all records
    // above that position first, so a page arriving during the jump cannot insert rows above the destination.
    const oldest = pages?.at(-1)?.events.at(-1);
    const questionJump = picked && found?.kind === "question";
    const acquired = found && (!questionJump || history.data && (!history.hasNextPage || oldest && compareHistoryEvents(oldest,
      { at: found.at, taskId: found.taskId, id: found.id, kind: found.kind }) >= 0));
    // A deferred update still on its way can move the rows after the jump has landed; `historySearch` runs this again when it is down.
    if (picked && catchingUp) return;
    if (found && acquired) {
      if (!picked) return;
      useViewStore.getState().setEvent(picked);
      const card = targets.get(picked);
      const held = card ? rows.find(row => row.key === card) : undefined;
      if (held) setChosen(now => new Map(now).set(held.key, true));
      const jump = ++jumps.current, lit = card ?? picked;
      setFlash({ key: lit, jump, landed: false });
      const landed = () => setFlash(now => now?.jump === jump ? { ...now, landed: true } : now);
      let scrollTimer: number | undefined;
      const frame = requestAnimationFrame(() => {
        // The row named opens as it is reached. Find the destination after its disclosure settles, so its heading stays in view.
        scrollTimer = window.setTimeout(() => {
          const area = feedList.current?.closest("[data-reader-content]") ?? document;
          const folded = area.querySelector<HTMLElement>(`[data-folded-report="${CSS.escape(picked)}"]`);
          const row = area.querySelector<HTMLElement>(`li[data-report-key="${CSS.escape(card ?? picked)}"]`);
          const destination = folded ?? row?.querySelector<HTMLElement>("button[aria-expanded]") ?? row;
          if (destination) scrollReport(destination, questionJump ? "start" : "center", landed);
          else landed();
          useTimeView.getState().pick(task.id, null);
        }, reducedMotion() ? 0 : duration("base"));
      });
      return () => { cancelAnimationFrame(frame); clearTimeout(scrollTimer); };
    }
    // A failed read waits for the column's retry button; the jump stays, so a retry that succeeds still lands it.
    if (historySearch === "older") void history.fetchNextPage();
    else if (historySearch === "end" && picked) useTimeView.getState().pick(task.id, null);
  }, [picked, event, reports, rows, targets, task.id, historySearch, history.hasNextPage, history.data, history.fetchNextPage, setChosen]);
  useEffect(() => {
    if (!flash?.landed) return;
    const timer = setTimeout(() => setFlash(now => now === flash ? null : now), duration("tint"));
    return () => clearTimeout(timer);
  }, [flash]);
  usePageSentinel(bottom, {
    hasNextPage: !!history.hasNextPage,
    isFetchingNextPage: history.isFetchingNextPage,
    isFetchNextPageError: history.isFetchNextPageError,
    // The rows of the page just read are not down yet: the end still in view is not a request for another.
    isFetching: catchingUp || history.isFetching,
    fetchNextPage: () => history.fetchNextPage(),
  });
  // Whatever changes the rows' places glides them there: a report arriving at the top, the working row or the questions
  // bar appearing above the reports, growing or going, a report's words growing with new facts (useListMotion).
  // An arriving row fades in where it lands when it is news: a row drawn above every report drawn before it, in
  // History's own order (a report at the same time as the newest is news too), whether written just now or while the
  // saved History stood here. Only reports are counted: neither a day's divider (one arriving above every report,
  // yesterday's when the day turns over the rows it now heads, is news) nor the rows standing above the reports. What
  // fills an empty feed, older pages and a report folding into another are not news; a group of reports answers to every
  // report it holds, so one joining it is no new row. While reading below, the Reader retains the position instead: a
  // second reflow animation would move the same rows twice.
  const feedList = useRef<HTMLOListElement>(null);
  useListMotion(feedList, [shown.map(report => report.key).join(" "), today],
    (item, { stayed }) => {
      const before = stayed.filter(other => other.hasAttribute("data-report-key"));
      return before.length > 0 && before.every(other => !!(item.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING));
    },
    list => (list.closest<HTMLElement>("[data-reader-content]")?.scrollTop ?? 0) === 0,
    // The rows read and draw their own facts (the working row, the questions bar, a report's words), past what `deps` say.
    { watchesDrawing: true });
  // One spacing rule with MarkdownBody's FLOW steps (4 attach · 8 block · 16 section): the rail owns a 16px gutter and
  // time, child link, body and nested groups all start at the time's left edge. A row's head keeps 10px above its
  // words; an open body starts 12px under them and ends with its copy, 8px above the divider (ROW_HEAD, BodyCopy).
  // A nested group (earlier reports, waiting actions) opens 16px below the body as a line plus 12px, like a quote.
  // The rail is the list's 1px left border, its left edge a pixel left of a row's edge (--rail): what stands on it is
  // centred on the border's centre, from a row's edge or a gutter further from inside its words (RailTime).
  // Placement needs the permitted pages already drawn, even if their refresh failed. A missing target is
  // exhausted only by a successful read; retained pages cannot complete that lookup on their own.
  const historyReady = !!pages && !catchingUp && !history.isFetching;
  // A new turn of the person's on this Task (a report or a question its ball now waits on) is read from its start. At the
  // column's top it arrives there in view; read below, the reading position holds the row in view (reading-position),
  // so the new record would come in above the screen and only its end might show: the column goes to its start. The
  // turn the feed was first drawn with is not new: opening the Task places the column by its own rules. The turn is
  // followed as its rows are drawn, whatever else History is still reading.
  const turnKey = rows.find(row => row.report.currentWait)?.key ?? null;
  const drawnTurn = useRef<string | null | undefined>(undefined);
  const rowsDrawn = !!pages && !catchingUp;
  useEffect(() => {
    if (!rowsDrawn) return;
    const before = drawnTurn.current;
    drawnTurn.current = turnKey;
    if (before === undefined || turnKey === null || turnKey === before) return;
    const row = feedList.current?.querySelector<HTMLElement>(`li[data-report-key="${CSS.escape(turnKey)}"]`);
    if (row && (row.closest<HTMLElement>("[data-reader-content]")?.scrollTop ?? 0) > 0) scrollReport(row, "start");
  }, [turnKey, rowsDrawn]);
  // Read whole and holding no row; a refresh of it in flight does not take that back (the note would blink with each one).
  const historyEmpty = !!pages && !catchingUp && history.isSuccess && !history.hasNextPage && !rows.length;
  const feed = <div data-report-feed data-history-ready={historyReady} data-history-exhausted={history.isSuccess && historyReady && !history.hasNextPage} aria-busy={history.isPending || history.isFetchingNextPage} className="pb-6">
      {task.userQuestions === null && <ReadFailure what={t('reportFeed.questionsUnavailable')} />}
      {task.userReviews === null && <ReadFailure what={t('reportFeed.reviewsUnavailable')} />}
      <UrlImageSlider images={gallery} />
      <FeedWords.Provider value={words}><FeedAgents taskId={task.id} historyNames={agentNames}><FeedTask.Provider value={task}><Today.Provider value={today}><ol ref={feedList} className="m-0 ml-2 flex list-none flex-col border-l border-rule p-0 [--gutter:--spacing(4)] [--rail:-1px]">
      <QuestionsBar task={task} />
      <WorkingRow task={task} onFollow={onFollow} />
      <AssignedRow task={task} />
      {(partial ? firstScreen(days) : days).map(day => <li key={day.key} data-day={day.key} className="relative">
        <DayHead at={day.at} motionKey={`day:${day.key}`} />
        <ol className="isolate m-0 flex list-none flex-col p-0"><DayBase.Provider value={day.at}>{day.rows.map(row => {
          return <HistoryItem key={row.key} row={row} task={rowTask} gallery={gallery} onFollow={onFollow} onToggle={toggle} flash={flash?.key === row.key}
            pressed={chosen.get(row.key) === true}
            open={chosen.get(row.key) ?? ((row.key === firstReport?.key || standing === row.key) && saysMore(row))} />;
        })}</DayBase.Provider></ol></li>)}
</ol>
      {historyEmpty && <EmptyHistoryNote task={task} owned={!!crewOf(task.id, people).responsible} />}
</Today.Provider></FeedTask.Provider></FeedAgents></FeedWords.Provider>
    <PendingRegion pending={history.isPending || history.isFetchingNextPage} shape="reportLines" waitFrom={history.isPending ? waitFrom : undefined} />
    {/* Out of reach, reports this device does not hold say so (they are read once serve is back); what is held says its
        time in the bar's one offline mark. */}
    {failure && (historyRead.assessment.state === 'refused' ? <ReadFailure error={failure} retry={historyRead.retry} /> : offline ? (!history.data || history.isFetchNextPageError) && <ReadNote kind="absent" />
      : <ReadFailure error={failure} retry={historyRead.retry} />)}
    <div ref={bottom} />
  </div>;
  return feed;
});

/**
 * A row in its place on the rail. The row pointed at, here or on the list's line, is asked of the store here and not of
 * the feed, so moving along a long History draws the two rows it moves between and no others.
 */
const HistoryItem = memo(function HistoryItem({ row, pressed, flash, ...props }: RowProps & { pressed: boolean; flash: boolean }) {
  const report = row.report, taskId = props.task.id;
  const hovered = useTimeView(state => state.hovered?.taskId === taskId && state.hovered.key === row.key);
  // A row is pointed at or jumped to, and darkens; one that is the current wait keeps its line and its own colours.
  const pointed = flash || hovered, lit = report.currentWait || pointed;
  const point = (key: string | null) => useTimeView.getState().hover(taskId, key);
  // The existing lit/hover line follows the whole record, including its body while open.
  const tone = reportTone(report);
  const line = lit ? <span aria-hidden data-report-line className={`${ON_RAIL} -ml-(--gutter) inset-y-0 w-0.5 bg-current ${TONE[tone]}`} />
    : <span aria-hidden data-hover-line className={`${ON_RAIL} -ml-(--gutter) inset-y-0 w-0.5 bg-current invisible group-hover/row:visible ${TONE[tone]}`} />;
  return <li data-report-key={row.key} data-history-keep={pressed ? row.key : undefined} data-motion-key={[row.key, ...row.older.map(each => each.key)].join(" ")} data-lit={pointed || undefined}
    onMouseEnter={() => (report.mark || report.finish) && point(row.key)} onMouseLeave={() => (report.mark || report.finish) && point(null)}
    className="group/row relative pl-(--gutter)">
    <RecordRow row={row} line={line} {...props} />
  </li>;
}, (a, b) => sameRow(a.row, b.row) && a.open === b.open && a.pressed === b.pressed && a.flash === b.flash && a.task === b.task && a.gallery === b.gallery && a.onFollow === b.onFollow && a.onToggle === b.onToggle);

type RowTask = MarkdownTask & Pick<TaskDetail, "questions">;
type RowProps = { row: HistoryRow; open: boolean; onToggle: (row: HistoryRow, wasOpen: boolean) => void; task: RowTask; gallery: GalleryImage[]; onFollow: (id: string) => void };
type RecordProps = RowProps & { line: ReactNode };
/**
 * The one row of History: every record, whatever its kind or state, is this. Its time on the rail with which way it went,
 * then who it came from or went to, what it says, and how it ended when it waits on someone. What is written only goes
 * darker when it is the row being read: colour and weight say only what is yours to do, or what closed and needs no reading.
 */
function RecordRow({ row, line, open, onToggle, task, gallery, onFollow }: RecordProps) {
  const { reader: t, ui } = useFeedWords();
  const stateWords = (state: TaskState) => stateWord(state, ui);
  const label = useFeedClock(true);
  const { report, sameTitle: same, outcome } = row;
  const home = report.taskId;
  const request = isInstruction(report);
  const galleryKey = report.replyTo ?? report.key;
  const plain = (report.note?.title ?? report.text).replace(/\bR\d+\b/g, "").replace(/\s+/g, " ").trim();
  const kindWord = t(`reportFeed.row.kind.${report.replyTo ? "reply" : report.kind === "report" && report.set === "done" ? "done" : report.kind}`);
  const names = useContext(AgentNames);
  const words = same ? t("reportFeed.row.sameTitle")
    : report.carriedOn ? carriedOnWords(report, names, t, ui)
    : report.changed ? t("reportFeed.row.changedTo", { state: stateWords(report.changed) })
    : report.cause ? causeReason(report.cause, ui)
    : report.kind === "error" || report.kind === "run_end" ? t(`history.reasons.${report.text}`, { defaultValue: t("history.reasons.unknown") })
    : report.kind === "answer" ? answerLine(taskStatement(report.quote ?? report.answerText ?? report.description ?? report.text, home)) || kindWord
    : taskStatement(plain, home) || kindWord;
  // An instruction's, an answer's or a dialogue's words (yours or the reply) are its body's first line: open, the body says them once.
  const firstLine = request || report.kind === "answer" || report.kind === "dialogue";
  const handsOver = !report.note && !!report.description && firstLine, bodySaysIt = open && handsOver;
  const wordsLine = useRef<HTMLSpanElement>(null);
  const leaving = useHandOver(bodySaysIt, wordsLine);
  // The head's words are its open heading only where they stay in it; handed over, they are always the closed line.
  const heading = open && !handsOver;
  const yours = !!report.userQuestion || outcome?.kind === "waiting" && outcome.on === "you";
  // Closed, weight says what is yours to do; open, the words are the head of what is read under them.
  const strong = yours || report.kind === "urgent";
  const faint = same || report.released;
  // An instruction's attached files: its first picture beside the closed row; all of them as cards when open.
  const sent = request && report.description ? splitAttachments(report.description, taskFileUrl(home, "")) : null;
  const held = (name: string) => home === task.id ? task.files.find(file => file.name === name) : undefined;
  const sentPicture = sent?.files.find(file => file.media);
  const media = request ? sentPicture?.path && held(sentPicture.path)?.name : firstReportMedia(report.description ?? "") ?? undefined;
  const shownMedia = media && (home !== task.id || isMedia(media) && held(media)) ? media : null;
  const lines = <>
    <RailTime mark={report.finish ? FINISH_MARK : { kind: row.way, tone: reportTone(report) }}><time dateTime={report.at}>{label(report.at)}</time></RailTime>
    <RowName row={row} kindWord={kindWord} open={open} />
    <span className="col-start-3 row-start-1 flex items-center justify-self-end"><DisclosureChevron open={open} /></span>
    {(!bodySaysIt || leaving) && <span ref={wordsLine} data-row-words data-leaving={leaving || undefined} aria-hidden={leaving || undefined} dir="auto" title={same ? report.text : undefined} className={`col-span-2 col-start-1 mt-0.5 min-w-0 text-base ${heading || report.kind === "run_end" || report.kind === "error" ? "" : firstLine ? "line-clamp-1" : "line-clamp-2"} ${strong || heading ? "font-semibold" : "font-normal"} ${
      heading ? "text-ink" : faint ? "text-soft group-hover/row:text-ink group-data-lit/row:text-ink" : strong ? "text-ink" : ROW_WORDS}`}>{words}</span>}
    {!open && shownMedia && <MediaThumb name={shownMedia} src={taskFileUrl(home, shownMedia, held(shownMedia)?.revision)} className={`${FEED_THUMB} ${report.result ? "" : FEED_THUMB_FOOT}`} />}
    {!open && sent && sent.files.length > (shownMedia ? 1 : 0) && <span data-attachment-count className="relative z-1 col-start-3 row-start-2 flex flex-none items-center gap-0.5 text-xs text-muted">
      <Icon name="file" className="size-3.5" />{sent.files.length}</span>}
    {/* The place to answer, open below, says it waits: the words would push the first choice off a phone's screen. */}
    {outcome && !(open && report.question) && <RowEnd outcome={outcome} />}
  </>;
  const received = report.consumedBy?.length ? t("reportFeed.received") : null;
  const context = { task, gallery, onFollow };
  return <article data-report-card-open={open ? "" : undefined} data-released={report.released} className="relative border-b border-rule">
    {line}
    <div className="relative flex items-baseline gap-2">
      <button type="button" aria-expanded={open} onClick={() => onToggle(row, open)} className={`${RECORD_HEAD} items-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink`}>{lines}</button>
      {report.runId && <CloseRun runId={report.runId} taskId={task.id} />}
    </div>
    <DisclosureBody open={open}><div className="min-w-0 pb-2 font-normal text-ink">
      <RowParties row={row} onFollow={onFollow} />
      {same && <p className="mb-2 text-base font-medium">{report.text}</p>}
      {row.asks && <p data-row-asks className="mb-2 text-xs text-muted">{t("reportFeed.row.answerTo", { question: row.asks })}</p>}
      {report.quote && report.kind === "answer" && <p className="mb-2">{report.quote}</p>}
      {report.note?.description
        ? <><MarkdownBody text={report.note.description} task={task} onFollow={onFollow} gallery={gallery} galleryReportKey={`${report.key}:note`} />
          <BodyCopy text={() => reportCopy(report.note!.title, report.note!.description)} beside={received} />
          <RowFold label={t("reportFeed.sentBody")}><RecordBody report={report} {...context} /></RowFold></>
        : <RecordBody report={report} {...context} beside={received}>
          {report.question && <FeedWaitingActions question={report.question} onFollow={onFollow} />}
        </RecordBody>}
      {received && !report.note?.description && !report.description && <p data-row-received className="mt-1 text-xs text-muted">{received}</p>}
      {row.older.length > 0 && <RowFold label={t("reportFeed.row.older", { n: row.older.length })} holds={row.older.map(each => each.key)}>
        <ol className="m-0 list-none p-0">{row.older.map(each => <li key={each.key} data-folded-report={each.key} className="border-t border-rule py-2">
          <p className="mb-1 text-xs tabular-nums text-muted"><time dateTime={each.at}>{label(each.at)}</time></p>
          <RecordBody report={each} {...context} /></li>)}</ol></RowFold>}
      {report.causes?.length ? <ul className="mt-2 m-0 list-none p-0 text-xs text-muted">{report.causes.map(cause => <li key={cause.id}>
        <button type="button" onClick={() => onFollow(cause.taskId)} className="min-h-7 text-left underline hover:text-ink narrow:min-h-11">
          {t("reportFeed.row.cause", { at: label(cause.at), title: cause.title || t("reportFeed.row.kind.report") })}</button></li>)}</ul> : null}
    </div></DisclosureBody>
    {report.result && <MemberResult result={report.result} by={"ends" in row.name ? row.name.ends[1] : row.name.own} open={open} onToggle={() => onToggle(row, open)} task={task} onFollow={onFollow} />}
  </article>;
}

/**
 * A member Request's result under its row, opened and closed with it: when the reply came and its first line, closed;
 * opened, under the Request's words, the whole reply, read then and only then, so a page of History stays small. The
 * Request and its answer are one record to open, so the row's one ⌄ opens both, and a press on the result's line is the
 * row's press too; the line, between the two bodies, says where the Request ends and its answer begins. The answer's arrow leads
 * its line, down from the Request's words and on to the reply, so it reads as that Request's answer and not as a row
 * of its own; opened, the arrow's line runs on down the reply, which starts under the line's first word.
 *
 * Its room, by the feed's steps (4 attach · 8 block): the line stands 4px under what its Request shows above it, the
 * closed words or the open body's last row, nearer that than that is to anything else, and 10px above the rule, as
 * every closed row's last line does. So the two read as one row and the rule parts them from the next. It takes that
 * place by standing in the foot the Request keeps under itself (`--foot`: 10px under closed words, 8px under an open
 * body), over it (`relative`). A phone's press starts 4px higher (`--reach`), in the space under the words' letters.
 * Opened, its reply starts 12px under its line and ends 8px above the rule, as a record's body does. Its words end
 * where the Request's do, short of the ⌄ column (its 12px and the gap before it: 8px, a phone's 6px).
 *
 * The line is no control of its own: the row's button, with its ⌄ and `aria-expanded`, is the one a keyboard or a
 * screen reader uses for both, and the line only takes a pointer's press for it.
 */
function MemberResult({ result, by, open, onToggle, task, onFollow }: { result: NonNullable<ReportEvent["result"]>; by: NameEnd; open: boolean; onToggle: () => void; task: RowTask; onFollow: (id: string) => void }) {
  const { t } = useTranslation("reader");
  const label = useFeedClock(true);
  const root = useWorkspaceInfo(info => info.root);
  const reply = useQuery({ ...resources.runResult(root, result.runId), enabled: open });
  const file = reply.data?.files.find(each => each.kind === "result");
  const head = result.head ? resultLine(result.head) : "";
  return <div data-member-result={result.runId} className="text-sm">
    <div data-result-line onClick={onToggle} className={`relative cursor-pointer mt-[calc(0px-var(--foot)-var(--reach))] grid w-full grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-2 pr-5 pt-[calc(--spacing(1)+var(--reach))] text-left [--foot:--spacing(2.5)] [--reach:0px] narrow:gap-x-1.5 narrow:pr-[18px] narrow:[--reach:--spacing(1)] [[data-report-card-open]_&]:[--foot:--spacing(2)] ${open ? "pb-1" : "pb-2.5"}`}>
      <Icon name="answer" className="size-3.5 flex-none text-soft group-hover/row:text-ink" />
      {/* Who replied is the Request's own recipient, named on the row just above: the line keeps its width for the reply. */}
      <span className="flex items-baseline gap-x-1.5 whitespace-nowrap text-xs text-soft group-hover/row:text-ink">
        <span className="sr-only">{t("reportFeed.result.from", { who: by.agent ?? t("reportFeed.row.party.member") })}</span>
        <span aria-hidden>{t("reportFeed.result.label")}</span>
        <time dateTime={result.at} className="tabular-nums">{label(result.at)}</time>
      </span>
      {/* Emptied when opened, it keeps its line's height, so the line stays where it was. */}
      <span dir="auto" className={`min-h-lh min-w-0 truncate ${ROW_WORDS}`}>{open ? "" : head}</span>
    </div>
    {/* The line down the reply runs under the arrow's own stem (drawn 2.6px in), and the reply starts under the line's
        first word: past the arrow's 14px and the gap after it (8px, a phone's 6px). */}
    <DisclosureBody open={open}><div className="pb-2"><div className="ml-[2px] min-w-0 border-l border-rule pl-[19px] pt-2 font-normal text-ink narrow:pl-[17px]">
      {reply.isPending ? <RegionSkeleton shape="text" />
        : reply.isError ? <ReadFailure error={reply.error} what={t("reportFeed.result.unavailable")} retry={() => reply.refetch()} />
        : file?.state === "present" && file.text !== null ? <>
          {/* The feed's gallery holds the records it has read; a reply read on opening opens its pictures in a viewer of its own. */}
          <ReportBody text={file.text} sourceTaskId={task.id} parentTask={task} galleryReportKey={`result:${result.runId}`} onFollow={onFollow} />
          <BodyCopy text={() => file.text ?? ""} /></>
        : <p data-result-unread className="m-0 py-1 text-muted">{t("reportFeed.result.unavailable")}</p>}
    </div></div></DisclosureBody>
  </div>;
}

/** A failed Run that still waits for a decision can be closed from its row. */
function CloseRun({ runId, taskId }: { runId: string; taskId: string }) {
  const { t } = useTranslation("reader");
  const disabled = useWriteDisabled(taskId);
  return <Button variant="outline" className="min-h-7 px-2 text-xs" disabled={disabled}
    onClick={() => useDialogStore.getState().openRun({ runId })}>{t("people:records.close")}</Button>;
}

/** What a record says, as its row opens it: its words, then what it asks (`children`), then the copy of the words, which closes them. */
function RecordBody({ report, task, gallery, onFollow, beside, children }: { report: ReportEvent; task: MarkdownTask; gallery: GalleryImage[]; onFollow: (id: string) => void; beside?: string | null; children?: ReactNode }) {
  const openTaskFile = useViewStore(state => state.openTaskFile);
  if (!report.description) return <>{children}</>;
  const home = report.taskId, request = isInstruction(report), galleryKey = report.replyTo ?? report.key;
  const held = (name: string) => home === task.id ? task.files.find(file => file.name === name) : undefined;
  const sent = request ? splitAttachments(report.description, taskFileUrl(home, "")) : null;
  const openAttachment = (path: string) => {
    const image = gallery.find(item => item.reportKey === galleryKey && item.path === path);
    if (image) useViewStore.getState().setImage(image.id);
    else openTaskFile(home, path);
  };
  return <>
    {sent ? <>{sent.words && <MarkdownBody text={sent.words} task={task} onFollow={onFollow} gallery={gallery} galleryReportKey={galleryKey} />}
        <AttachmentCards className={sent.words ? "mt-2" : undefined} cards={sent.files.map(file => {
          const saved = held(file.path);
          return { id: file.path, name: file.name, size: saved?.size,
            src: file.media && saved ? taskFileUrl(home, saved.name, saved.revision) : null, open: () => openAttachment(file.path) };
        })} /></>
      : report.kind === "answer" ? <MarkdownBody text={report.description} task={task} onFollow={onFollow} gallery={gallery} galleryReportKey={galleryKey} />
      : <ReportBody text={report.description} sourceTaskId={home} parentTask={task} gallery={gallery} galleryReportKey={galleryKey} onFollow={onFollow}
        files={report.replyTo && report.answerFiles ? answerBodyFiles({ id: report.answerFiles.requestId, answerFiles: report.answerFiles.files }) : undefined} />}
    {children}
    <BodyCopy text={() => reportCopy(request || report.kind === "answer" || report.kind === "dialogue" ? "" : report.text, report.description)} beside={beside} />
  </>;
}

/** What a row holds under its own words and stays closed until asked for: the words sent under a note, the earlier repeats. */
function RowFold({ label, holds, children }: { label: string; holds?: string[]; children: ReactNode }) {
  const event = useViewStore(state => state.event);
  const named = !!event && !!holds?.includes(event);
  const [open, setOpen] = useState(named);
  useEffect(() => { if (named) setOpen(true); }, [named]);
  return <div data-history-keep={open && holds ? holds.join(" ") : undefined} className="mt-4 border-l border-rule pl-3 text-sm">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-11 w-full items-center justify-between py-2 text-left text-muted">
      {label}<DisclosureChevron open={open} /></button>
    <DisclosureBody open={open}>{children}</DisclosureBody>
  </div>;
}

/** What a History row says, not opened: a record's words, and as one with them, the words of the work going on now; opened, ink. */
const ROW_WORDS = "text-row-words group-hover/row:text-ink group-data-lit/row:text-ink";
/** A row's head: time, who, the way down the side; on a phone what it says takes the width under the time as well. */
/** A record's head. Its rows keep their own heights from the top (content-start): a phone's 44px floor, when an open row's
 * words have gone to its body, is room under the first line, not a taller first line its time would centre lower in. */
const RECORD_HEAD = "grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] content-start gap-x-2 narrow:gap-x-1.5 pt-2.5 pb-2.5 text-left narrow:min-h-11";

/**
 * What the record is, then who it was between (history-rows' rowName): the one it came from on the left, the one it
 * went to on the right, as short tags and the arrow. What it is comes first, right after the time, so rows can be read
 * down by kind. A screen reader hears it as words. It stays one line; where even short tags do not fit (larger text),
 * the two ends are cut at the line's end and what the record is stays whole. Open, the row says who it was between
 * whole at the top of what it opens (RowParties), so its head keeps only what it is.
 */
function RowName({ row, kindWord, open }: { row: HistoryRow; kindWord: string; open: boolean }) {
  const { reader: t } = useFeedWords();
  const urgent = row.report.kind === "urgent";
  const name = rowEnds(row);
  const words = (end: NameEnd) => [t(`reportFeed.row.party.${end.party}`), end.taskId, end.agent, end.title].filter(Boolean).join(" ");
  const said = "own" in name ? t("reportFeed.row.own", { who: words(name.own) })
    : t("reportFeed.row.between", { from: words(name.ends[0]), to: words(name.ends[1]) });
  // The head's first line is as tall open as closed: the line itself keeps the 1px a closed row's tags stand out
  // above and below its words (their py-px), so the tags going when it opens move nothing. A phone's tags are a step
  // smaller than the line, so there they never made it taller.
  return <span data-row-name className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-x-1 whitespace-nowrap py-px narrow:gap-x-0.5 narrow:py-0 text-xs text-soft group-hover/row:text-ink group-data-lit/row:text-ink">
    <span data-row-said className="sr-only">{said}</span>
    <span data-row-kind className={`flex-none ${urgent ? "font-semibold text-turn" : ""}`}>{kindWord}</span>
    {row.older.length > 0 && <span data-row-times className="flex-none tabular-nums">{t("reportFeed.row.times", { n: row.older.length + 1 })}</span>}
    {/* On a phone the tags are a step smaller than the words beside them, so two long agents stay whole on one line. */}
    {/* Cut across only: cut all round, a phone's tight small line cut the agents' g and p off below. */}
    {!open && <span data-row-ends className="-my-px ml-1.5 flex min-w-0 items-baseline overflow-x-clip gap-x-1 narrow:my-0 narrow:ml-0.5 narrow:gap-x-0.5 narrow:text-micro">
      <PartyTag end={"own" in name ? name.own : name.ends[0]} />
      {"ends" in name && <><TextMark className="narrow:mx-px"><Icon name="arrowRight" data-row-arrow className="size-3.5 narrow:size-3 text-muted group-hover/row:text-ink group-data-lit/row:text-ink" /></TextMark>
        <PartyTag end={name.ends[1]} /></>}
    </span>}
  </span>;
}

/** Each kind of party's one look (styles/reader.css gives its colour): people round, a member a ring, Tasks square, each with its own mark. */
const PARTY_MARK = { you: "human", coordinator: "chat", member: "member", self: "thisTask", parent: "parentTask", child: "childTask", other: "otherTask" } as const satisfies Record<NameEnd["party"], IconName>;
const PERSON = new Set<NameEnd["party"]>(["you", "coordinator", "member"]);

/** A party's mark before its words, centred on their capitals (TextMark): every tag of who, and a working child's line. */
function PartyMark({ party }: { party: NameEnd["party"] }) {
  return <TextMark><Icon name={PARTY_MARK[party]} className="party-mark size-3.5" /></TextMark>;
}

/**
 * One end of a row as a tag: its kind's mark, who it is, then the agent its Run ran (opus(high)), which is never cut.
 * Short (a closed row): the parent and a child are their one word (Parent, Child: which one is said by the tag's label and the
 * open row), any other Task its ID, a person their word, and the open Task, on nearly every row, only its mark
 * and agent, so the other end is the one that stands out. Whole (an open row's top): the kind's word, the ID and the
 * agent, and no title (the title is the Task's own page, said only in the tag's label). A tag naming another Task
 * is the way to it (`onOpen`): the whole tag is the one button, and all its words are underlined as one link.
 */
function PartyTag({ end, whole, onOpen }: { end: NameEnd; whole?: boolean; onOpen?: (button: HTMLElement) => void }) {
  const { reader: t } = useFeedWords();
  const agentNames = useContext(AgentNames);
  const agent = end.agent && modelLabel(end.agent, agentNames);
  const kin = end.party === "parent" || end.party === "child";
  const task = !PERSON.has(end.party) && end.party !== "self";
  // Short, an end with an agent is its mark and agent: its mark and colour say who (you have no agent, so your word stays).
  const word = whole ? t(`reportFeed.row.tag.${end.party}`) : kin ? t(`reportFeed.row.party.${end.party}`) : !end.agent && PERSON.has(end.party) ? t(`reportFeed.row.tag.${end.party}`) : null;
  const parts = [
    word && <span key="party" data-row-party className={`flex-none ${end.party === "self" ? "" : "font-semibold"}`}>{word}</span>,
    task && end.taskId && (whole || !kin) && <span key="task" data-row-task className="flex-none font-semibold tabular-nums">{end.taskId}</span>,
    agent && (whole ? <span key="agent" data-row-agent title={agent.full} className="whitespace-nowrap">{agent.full}</span>
      : <AgentLabel key="agent" data-row-agent label={agent} />),
  ].filter(Boolean);
  // The mark stands on the words' baseline, so whole it centres on their first line, even when they wrap below it; the
  // words are one run of text (spaces between them, not gaps), so a link's underline runs unbroken from its kind's word
  // to its effort.
  const inside = <>
    <PartyMark party={end.party} />
    {whole ? <span className={`min-w-0 ${onOpen ? "underline underline-offset-2" : ""}`}>{parts.flatMap((part, at) => at ? [" ", part] : [part])}</span> : parts}
  </>;
  const shape = "party-tag gap-1 py-px narrow:gap-0.5";
  if (whole) {
    if (!onOpen) return <span data-row-end={end.party} className={`${shape} inline-flex max-w-full items-baseline`}>{inside}</span>;
    const openWords = t("reportFeed.row.openTask", { task: [end.taskId, end.title].filter(Boolean).join(" ") });
    return <button type="button" data-row-end={end.party} data-row-open data-task-reference={end.taskId} title={openWords} aria-label={openWords}
      onClick={event => onOpen(event.currentTarget)}
      className={`${shape} inline-flex max-w-full items-baseline text-left hover:text-ink focus-visible:outline-2 focus-visible:outline-ink`}>{inside}</button>;
  }
  const title = end.party === "coordinator" ? t("ui:role.coordinatorDescription") : kin ? [end.taskId, end.title].filter(Boolean).join(" ") : end.title;
  // Short, it narrows only as far as its agent's name is ellipsized: narrowed further, the arrow after it lay over
  // its last words (You at 320px). On a phone it stands on the line's baseline with no 1px over and under, which would
  // make the head 0.05px taller closed than open.
  return <span aria-hidden data-row-end={end.party} title={title} className={`${shape} inline-flex max-w-full items-baseline whitespace-nowrap narrow:py-0`}>{inside}</span>;
}

/**
 * At the top of an open row: who it was between, whole, from on the left to on the right. A tag naming another
 * Task is the way to it, followed as any task reference in the row is (followReference: Back reopens this row and marks
 * the tag); no separate line stands for the link.
 */
function RowParties({ row, onFollow }: { row: HistoryRow; onFollow: (id: string) => void }) {
  const name = rowEnds(row);
  const tag = (end: NameEnd) => <PartyTag end={end} whole onOpen={end.taskId && end.party !== "self"
    ? button => followReference(button, end.taskId!, () => onFollow(end.taskId!)) : undefined} />;
  // From, then the arrow and to: on one line where both fit, else to goes under from with its arrow. Each end whole.
  return <div data-row-parties className="mb-2 flex flex-wrap items-baseline gap-x-1 gap-y-1 text-xs text-soft">
    {"own" in name ? tag(name.own) : <>{tag(name.ends[0])}
      <span className="flex max-w-full items-baseline gap-x-1"><TextMark><Icon name="arrowRight" className="size-3.5 text-muted" /></TextMark>{tag(name.ends[1])}</span></>}
  </div>;
}

/** How a question or a review ended, or who it waits on, said under its words in one way. */
function RowEnd({ outcome }: { outcome: RowOutcome }) {
  const { reader: t } = useFeedWords();
  // The time follows a "·" in "answered · Yesterday 16:51", so it is said as a label.
  const clock = useFeedClock(true);
  const party = (who: NameEnd["party"]) => t(`reportFeed.row.party.${who}`);
  const words = outcome.kind === "answered" || outcome.kind === "confirmed" ? t(`reportFeed.row.end.${outcome.kind}`, { who: party(outcome.who), at: clock(outcome.at) })
    // Waiting on you says "your review"; the others name their party.
    : outcome.kind === "waiting" ? t(`reportFeed.row.end.${outcome.review ? "waitingReview" : "waiting"}${outcome.on === "you" ? "You" : ""}`, { who: party(outcome.on) })
    : outcome.kind === "closed" ? t(`reportFeed.row.end.closed.${outcome.why}`)
    : t(`reportFeed.row.end.${outcome.kind as "again" | "replaced" | "resumed"}.${(outcome as { question: boolean }).question ? "question" : "review"}`);
  const yours = outcome.kind === "waiting" && outcome.on === "you";
  return <span data-row-end-words className={`col-span-2 col-start-1 mt-0.5 min-w-0 truncate text-xs ${yours ? "font-medium text-turn" : "text-soft group-hover/row:text-ink group-data-lit/row:text-ink"}`}>{words}</span>;
}

const TaskPeople = createContext<PeopleIndex | null>(null);
const useTaskPeople = () => useContext(TaskPeople);
/**
 * Who a row is between, as its head and its open body both say it: a stop the AI stack carried on goes from the AI that
 * stopped to the one that took over, not back to its requester.
 */
function rowEnds(row: HistoryRow): HistoryRow["name"] {
  const { carriedOn, recipient } = row.report;
  return carriedOn && recipient && "ends" in row.name
    ? { ends: [row.name.ends[0], { ...row.name.ends[0], agent: carriedOnAgent(recipient) }] } : row.name;
}
const carriedOnAgent = (agent: NonNullable<ReportEvent["recipient"]>) =>
  runAgentLabel({ agent: agent.profileKey, modelId: agent.modelId ?? null, effort: agent.effort ?? null });
function carriedOnWords(report: ReportEvent, names: readonly ModelName[], t: TFunction<"reader">, ui: TFunction<"ui">): string {
  const reason = report.cause ? limitName(report.cause, ui) : t("reportFeed.row.carriedOn.limit");
  const next = report.recipient;
  return next ? t("reportFeed.row.carriedOn.to", { reason, next: `${next.profileKey} ${modelLabel(carriedOnAgent(next), names).short}` })
    : t("reportFeed.row.carriedOn.next", { reason });
}
const AgentNames = createContext<readonly ModelName[]>([]);

/** Parents whose work below was unfolded, so coming Back from a child finds the row as it was left. */
const unfoldedBelow = new Set<string>();

/** One owner of which working rows are drawn and which names those rows add to the History's scope. */
function FeedAgents({ taskId, historyNames, children }: { taskId: string; historyNames: readonly ModelName[]; children: ReactNode }) {
  const { t } = useTranslation("reader");
  const people = usePeopleFor(taskId, true);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState(() => unfoldedBelow.has(taskId));
  const unfold = (next: boolean) => { if (next) unfoldedBelow.add(taskId); else unfoldedBelow.delete(taskId); setUnfolded(next); };
  const runs = working(taskId, people);
  const work = childWork(taskId, people);
  const open = !!runs[0] && openRun === runs[0].id;
  const shownRuns = open ? runs : runs.slice(0, 1);
  const shownWork = unfolded ? work : work.slice(0, 1);
  const names = [...historyNames, ...shownRuns.map(run => agentModelName(run.modelId, run.effort, run.agent)),
    ...shownWork.map(item => { const run = item.runs[0]!; return agentModelName(run.modelId, run.effort, run.agent); })];
  // Runtime activity updates do not change the set, so memoized History tags only redraw when their names change.
  const namesKey = JSON.stringify(names);
  const agentNames = useMemo(() => names, [namesKey, t]);
  const view = { runs, work, open, unfolded, unfold,
    setOpen: (next: boolean) => setOpenRun(next ? runs[0]?.id ?? null : null) };
  return <TaskPeople.Provider value={people}><WorkingView.Provider value={view}><AgentNames.Provider value={agentNames}>
    {children}
  </AgentNames.Provider></WorkingView.Provider></TaskPeople.Provider>;
}
type WorkingViewValue = { runs: ControlRunDTO[]; work: ChildWork[];
  open: boolean; unfolded: boolean; unfold: (next: boolean) => void; setOpen: (next: boolean) => void };
const WorkingView = createContext<WorkingViewValue | null>(null);

/**
 * The column's top row while work goes on, here or below: what the reader wants of work going on,
 * and no more. This Task's own people come first: how long the responsible person (whom the input sends to; otherwise
 * the first member) has worked where a report has its clock, their latest words in two lines, their model and how many
 * others work beside them; a press opens the words whole and each other person's. Then each Task below with someone at
 * work, one line each that opens it, children before grandchildren (childWork). Folded, the row shows the first of
 * each, so who works here and where below are both seen, and how many more there are below. Under each person's words
 * is their latest step on one line (RunSteps); open, the responsible person's is in full with the ones before it. The
 * task's tokens are in About. Each working line ends with how full its agent's conversation is (ContextMeter).
 * It reads only each Run's latest activity, never the agent's output log, and
 * FeedAgents reads the subtree and shares exactly the rows drawn here with the name scope.
 */
function WorkingRow({ task, onFollow }: { task: TaskDetail; onFollow: (id: string) => void }) {
  const { t } = useTranslation("reader");
  const { runs, work, unfolded, unfold } = useContext(WorkingView)!;
  if (!runs.length && !work.length) return null;
  const hidden = unfolded ? 0 : work.length - 1;
  const [first, ...more] = work;
  // The Tasks past the first unfold under it as every History disclosure does (DisclosureBody), not at once.
  // Its rule starts on the words' line, as every record's and the questions bar's do.
  return <li data-working-row data-motion-key="working" className="relative pl-(--gutter)"><div className="border-b border-rule py-1">
    {runs[0] && <WorkingRuns key={runs[0].id} task={task} runs={runs} onFollow={onFollow} />}
    {first && <ul data-working-below={work.length} className="m-0 list-none p-0">
      <li><ChildWorkLine item={first} mark={!runs.length} onFollow={onFollow} /></li>
      {more.length > 0 && <li><DisclosureBody open={unfolded}><ul className="m-0 list-none p-0">
        {more.map(item => <li key={item.id}><ChildWorkLine item={item} mark={false} onFollow={onFollow} /></li>)}
      </ul></DisclosureBody></li>}
    </ul>}
    {more.length > 0 && <button type="button" data-working-more aria-expanded={unfolded} onClick={() => unfold(!unfolded)}
      className="ml-[calc(4.6ch+--spacing(2))] flex items-center gap-1 py-1.5 text-xs text-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-ink narrow:ml-0 narrow:min-h-11">
      {unfolded ? t("reportFeed.childWorking.fold") : t("reportFeed.childWorking.others", { count: hidden })}
      <Icon name="down" className={`size-3.5 transition-transform duration-(--motion-base) ${unfolded ? "rotate-180" : ""}`} /></button>}
  </div></li>;
}

function WorkingRuns({ task, runs, onFollow }: { task: TaskDetail; runs: ControlRunDTO[]; onFollow: (id: string) => void }) {
  const { t } = useTranslation("reader");
  const { open, setOpen } = useContext(WorkingView)!;
  const [lead, ...rest] = runs as [ControlRunDTO, ...ControlRunDTO[]];
  const others = rest.length;
  // A press that ends a selection of the words keeps the row as it is, so they can be copied.
  const toggle = (event: React.MouseEvent) => { if (!(event.target as Element).closest("button, a") && window.getSelection()?.isCollapsed !== false) setOpen(!open); };
  return <div role="button" tabIndex={0} aria-expanded={open} onClick={toggle} data-working-here
    onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setOpen(!open); } }}
    className="group/row flex cursor-pointer flex-col py-1.5 outline-none focus-visible:outline-2 focus-visible:outline-ring narrow:min-h-11">
    <WorkingPerson run={lead} task={task} onFollow={onFollow} open={open} lead
      others={others > 0 && !open ? <span data-working-others>{t("reportFeed.working.others", { count: others })}</span> : null} />
    {others > 0 && <DisclosureBody open={open}><div className="flex flex-col gap-2 pt-2">
      {rest.map(run => <WorkingPerson key={run.id} run={run} task={task} onFollow={onFollow} open lead={false} />)}
    </div></DisclosureBody>}
  </div>;
}

/**
 * One working person as a History row: time worked, who it is, their words, and their work line under that (the moving
 * mark and the latest step, or what it is at before any). The lead's words open and close as every History disclosure
 * does (LeadNote), and its ⌄ turns with them; opened, its work line counts the steps and every one is listed under it,
 * read then (they come at once: they change every few seconds, so they do not ride the disclosure's move). Everyone
 * else's words are open and their work line is always the one line, so the body holding them keeps its height while
 * steps go by: they are drawn only inside the row's body.
 */
function WorkingPerson({ run, task, onFollow, open, lead, others }: { run: ControlRunDTO; task: TaskDetail; onFollow: (id: string) => void; open: boolean; lead: boolean; others?: ReactNode }) {
  const { t } = useTranslation("reader");
  const duration = useDuration();
  const step = useActivityText();
  const people = useTaskPeople();
  const model = modelLabel(runAgentLabel(run), useContext(AgentNames));
  const steps = run.activity?.steps ?? [];
  // Opened, the lead's line counts its steps and every one of them is listed under it.
  // Brought up to date whenever any of its steps starts or ends, however many run at once.
  // Whether there is a list is whether the Run has taken any step, not whether the latest few came with its activity.
  const latest = steps.at(-1), worked = !!latest || (run.activity?.stepEvents ?? 0) > 0, listed = lead && open && worked;
  const full = useRunSteps(run.id, listed, run.activity?.stepEvents ?? 0);
  const count = stepCount(full);
  const words = run.activity?.note?.text ?? "";
  const member = people?.placements.get(run.placementId)?.responsible === false;
  const names = useContext(AgentNames);
  const { t: ui } = useTranslation("ui"), { t: say } = useTranslation("people");
  // Before it has run anything, the line says so in the words a Run's last sign of life has.
  const idle = step(run.activity) || ui("coordinatorCard.thinking");
  // The Run it took the request over from, when the one before stopped on a limit.
  const before = people ? [...people.runsByTask.get(run.taskId) ?? []].find(each => each.supersededBy === run.id) : undefined;
  const beforeCause = before?.availability?.cause ?? before?.errorCause?.cause;
  const cell = "col-start-2 min-w-0 narrow:col-span-2 narrow:col-start-1";
  // These words can wrap: share their first baseline with the time, rather than centring it on all their lines.
  return <div data-working-person={run.placementId} className={`${RECORD_HEAD} items-baseline !p-0`}>
    <RailTime mark={lead ? WORKING_MARK : undefined} live>{duration(run.startedAt)}</RailTime>
    <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-x-2 text-xs text-soft group-hover/row:text-ink">
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
      <span className="font-medium">{t(`reportFeed.row.party.${member ? "member" : "self"}`)}</span>
      <AgentLabel data-working-model label={model} /><span>{t("reportFeed.row.working")}</span>{others && <>·{others}</>}
      {before && <span data-working-took-over>· {t("reportFeed.working.tookOver", { agent: `${before.agent} ${modelLabel(runAgentLabel(before), names).short}`,
        reason: beforeCause ? limitName(beforeCause, ui) : t("reportFeed.row.carriedOn.limit") })}</span>}
      </span>
      {/* Every working line ends its first line with the same meter, so the figures stand in one column. */}
      {run.activity?.context && <span className="flex-none self-center"><ContextMeter context={run.activity.context} press /></span>}</span>
    {!words ? null : !lead ? <div data-working-note dir="auto" className={`${cell} ${NOTE} text-sm block text-ink`}><MarkdownBody text={words} task={task} onFollow={onFollow} report variant="note" /></div>
      : <LeadNote open={open} words={words} task={task} onFollow={onFollow} className={cell} />}
    <WorkLine step={latest} idle={idle} label={listed && count !== undefined ? say("now.step.count", { count }) : undefined} className={`${cell} mt-1.5 text-xs`} />
    {listed && <StepList steps={full} className={`${cell} mt-1`} />}
    {/* As wide as a child line's → keeps past its end (press-end: 16px less a sixth), so every meter ends on one edge. */}
    <span className="col-start-3 row-start-1 flex w-[calc(var(--spacing)*4*20/24)] items-center justify-end self-center">{lead && <DisclosureChevron open={open} />}</span>
  </div>;
}

const NOTE = "mt-0.5 min-w-0 [overflow-wrap:anywhere] [&>div]:text-inherit";

/**
 * The lead's words, one copy open or folded: folded, its DisclosureBody keeps their first whole lines shown (up to
 * two, as useLineClip draws them), and opening unfolds the rest under them over the same step and curve as every History
 * disclosure, so no line is drawn twice on the way. The "…" goes as it opens and comes back once it has folded.
 */
function LeadNote({ open, words, task, onFollow, className }: { open: boolean; words: string; task: TaskDetail; onFollow: (id: string) => void; className: string }) {
  const [shut, setShut] = useState(!open);
  if (open && shut) setShut(false);
  useEffect(() => {
    if (open || shut) return;
    const timer = setTimeout(() => setShut(true), reducedMotion() ? 0 : duration("base"));
    return () => clearTimeout(timer);
  }, [open, shut]);
  const clip = useLineClip(!shut, words);
  // What stays shown folded: the words' first whole lines as they are drawn now, open or not, so a fold always ends
  // on the words it holds then.
  const [least, setLeast] = useState(0);
  useLayoutEffect(() => {
    const box = clip.current, content = box?.firstElementChild;
    if (!box || !content) return;
    const measure = () => setLeast(wholeLinesHeight(box) + Number.parseFloat(getComputedStyle(box).marginTop));
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(content);
    return () => observer?.disconnect();
  }, [clip, words]);
  return <div className={className}><DisclosureBody open={open} least={least}>
    <div ref={clip} data-working-note dir="auto" className={`${NOTE} text-sm ${shut ? `line-clamp-2 ${ROW_WORDS}` : "block text-ink"}`}>
      <MarkdownBody text={words} task={task} onFollow={onFollow} report variant="note" /></div>
  </DisclosureBody></div>;
}

/**
 * One Task below at work, read as this Task's own people are: how long, then which Task (a child, or Grandchild for any deeper
 * one, its path from here said in its label) and the model working on it, then what it is. The row it stands in already
 * says this is work going on: only its first line (the one with the mark, when this Task itself does not work) says so. The whole line opens it.
 */
function ChildWorkLine({ item, mark, onFollow }: { item: ChildWork; mark: boolean; onFollow: (id: string) => void }) {
  const { t } = useTranslation("reader");
  const duration = useDuration();
  const run = item.runs[0]!;
  const model = modelLabel(runAgentLabel(run), useContext(AgentNames));
  const others = item.runs.length - 1;
  const words = t("reportFeed.row.openTask", { task: `${item.path.join(" › ")} ${item.title} ${model.full}` });
  return <button type="button" data-child-work={item.id} data-task-reference={item.id} title={words} aria-label={words}
    onClick={event => { const button = event.currentTarget; followReference(button, item.id, () => onFollow(item.id)); }}
    className={`${RECORD_HEAD} group/row w-full items-baseline !py-1.5 focus-visible:outline-2 focus-visible:outline-ink`}>
    <RailTime mark={mark ? WORKING_MARK : undefined} live>{duration(run.startedAt)}</RailTime>
    <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-x-2 text-xs text-soft group-hover/row:text-ink">
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
      <span data-row-end="child" className="party-tag inline-flex items-baseline gap-1 font-medium">
        <PartyMark party="child" />
        <span>{t(item.path.length > 1 ? "reportFeed.childWorking.grandchild" : "reportFeed.row.party.child")}</span><span className="tabular-nums">{item.id}</span></span>
      <AgentLabel data-child-work-model label={model} />{mark && <span>{t("reportFeed.row.working")}</span>}
      {others > 0 && <span data-child-work-others className="whitespace-nowrap">·&nbsp;{t("reportFeed.working.others", { count: others })}</span>}
      </span>
      {run.activity?.context && <span className="flex-none self-center"><ContextMeter context={run.activity.context} press={false} /></span>}</span>
    <span data-child-work-title className={`col-start-2 mt-0.5 line-clamp-2 min-w-0 text-sm ${ROW_WORDS} [overflow-wrap:anywhere] narrow:col-span-2 narrow:col-start-1`}>{item.title}</span>
    <Icon name="right" className="press-end col-start-3 row-start-1 row-span-2 size-4 self-center text-muted group-hover/row:text-ink [--edge-press:--spacing(4)]" />
  </button>;
}

/**
 * Context, the reader's page of the task itself: its context as its launches carry it, with a copy of that
 * same text. The entry under the title opens it (`ReaderEntries`); it has no time.
 */
export function ContextPage({ task, onFollow }: { task: TaskDetail; onFollow: (id: string) => void }) {
  return <div className="text-ink"><TaskAbout task={task} onFollow={onFollow} />
    <BodyCopy text={() => reportCopy(taskCopy(task), task.values.context)} /></div>;
}

/**
 * One motion rule for every report disclosure: its height goes from where it is drawn to its body's height, or
 * back to nothing, over --motion-base in-out, and open it follows its body's height. The height itself moves, so what
 * it shows is always all of its height: a grid row's fr did not, and left a band with nothing in it under the words on
 * the way. It moves as a transition, so the reader keeps its place by its events (reading-position). With `least`,
 * folded it still shows that many pixels of its top, read and pressed as they are (the Working row's lines, LeadNote).
 */
function DisclosureBody({ open, least, children }: { open: boolean; least?: number; children: ReactNode }) {
  const [seen, setSeen] = useState(open);
  // Latch before committing: the body's first opening must not cause a second commit just to remember it was seen.
  if (open && !seen) setSeen(true);
  const peeks = least !== undefined, hidden = !open && !peeks;
  const body = useRef<HTMLDivElement>(null), shown = useRef(open);
  useLayoutEffect(() => {
    const box = body.current;
    if (!box) return;
    const folded = `${least ?? 0}px`;
    const moving = shown.current !== open;
    shown.current = open;
    // Not turned: folded, it keeps to what it still shows, at once (first measured, or its words changed), as words in
    // a row change; a fold under way goes on to it. Open, it follows its body.
    if (!moving) {
      if (open || box.style.height === folded) return;
      // First drawn, it stands at its own height (auto), which nothing glides from: no reflow to hold the glide back.
      // History draws a hundred of these at once, and a reflow for each laid the whole reader out that many times.
      if (box.style.height === "") { box.style.height = folded; return; }
      const folding = box.getAnimations().some(move => move.playState === "running");
      if (!folding) box.style.transition = "none";
      box.style.height = folded;
      if (!folding) { void box.offsetHeight; box.style.transition = ""; }
      return;
    }
    // From where it is drawn, a move turned back on the way included.
    const from = box.getBoundingClientRect().height, to = open ? box.scrollHeight : least ?? 0;
    if (reducedMotion() || Math.abs(to - from) < 1) { box.style.height = open ? "" : folded; return; }
    box.style.height = `${from}px`;
    void box.offsetHeight;
    box.style.height = `${to}px`;
  }, [open, least]);
  // Arrived open (or stopped on the way while open), it follows its body again.
  const arrived = (event: React.TransitionEvent<HTMLDivElement>) => {
    const box = event.currentTarget;
    if (event.target !== box || event.propertyName !== "height" || !shown.current) return;
    // A move stopped because it was turned back is taken over by the move that turned it.
    if (event.type === "transitioncancel" && box.getAnimations().some(move => move.playState === "running")) return;
    box.style.height = "";
  };
  // The clip reaches 12px past the body's right edge (the reader's own room there), so a press ending on that edge is whole.
  return <div ref={body} data-disclosure-body data-open={open} aria-hidden={hidden} inert={hidden} onTransitionEnd={arrived} onTransitionCancel={arrived}
    className="-mr-3 overflow-hidden pr-3 transition-[height] duration-(--motion-base)">
    {open || seen || peeks ? children : null}
  </div>;
}

/**
 * A row whose body says its first line (an instruction, an answer, a dialogue) hands that line over as it
 * opens and takes it back as it closes, one move either way: the head's words fold to nothing as the body unfolds, and
 * come back from nothing as it folds, on DisclosureBody's own step and curve. The words stay drawn while they fold, so
 * the line is never gone from the row: the body's own copy stands under who it was between, and its unfolding reaches
 * it only after them. Taken away at once, the line left an empty band for that time and then came back lower, which
 * read as the words blinking. The row only grows as it opens and only shrinks as it closes: the line and the
 * body move on the same curve, and the body is taller than the line.
 * Returns `leaving`: the words are still drawn, folding, though the body already says them.
 */
function useHandOver(handed: boolean, words: RefObject<HTMLElement | null>) {
  const [was, setWas] = useState(handed), [leaving, setLeaving] = useState(false);
  // Known before committing, so the words are never unmounted for the commit that opens the body.
  if (was !== handed) { setWas(handed); setLeaving(handed && !reducedMotion()); }
  const moving = useRef<Animation | null>(null), shown = useRef(handed);
  useLayoutEffect(() => {
    const line = words.current;
    if (shown.current === handed) return;
    shown.current = handed;
    // Turned back on the way, the line goes on from where it is drawn; else from all of it (folding) or nothing.
    const from = moving.current && line ? { height: `${line.offsetHeight}px`, marginTop: getComputedStyle(line).marginTop } : null;
    moving.current = null;
    if (!line) return;
    // Every move the line still holds goes, a fold that finished but kept its end too: it is measured as it stands.
    for (const each of line.getAnimations()) each.cancel();
    if (reducedMotion()) return;
    const full = line.offsetHeight, drawn = { height: `${full}px`, marginTop: getComputedStyle(line).marginTop }, gone = { height: "0px", marginTop: "0px" };
    // Turned back, the line takes only the share of the step it has to go, as the body's own transition does when reversed.
    const at = from ? Number.parseFloat(from.height) : 0, share = from && full > 0 ? Math.min(1, (handed ? at : full - at) / full) : 1;
    const move = line.animate(handed ? [from ?? drawn, gone] : [from ?? gone, drawn],
      { duration: duration("base") * share, easing: easing("in-out"), fill: handed ? "forwards" : "none" });
    move.onfinish = () => { moving.current = null; if (handed) setLeaving(false); };
    moving.current = move;
  }, [handed, words]);
  return leaving;
}

/** The disclosure's icon is centred with the other parts of its row's head. */
function DisclosureChevron({ open }: { open: boolean }) {
  return <Icon name="down" className={`press-end size-3 flex-none [--edge-press:--spacing(3)] [--edge-icon:--spacing(3)] text-muted group-hover/row:text-ink group-data-lit/row:text-ink transition-transform duration-(--motion-base) ${open ? "rotate-180" : ""}`} />;
}

/**
 * An opened detail's copy: what it reads, with its Markdown as written. It closes the body at the right, under the
 * words it copies and the question they ask, so the title keeps the row's whole width and a question with no
 * words before it opens on the question, not on a line holding only this mark.
 */
function BodyCopy({ text, beside }: { text: () => string; beside?: string | null }) {
  const { t } = useTranslation("reader");
  // 4px round it, so its focus ring is not cut by the disclosure's clip. Whether it was taken in closes the body with it, on its left.
  // Its icon ends on the row's right edge, over the disclosure's ∨ (press-end); the disclosure's clip reaches past that edge.
  return <div className="flex items-center justify-between gap-2 py-1 pl-1">
    {beside ? <p data-row-received className="m-0 text-xs text-muted">{beside}</p> : <span />}
    <CopyButton clip={() => textClip(text())} label={t("reportFeed.copy")} className="press-end press-reach min-h-7 w-(--edge-press) narrow:min-h-11 narrow:w-(--edge-press) [--edge-press:--spacing(7)] [--edge-icon:--spacing(3.5)]" /></div>;
}



/** The working row's mark: someone's Run is going, so it pulses (RailTime's `live`). */
const WORKING_MARK = { kind: "start", tone: "working" } as const satisfies NonNullable<ReportEvent["mark"]>;

/**
 * Every row's time and the mark it puts on the column's rail, so each mark stands the same way beside its time.
 * A record centres the time on its single-line head; a working row aligns it with its first line. The time's box is
 * trimmed to its capitals over its baseline, so the mark centres on the figures as drawn, whatever size the text is
 * set to, as the list's marks centre on a row's id (RowLines). A browser without text-box centres it on the time's
 * whole line, a pixel or so lower. The mark stands beside the time, not in it, so the time holds only its own text.
 * `live`: the row is work going on now (the working row), and its mark pulses (TimelineMark). The time is said in the
 * row's one quiet colour, as what it is and who it was between, under its words.
 */
function RailTime({ mark, live, children }: { mark?: ReportEvent["mark"]; live?: boolean; children: ReactNode }) {
  return <span data-rail-time className="relative min-w-[4.6ch] flex-none text-xs whitespace-nowrap tabular-nums text-soft group-hover/row:text-ink group-data-lit/row:text-ink [text-box:trim-both_cap_alphabetic]">
    {/* A quiet mark darkens with its row's words; one that says what you act on keeps its colour. */}
    {mark && <TimelineMark kind={mark.kind} tone={mark.tone} live={live} className={`${ON_RAIL} -ml-(--gutter) top-1/2 -translate-y-1/2 ${mark.tone === "quiet" ? "group-hover/row:text-ink group-data-lit/row:text-ink" : ""}`} />}
    {children}</span>;
}

/** A row's head: 10px above its words, and every part on the first line's baseline, so ⌄ (an icon sits on the
 * baseline) and the time line up with a title of any length. Below it, 10px to the divider when closed, and 12px to
 * its own body when open: wider than the title's own and the body's line gaps, so the title stands apart from
 * its body whether it takes one line or wraps (a thumbnail's -6px keeps a one-line row its height). A narrow screen
 * keeps the 44px a finger needs inside the head itself, which a one-line title with its 12px below already nearly
 * fills, so its body sits as far from it as under a wrapped title. */
const ROW_HEAD = "flex min-w-0 items-baseline gap-2 pt-2.5";
const headEnd = (open: boolean, least: string) => open ? "pb-3 narrow:min-h-11" : `pb-2.5 ${least}`;


/**
 * A History with no record yet, of a task no AI owns, says it has not started and what starts it (before-work), in place
 * of a blank column.
 */
function EmptyHistoryNote({ task, owned }: { task: TaskDetail; owned: boolean }) {
  const { t } = useTranslation("reader");
  const { runs, work } = useContext(WorkingView)!;
  if (beforeWork(task, owned) !== "unassigned" || runs.length || work.length) return null;
  return <Message data-empty-history="unassigned" tone="empty" icon="history" live
    title={t("reportFeed.empty.unassigned.title")} description={t("reportFeed.empty.unassigned.next")} />;
}

/**
 * A task not started whose AI owner is placed shows that owner at work, as the working row shows a Run at work, from
 * the time it was placed: until its Run starts (no request yet, or one waiting for its turn) and the working row takes over.
 * Work going on below is the working row's to say; a task waiting for others to finish first says so in its own row.
 */
function AssignedRow({ task }: { task: TaskDetail }) {
  const { t } = useTranslation("reader");
  const { runs, work } = useContext(WorkingView)!;
  const people = useTaskPeople();
  const names = useContext(AgentNames);
  const duration = useDuration();
  const owner = people ? crewOf(task.id, people).responsible : null;
  if (!people || !owner || runs.length || work.length || beforeWork(task, true) !== "assigned") return null;
  // Before its first Run the owner has no effort yet: it is named alone, not "not started" beside "at work".
  const model = modelLabel(people.runsByPlacement.get(owner.id)?.length ? placementAgentLabel(owner, people) : owner.profileKey, names);
  return <li data-assigned-row data-motion-key="working" className="relative pl-(--gutter)"><div className="border-b border-rule py-1">
    <div className={`${RECORD_HEAD} items-baseline !py-1.5`}>
      <RailTime mark={WORKING_MARK} live>{duration(owner.startedAt)}</RailTime>
      <span className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs text-soft">
        <span className="font-medium">{t("reportFeed.row.party.self")}</span>
        <AgentLabel label={model} /><span>{t("reportFeed.row.working")}</span></span>
    </div>
  </div></li>;
}

/** A single entry point into the existing navigation/acquisition effect. Server membership owns question state: this Task's own questions to you. */
function QuestionsBar({ task }: { task: TaskDetail }) {
  const { t } = useTranslation('reader');
  const clock = useFeedClock();
  const label = useFeedClock(true);
  const questions = [...task.userQuestions ?? []].sort((a, b) => b.askedAt.localeCompare(a.askedAt));
  const [open, setOpen] = useState(false);
  if (!questions.length) return null;
  const go = (question: (typeof questions)[number]) => useTimeView.getState().pick(task.id, logKey(question.taskId, question.id));
  const one = questions.length === 1 ? questions[0]! : null;
  return <li data-questions-bar data-motion-key="questions" className="relative pl-(--gutter)"><div className="border-b border-rule">
    <button type="button" aria-expanded={one ? undefined : open} onClick={() => one ? go(one) : setOpen(!open)}
      aria-label={one ? t('reportFeed.goQuestion', { title: one.title }) : t('reportFeed.listQuestions', { count: questions.length })}
      className={`${ROW_HEAD} ${headEnd(false, 'min-h-11')} w-full items-center text-left text-sm`}>
      <Icon name="question" className="size-4 flex-none text-turn" />
      <span className="min-w-0 flex-1 font-semibold text-turn">{t('reportFeed.questions', { count: questions.length })}</span>
      {one ? <span className="flex-none text-xs font-medium text-turn">{t('reportFeed.goAnswer')}</span> : <DisclosureChevron open={open} />}
    </button>
    {!one && <DisclosureBody open={open}><ol className="m-0 list-none border-l border-rule p-0 pl-3">
      {questions.map(question => <li key={question.id} className="border-t border-rule">
        <button type="button" onClick={() => go(question)} aria-label={t('reportFeed.goQuestionAt', { at: clock(question.askedAt), title: question.title })}
          className="flex min-h-11 w-full items-baseline gap-2 py-2 text-left text-sm">
          <span className="flex-none text-xs tabular-nums text-muted">{label(question.askedAt)}</span>
          <span className="min-w-0 flex-1 line-clamp-2 text-ink">{question.title}</span>
          <span className="flex-none text-xs font-medium text-turn">{t('reportFeed.goAnswer')}</span></button></li>)}
    </ol></DisclosureBody>}
  </div></li>;
}

/** Today's start, read once by the timeline (useToday), so its times are drawn again only when the day turns. */
const Today = createContext(0);
/** The day the times in a part of the timeline stand under: their day's; above every divider, today. */
const DayBase = createContext<number | null>(null);

/** A time in the timeline, said as every timeline says one: the clock alone on the day it stands under, else with its day. */
function useFeedClock(alone = false) {
  const { people: t, locale } = useFeedWords();
  const today = useContext(Today);
  const base = useContext(DayBase);
  // Alone in a row it is a label ("Yesterday 16:51"); inside a sentence its day word stays lowercase.
  return (at: string) => (alone ? dayClockLabel : dayClock)(Date.parse(at), today, t, locale, base ?? today);
}

/** The rows by the reader's calendar day, newest first: a row (a group of reports, by its newest) stands under the day it was written. */
function feedDays(rows: HistoryRow[]) {
  const days: { key: string; at: number; rows: HistoryRow[] }[] = [];
  for (const row of rows) {
    const at = Date.parse(row.report.at);
    const date = new Date(at);
    const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    const day = days.at(-1);
    if (day && Number.isFinite(at) && day.key === key) day.rows.push(row);
    else days.push({ key, at, rows: [row] });
  }
  return days;
}

/**
 * A day's divider: it heads the day's rows and stays at the top while they pass under it, until the next day's pushes it
 * out (it is sticky inside its own day). Stuck, it only changes how it is drawn (styles.css, by scroll-state), so
 * scrolling moves no layout and runs no script. The list's motion places it by its day (`data-motion-sticky`).
 * Today's rows open the timeline with no divider: one is drawn only where a day has turned, over yesterday's and older.
 */
function DayHead({ at, motionKey }: { at: number; motionKey: string }) {
  const { t, i18n } = useTranslation("people");
  const today = useContext(Today);
  if (sameCalendarDay(at, today)) return null;
  const { name, date } = dayHeading(at, today, t, i18n.language);
  return <h3 data-day-head data-motion-key={motionKey} data-motion-sticky className="day-head m-0">
    <span data-day-words className="day-words flex items-center gap-1.5 text-xs tabular-nums">{name && <><span className="font-semibold text-ink">{name}</span>{" "}</>}
      <span className={name ? "text-muted" : "font-semibold text-ink"}>{date}</span></span></h3>;
}

/**
 * The people as History's rows name them (end-agent): the placements and each Run's agent and times. The same object
 * while those say the same, so a Run's activity or another Task's change does not lay the rows out again.
 */
function useAgentFacts(people: PeopleIndex): Pick<PeopleIndex, "placements" | "runsByPlacement"> {
  const held = useRef<{ key: string; facts: Pick<PeopleIndex, "placements" | "runsByPlacement"> } | null>(null);
  const parts: string[] = [];
  for (const placement of people.placements.values())
    parts.push(`${placement.id} ${placement.taskId} ${placement.profileKey} ${placement.responsible} ${placement.startedAt} ${placement.endedAt}`);
  for (const runs of people.runsByPlacement.values()) for (const run of runs)
    parts.push(`${run.id} ${run.placementId} ${run.agent} ${run.modelId ?? ""} ${run.effort ?? ""} ${run.createdAt} ${run.startedAt}`);
  const key = parts.join("\n");
  if (held.current?.key !== key) held.current = { key, facts: { placements: people.placements, runsByPlacement: people.runsByPlacement } };
  return held.current.facts;
}
