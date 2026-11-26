import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { spanLabel } from "./format";
import { analysisFindingRules, isAnalysisCause } from "@alpacawork/contract/analysis";
import type { TasksView } from "./contract";

type Work = TasksView["activeWork"][number];
/** How many of the analysis tasks stand at once; the rest open from "more". */
const SHOWN = 3;

/**
 * What is being looked into or improved now (`activeWork`: the open tasks marked with what they are about), a thin
 * band under the span's switch, those waiting for you first and marked so; nothing when there are none. A row opens
 * the task over the face, as a row of a list does.
 */
export function WorkBand({ work }: { work: Work[] }) {
  const { t } = useTranslation("analysis");
  const [all, setAll] = useState(false);
  if (!work.length) return null;
  const shown = all ? work : work.slice(0, SHOWN);
  return <section data-work-band="" aria-label={t("work.title")} className="-mt-4 mb-8 rounded-lg border border-rule px-4 py-2 narrow:-mt-2 narrow:px-3">
    <h2 className="text-xs text-soft">{t("work.title")}</h2>
    <ul>{shown.map(item => <li key={item.id}>
      <button type="button" data-work-row={item.id}
        onClick={event => useViewStore.getState().openTask(item.id, { reader: true, returnTo: event.currentTarget })}
        className="grid min-h-8 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-sm text-start hover:bg-hover narrow:items-start narrow:py-1">
        <span className="text-muted">{item.id}</span>
        {/* One line on a computer (title, then what it is about); two under a finger, what it is about under the title. */}
        <span className="flex min-w-0 items-baseline gap-x-3 narrow:block">
          <span dir="auto" className="truncate narrow:block">{item.title}</span>
          <span className="flex-none truncate text-xs text-soft narrow:block">{subjectWords(item.analysisSubject, t)}</span>
        </span>
        <span className={cn("text-xs whitespace-nowrap", item.userTurn ? "font-semibold text-turn" : "text-muted")}>
          {item.userTurn ? t("work.yourTurn") : t(`state.${item.state}`)}</span>
      </button>
    </li>)}</ul>
    {work.length > SHOWN && <button type="button" onClick={() => setAll(!all)} className="py-1 text-xs text-muted hover:text-ink">
      {all ? t("work.fewer") : t("work.more", { count: work.length - SHOWN })}</button>}
  </section>;
}

/** What an analysis task is about, in words: a kind of fix or a finding's rule, a task, or days. */
function subjectWords(subject: Work["analysisSubject"], t: (key: string, options?: Record<string, unknown>) => string) {
  if (subject.kind === "task") return t("work.aboutTask", { task: subject.task });
  if (subject.kind === "period") return t("work.aboutDays", { days: spanLabel(subject.from, subject.to) });
  const rule = (analysisFindingRules as readonly string[]).includes(subject.key);
  return t("work.aboutCause", { cause: t(rule ? `rule.${subject.key}` : isAnalysisCause(subject.key) ? `cause.${subject.key}` : `aspect.${subject.key}`) });
}
