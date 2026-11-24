import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { Seg } from "./parts";
import { analysisHome, type AnalysisPlace } from "./place";
import { useTodayFinished } from "./data";

/**
 * The bar's faces, beside the project's name: the list of tasks to work with (Use), and what the records count
 * (Analysis). A face to come (Settings) is one more item here. Coming back to the analysis finds it as it was left.
 */
export function FaceSwitch({ className }: { className?: string }) {
  const { t } = useTranslation("analysis");
  const analysis = useViewStore(state => state.analysis);
  const left = useRef<AnalysisPlace | null>(null);
  if (analysis) left.current = { ...analysis, list: null, unit: null };
  return <Seg className={cn("narrow:gap-0", className)} label={t("face.label")} value={analysis ? "analysis" : "use"}
    onChange={face => useViewStore.getState().showAnalysis(face === "analysis" ? left.current ?? analysisHome() : null)}
    items={[["use", t("face.use")], ["analysis", t("face.analysis")]]} />;
}

const MARK = { passed: "bg-done", reworked: "bg-reworked", stopped: "bg-stopped" } as const;

/**
 * Today's finished tasks beside Done, a small mark each in the order they finished: green went through without a
 * fix, grey after fixes, pink stopped. A task finishing while the list is shown drops its mark in. Pressed, it opens
 * the analysis on today.
 */
export function TodayMarks() {
  const { t } = useTranslation("analysis");
  const project = useViewStore(state => state.project);
  const data = useTodayFinished(project).data, rows = data?.rows ?? [];
  // The marks already drawn: one not among them is new since, and drops in. The first drawing has none new.
  const seen = useRef<Set<string> | null>(null);
  const fresh = new Set(seen.current ? rows.filter(row => !seen.current!.has(row.id)).map(row => row.id) : []);
  useEffect(() => { if (data) seen.current = new Set(data.rows.map(row => row.id)); }, [data]);
  if (!rows.length) return null;
  const words = t("home.marks", { count: rows.length, passed: rows.filter(row => row.outcome === "passed").length });
  return <button type="button" aria-label={t("home.label", { marks: words })} title={words}
    onClick={() => useViewStore.getState().showAnalysis(analysisHome("tasks", { period: "today" }))}
    className="ms-2.5 flex items-center gap-0.5 rounded-sm p-1.5 hover:bg-hover narrow:ms-1.5">
    {rows.map(row => <i key={row.id} className={cn("block h-3 w-2 rounded-xs narrow:w-1.5", row.outcome ? MARK[row.outcome] : "bg-rule", fresh.has(row.id) && "animate-land")} />)}
  </button>;
}
