import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { noteReaderPlace, noteReaderPosition, noteReaderScroll, readerHistoryPosition, showingNavigation } from "@/state/reader-position";
import { shownInReader, useViewStore, type ReaderPane } from "@/state/view-store";
import { tint } from "@/lib/motion";
import { readerEventElement } from "./reader-event";
import { onReadingMove } from "./reading-move";

/** The file the view shows, if its pane shows one: what both a read request and "here" hold a file place to. */
const shownFile = (view: ReturnType<typeof useViewStore.getState>) => view.reader.pane === "files" ? view.filePath?.path || null : null;

type ReadRequest = { moved: boolean; key: string; event: string | null; position: NonNullable<ReturnType<typeof readerHistoryPosition>> };

/** Owns the original reading request and the lifetime of each automatic restoration attempt.
 * Human movement cancels only the attempt. Explicit Retry can restart the same unfinished acquisition;
 * leaving its task/pane/event discards the request. Pixels are meaningful only within that captured target. */
export function useReaderRestoration(content: RefObject<HTMLDivElement | null>, open: boolean, task: string | undefined,
  pane: ReaderPane, shownPath: string | null, readyTask: string | undefined, viewSettled: boolean, resetHeader: () => void,
  onStart: (scrolled: boolean) => void, placing: RefObject<string | null>) {
  const request = useRef<ReadRequest | null>(null);
  const acquired = useEffectEvent(() => viewSettled);
  const recheck = useRef<(() => void) | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    const original = request.current;
    if (!original) return;
    // Retry is the existing failed acquisition's explicit new attempt, not a new destination: the whole original
    // position is chosen again, the reference followed from it included.
    noteReaderPlace();
    noteReaderPosition(original.position);
    original.moved = false;
    placing.current = original.key;
    setAttempt(value => value + 1);
  }, []);
  const noteScroll = useCallback((scroll: number) => {
    // A cap stops automatic placement; native focus/layout scrolls still do not choose
    // a different position for an unfinished read. Vertical intent owns that choice.
    if (task && !placing.current && (!request.current || request.current.moved)) noteReaderScroll(task, pane, shownPath, scroll);
  }, [task, pane, shownPath, placing]);
  useEffect(() => {
    noteReaderPlace();
    const position = open && task ? readerHistoryPosition(task, pane, shownPath) : null;
    request.current = position ? { moved: false, key: `${task}/${pane}/${shownPath ?? ""}`,
      event: useViewStore.getState().event, position: { ...position } } : null;
    placing.current = request.current?.key ?? null;
    const area = content.current;
    area?.scrollTo(0, 0);
    onStart((area?.scrollTop ?? 0) > 0);
    resetHeader();
    if (!area) return;
    const taken = () => { if (placing.current) { placing.current = null; resetHeader(); } };
    const offMove = onReadingMove(area, () => {
      if (!request.current) return;
      request.current.moved = true;
      taken();
      // A move at the native scroll boundary may emit no scroll event. It still supersedes Retry's saved choice.
      if (task) noteReaderScroll(task, pane, shownPath, area.scrollTop);
    });
    // Invalidate synchronously, including an away-and-back before React paints another place.
    let event = useViewStore.getState().event;
    const offView = useViewStore.subscribe(view => {
      const original = request.current;
      if (original && (!view.reader.open || view.selected !== original.position.task
        || view.reader.pane !== original.position.pane || view.event !== original.event
        || shownFile(view) !== original.position.path)) {
        request.current = null; taken();
      }
      // Another row the person opened in the same place (its URL's event) is a step written over this one without the
      // position: where the reader actually stands now is chosen again, so it is kept without waiting for the next
      // scroll. A browser entry or URL shown here brings its own position, which the place left must not overwrite.
      const here = shownInReader(view) === task && view.reader.pane === pane
        && shownFile(view) === shownPath;
      if (here && task && view.event !== event && !request.current && !showingNavigation())
        noteReaderScroll(task, pane, shownPath, area.scrollTop);
      event = view.event;
    });
    return () => { offMove(); offView(); request.current = null; placing.current = null; };
  }, [open, task, pane, shownPath, resetHeader, onStart, content, placing, retry]);
  // Back on a place the reader left (Back, the browser's Back): it stands where it was read. What it shows may still be
  // coming (a file's text read after the task, older reports, pictures): it is placed again whenever that grows, until it
  // stands there, the person moves it themselves, or it leaves the place.
  useEffect(() => {
    if (!readyTask || !content.current) return;
    const original = request.current;
    if (!original || original.position.task !== readyTask) return;
    const { position: place, key } = original;
    const area = content.current;
    const settle = () => {
      if (!acquired()) return;
      request.current = null; placing.current = null; resetHeader();
      noteReaderPosition({ ...place, scroll: area.scrollTop });
      stop();
    };
    // The reference followed from here, marked once it is drawn (it is counted inside the row the URL's event names,
    // the one it was read in).
    let marked = place.referenceId === undefined;
    const mark = () => {
      if (marked) return;
      const event = useViewStore.getState().event;
      const scope = event ? readerEventElement(area, event) : area;
      const reference = scope?.querySelectorAll<HTMLElement>(`[data-task-reference="${CSS.escape(place.referenceId!)}"]`)[place.occurrence ?? 0];
      if (reference) { tint(reference, "turn", true); marked = true; }
    };
    // It is put back when it stands where it was read, whatever else it found on the way.
    const restore = () => {
      // Only the common move owner ends restoration for a person. Late acquisition must not put them back.
      if (request.current !== original) { stop(); return; }
      if (area.querySelector('[data-held-hidden="true"]')) return;
      // Observe growth before readiness checks, including files whose images have not supplied their height yet.
      for (const child of area.children) sizes?.observe(child);
      // A pixel is meaningful only after the same reading target and its disclosure have come. ReportFeed owns
      // acquiring that row (also for a saved position); reaching this pixel in an earlier page is not restoration.
      if (pane === "task") {
        const feed = area.querySelector("[data-report-feed]");
        if (!feed || feed.getAttribute("data-history-ready") !== "true") return;
        const event = useViewStore.getState().event;
        const target = event ? readerEventElement(area, event) : area;
        if (event && !target && feed.getAttribute("data-history-exhausted") === "true") {
          // History exhausted this address. An absent target is a completed lookup, not a latent retry intent.
          settle(); return;
        }
        if (event && (!target || target.closest('[data-disclosure-body][data-open="false"]')
          || target.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'false')) return;
      }
      // Acquisition can finish after the person moved. Retire the old request without moving them.
      if (placing.current !== key) {
        if (!acquired()) return;
        if (pane !== "task" && area.scrollHeight - area.clientHeight < place.scroll) return;
        request.current = null; stop(); return;
      }
      area.scrollTop = place.scroll;
      mark();
      // Disclosure transitions still change where that pixel falls. Their final transitionend also retries restore.
      const unfolding = [...area.querySelectorAll<HTMLElement>("[data-disclosure-body]")]
        .some(body => body.getAnimations?.().some(animation => animation.playState === "running"));
      if (Math.abs(area.scrollTop - place.scroll) <= 1 && marked && !unfolding) settle();
    };
    const observer = new MutationObserver(restore);
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restore);
    // Nothing more comes for long: it stays where it got to.
    const cap = setTimeout(() => {
      // End this automatic attempt; a failed read can still be explicitly retried later.
      if (placing.current === key) { placing.current = null; resetHeader(); }
      // Keep watching acquisition only: a late success retires the request without restoring its pixels.
    }, 30_000);
    function stop() {
      observer.disconnect(); sizes?.disconnect(); clearTimeout(cap);
      area.removeEventListener("transitionend", restore);
    }
    observer.observe(area, { childList: true, subtree: true, attributes: true });
    area.addEventListener("transitionend", restore);
    recheck.current = restore;
    const frame = requestAnimationFrame(restore);
    return () => { recheck.current = null; cancelAnimationFrame(frame); stop(); };
  }, [open, task, readyTask, pane, shownPath, resetHeader, attempt, content, placing]);
  // A read result may change without any DOM growth. Recheck it without restarting the attempt's 30-second cap.
  useEffect(() => { recheck.current?.(); }, [viewSettled]);
  return { retry, noteScroll };
}
