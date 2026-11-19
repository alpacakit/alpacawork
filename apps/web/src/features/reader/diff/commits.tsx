import { useState } from "react";
import { useTranslation } from "react-i18next";
import { commitTitle, type ReportDiffCommits } from "@alpacawork/contract/report-diff";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** How many of a diff's commits its list shows before the rest are asked for. */
const FIRST = 10;
const day = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}/${date.getDate()}`; };

/** A diff's name for a person: its commits' title as written (in English as a rule), never cut in the middle of a word. */
export function DiffTitle({ title, className }: { title: string; className?: string }) {
  return <span data-diff-title="" title={title} className={cn("[overflow-wrap:anywhere] [word-break:normal]", className)}>{title}</span>;
}

/** "3 commits" beside a card's counts: its title names one piece of several. Nothing for one, which is the title. */
export function CommitCount({ commits }: { commits: ReportDiffCommits | null }) {
  const { t } = useTranslation("reader");
  return commits && commits.total > 1
    ? <span data-diff-commit-count="" className="text-xs text-muted tabular-nums">{t("diffCard.commits", { count: commits.total })}</span> : null;
}

/** "3 commits ▾" in a diff's head: its commits, folded until pressed. Nothing for one. */
export function CommitsToggle({ commits, open, onToggle, className }: { commits: ReportDiffCommits | null; open: boolean; onToggle: () => void; className?: string }) {
  const { t } = useTranslation("reader");
  if (!commits || commits.total <= 1) return null;
  return <button type="button" aria-expanded={open} onClick={onToggle} data-diff-commits-toggle=""
    className={cn("inline-flex min-h-7 shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1.5 text-xs whitespace-nowrap text-muted tabular-nums hover:bg-hover hover:text-ink aria-expanded:bg-hover aria-expanded:text-ink narrow:min-h-9", className)}>
    {t("diffCard.commits", { count: commits.total })}<Icon name={open ? "up" : "down"} className="size-3.5" /></button>;
}

/**
 * A diff's commits, newest first, each whole on its line with its day: the first few, the rest when asked for. Those
 * its file did not keep (only counted) are said to be left out.
 */
export function CommitList({ commits }: { commits: ReportDiffCommits }) {
  const { t } = useTranslation("reader");
  const [all, setAll] = useState(false);
  const shown = all ? commits.list : commits.list.slice(0, FIRST);
  const left = commits.total - commits.list.length;
  return <div data-diff-commits="" className="border-t border-rule py-1">
    <ol className="m-0 max-h-[38vh] list-none overflow-y-auto p-0">
      {shown.map(commit => <li key={commit.sha} className="flex items-baseline gap-3 py-1 text-sm">
        <span className="min-w-0 flex-1 text-ink [overflow-wrap:anywhere] [word-break:normal]">{commitTitle(commit.subject)}</span>
        <span className="shrink-0 text-xs text-muted tabular-nums">{day(commit.date)}</span></li>)}
      {(all || commits.list.length <= FIRST) && left > 0 && <li className="py-1 text-xs text-muted">{t("diffCard.olderCommits", { count: left })}</li>}
    </ol>
    {!all && commits.list.length > FIRST && <button type="button" onClick={() => setAll(true)}
      className="-ms-1.5 mt-1 min-h-7 cursor-pointer rounded-sm px-1.5 text-xs text-muted hover:bg-hover hover:text-ink narrow:min-h-9">
      {t("diffCard.moreCommits", { count: commits.list.length - FIRST })}</button>}
  </div>;
}
