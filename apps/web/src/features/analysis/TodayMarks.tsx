import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NARROW_QUERY, useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { Shown } from "./parts";
import { analysisHome } from "./place";
import { useTodayFinished } from "./data";
import { CapCentred } from "@/components/ui/text-mark";

const MARK = { passed: "bg-done", reworked: "bg-reworked", stopped: "bg-stopped" } as const;

/**
 * Today's finished tasks beside Done, a small mark each in the order they finished: green went through without a
 * fix, grey after fixes, pink stopped. A task finishing while the list is shown drops its mark in. Pressed, it opens
 * the analysis on today.
 */
export function TodayMarks() {
  const { t } = useTranslation("analysis");
  const project = useViewStore(state => state.project);
  const answer = useTodayFinished(project), data = answer?.data, rows = data?.rows ?? [];
  // The marks already drawn: one not among them is new since, and drops in. The first drawing has none new.
  const seen = useRef<Set<string> | null>(null);
  const fresh = new Set(seen.current ? rows.filter(row => !seen.current!.has(row.id)).map(row => row.id) : []);
  useEffect(() => { if (data) seen.current = new Set(data.rows.map(row => row.id)); }, [data]);
  // As many marks as the title column has room for, the latest; the earlier ones are counted before them (+N).
  const place = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(Infinity);
  useLayoutEffect(() => {
    const box = place.current;
    if (!box) return;
    // A box not laid out yet (no width) is not a limit.
    const measure = () => setRoom(box.clientWidth || Infinity);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    return () => watch.disconnect();
  }, [rows.length > 0]);
  if (!rows.length) return null;
  const step = matchMedia(NARROW_QUERY).matches ? 8 : 10, chrome = 22, count = 32;
  const fit = Math.floor((room - chrome) / step);
  const shown = rows.length <= fit ? rows : rows.slice(rows.length - Math.max(0, Math.floor((room - chrome - count) / step)));
  const hidden = data!.total - shown.length;
  const words = t("home.marks", { count: data!.total, passed: rows.filter(row => row.outcome === "passed").length });
  // Centred on the capitals of the heading's words (CapCentred), in a heading that stands its words on their baseline.
  return <CapCentred className="min-w-0 flex-1 grid-cols-[minmax(0,1fr)]"><div ref={place} className="flex min-w-0 flex-1"><Shown current={answer!.current} className="flex min-w-0">
    <button type="button" aria-label={t("home.label", { marks: words })} title={words}
      onClick={() => useViewStore.getState().showAnalysis(analysisHome("tasks", { period: "today" }))}
      className="ms-2.5 flex min-w-0 items-center gap-0.5 rounded-sm p-1.5 hover:bg-hover narrow:ms-1.5">
      {hidden > 0 && <span className="me-1 text-xs font-normal text-muted tabular-nums cap-box">+{hidden}</span>}
      {shown.map(row => <i key={row.id} className={cn("block h-3 w-2 flex-none rounded-xs narrow:w-1.5", row.outcome ? MARK[row.outcome] : "bg-rule", fresh.has(row.id) && "animate-land")} />)}
    </button>
  </Shown></div></CapCentred>;
}
