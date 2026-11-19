import { useQueries } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { parseReportDiff } from "@alpacawork/contract/report-diff";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Icon } from "@/components/ui/icon";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { useAttachmentBytes, useWorkspaceInfo } from "@/data/queries";
import { FILE_READ_BYTES, resources } from "@/data/resources";
import { taskFileLink } from "@/data/task-file-url";
import { FileLinkAnchor } from "../FileLinkAnchor";
import type { TaskDetail } from "@/data/types";
import { showable } from "@/domain/task-files";
import { viewerAddress } from "@/domain/viewer-target";
import { useNarrow, useViewStore } from "@/state/view-store";
import { closeView } from "@/state/history-step";
import { textClip } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { openView, useViewedCount } from "../viewer/Viewer";
import { diffNaming, FilesLink, SummaryCounts, type DiffNaming } from "./DiffPages";
import { CommitCount, DiffTitle } from "./commits";

/** A diff file a body embeds (`![diff](diffs/x.diff)`): the Task that holds it, and its metadata when the body's Task is that one. */
export type DiffSource = { owner: string; path: string; file?: TaskDetail["files"][number]; known: boolean };

const viewFiles = (results: { data?: { task: { files?: TaskDetail["files"] } }; isPending: boolean }[]) =>
  results.map(result => ({ files: result.data?.task.files, pending: result.isPending }));
const headStates = (results: { data?: string; isError: boolean }[]) => results.map(result => ({ data: result.data, error: result.isError }));

/** What a report diff's header says (diffNaming, and the command it was written with); a plain patch has none (`report: null`) until opened. */
type Head = { report: (DiffNaming & { written: string }) | null };
type Loaded = { source: DiffSource; name: string } & (
  | { state: "loading" } | { state: "missing" } | { state: "unreadable" } | { state: "tooLarge"; head: Head | null } | { state: "ready"; head: Head });

/**
 * The diffs a body embeds, in its flow: for each, a row that says how many files and lines it changes and, under that,
 * the versions it compares as its command wrote them, and opens it over the page (openView, UrlViewer) wherever it is
 * pressed. Only the diff file's header is read for this (`part=head`): its rows are fetched when it is
 * opened. Several diffs written together are one piece, each under its own heading. `commands` are the git commands
 * of the code block this piece stands in for (MarkdownBody): each is shown by its diff, and any no diff names stays
 * here to copy. A diff file that is missing, unreadable or too large says so in its place and links its file.
 */
export function DiffSummaryCard({ sources, commands, className }: { sources: DiffSource[]; commands: readonly string[]; className?: string }) {
  const { t } = useTranslation("reader");
  const shown = useViewStore(state => state.view);
  const narrow = useNarrow();
  const root = useWorkspaceInfo(info => info.root);
  const maxBytes = useAttachmentBytes();
  const views = useQueries({ queries: sources.map(source => ({ ...resources.taskView(root, source.owner), enabled: !source.known })), combine: viewFiles });
  const files = sources.map((source, i) => source.known ? source.file : views[i]!.files?.find(file => file.name === source.path));
  const readable = files.map(file => !!file && file.readable !== false && showable(file, maxBytes));
  const heads = useQueries({ queries: sources.map((source, i) => ({
    ...resources.diffHead(root, source.owner, source.path, files[i]?.revision ?? ""), enabled: readable[i]! })), combine: headStates });
  const loaded: Loaded[] = sources.map((source, i) => {
    const file = files[i], head = heads[i]!;
    const base = { source, name: source.path.split("/").at(-1)! };
    if (!file) return { ...base, state: !source.known && views[i]!.pending ? "loading" : "missing" };
    if (file.readable === false || head.error) return { ...base, state: "unreadable" };
    if (!readable[i]) return { ...base, state: "tooLarge", head: null };
    if (head.data === undefined) return { ...base, state: "loading" };
    const report = parseReportDiff(head.data);
    const read: Head = { report: report && { ...diffNaming(report), written: report.source.command } };
    return file.size > FILE_READ_BYTES ? { ...base, state: "tooLarge", head: read } : { ...base, state: "ready", head: read };
  });
  if (loaded.some(each => each.state === "loading")) return <div className={className}><RegionSkeleton shape="text" /></div>;
  const named = new Set(loaded.flatMap(each => (each.state === "ready" || each.state === "tooLarge") && each.head?.report ? [each.head.report.written] : []));
  const left = commands.filter(command => !named.has(command));
  return <section data-diff-summary="" className={cn("overflow-hidden rounded-md border border-line bg-lit text-ink", className)}>
    {left.map((command, i) => <div key={`command-${i}`} className="border-b border-rule px-3 py-2"><Command command={command} /></div>)}
    {loaded.map((each, i) => {
      const report = (each.state === "ready" || each.state === "tooLarge") ? each.head?.report ?? null : null;
      const opens = each.state === "ready" && report?.summary.files !== 0;
      // What it is leads: its commits' title, then how much it changes and how many commits it holds, smaller. A diff
      // whose file names no commit is led by how much it changes. The whole row opens it (its button's press reaches over
      // the row), drawn as a press only by its outline. The one read now beside the reader is marked as the row a pointer
      // is on, and its press closes it.
      // Only a computer reads it beside the report, where its row says it is the one open and its press closes it; a
      // phone's diff covers the screen, so a mark there would only flash as it opens and closes.
      const isShown = !narrow && shown === viewerAddress(each.source.owner, each.source.path);
      const viewed = opens && report && <ViewedSoFar address={viewerAddress(each.source.owner, each.source.path)} total={report.summary.files} />;
      const changes = report && (report.summary.files > 0 ? <SummaryCounts summary={report.summary} className={report.title ? "text-sm" : "text-base font-semibold"} />
        // A diff that changes no file has nothing to open: it says so in its place.
        : <span data-diff-unchanged="" className={report.title ? "text-sm" : "text-base font-semibold"}>{t("diffCard.unchanged")}</span>);
      return <div key={i} data-diff-summary-item={each.source.path} data-diff-shown={isShown || undefined}
        className={cn("relative flex items-center gap-3 px-3 py-2.5",
        i > 0 && "border-t border-rule", opens && "hover:bg-hover has-[[data-diff-open]:active]:bg-press",
        isShown && "bg-hover")}>
        <div className="flex min-w-0 flex-1 flex-col">
          {!report ? <span className="text-base font-semibold [overflow-wrap:anywhere]">{each.name}</span>
            : report.title ? <>
              <DiffTitle title={report.title} className="line-clamp-2 text-base font-medium" />
              {/* How far it has been checked beside the report, once it has been. */}
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">{changes}<CommitCount commits={report.commits} />{viewed}</span></>
            : <>{changes}{viewed && <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">{viewed}</span>}</>}
          {each.state !== "ready" && <p data-diff-failure={each.state} className="m-0 text-sm text-muted">
            {each.state === "missing" ? t("diffCard.missing", { name: each.name }) : each.state === "unreadable"
              ? t("diffCard.unreadable", { name: each.name }) : t("diffCard.tooLarge", { name: each.name })}{" "}
            {/* Too large to open here: the file itself; any other failure: where the Task's files are. */}
            {each.state === "tooLarge" ? <FileLinkAnchor link={taskFileLink(each.source.owner, { name: each.source.path, size: files[i]?.size ?? Infinity, revision: files[i]?.revision }, maxBytes)}
              className="whitespace-nowrap" />
              : <FilesLink owner={each.source.owner} path={each.state === "missing" ? "" : each.source.path} className="whitespace-nowrap">
                {each.state === "missing" ? t("diffCard.openFiles") : t("image.openFile")}</FilesLink>}</p>}
        </div>
        {opens && <Button variant="outline" data-diff-open="" aria-label={`${isShown ? t("diffCard.close") : t("diffCard.open")}: ${report?.title ?? each.name}`}
          aria-expanded={isShown}
          className={cn("shrink-0 after:absolute after:inset-0 after:content-[''] active:bg-press narrow:min-h-11", isShown ? "ps-2 pe-3" : "ps-3 pe-1.5")}
          onClick={() => isShown ? closeView() : openView(each.source.owner, each.source.path)}>
          {isShown ? <><Icon name="close" className="size-4" />{t("diffCard.close")}</> : <>{t("diffCard.open")}<Icon name="right" className="size-4" /></>}</Button>}
      </div>;
    })}
  </section>;
}

/** "Read 3/58" under a diff's summary, in Done's colour once every file is: nothing while none is. */
function ViewedSoFar({ address, total }: { address: string; total: number }) {
  const { t } = useTranslation("reader");
  const count = useViewedCount(address);
  if (!count) return null;
  return <span data-diff-viewed-so-far="" className={cn("flex items-center gap-1 text-xs tabular-nums", count >= total ? "text-done" : "text-muted")}>
    {count >= total && <Icon name="check" className="size-3" />}{t("viewer.viewedCount", { read: count, total })}</span>;
}

/** A diff's git command: the versions it compares as its heading (`shown`, or the whole command), the command to copy. */
function Command({ command, shown }: { command: string; shown?: string }) {
  const { t } = useTranslation("reader");
  return <div className="flex items-start gap-1">
    <code data-diff-range="" className={cn("min-w-0 flex-1 font-mono [overflow-wrap:anywhere]", shown ? "text-sm font-semibold" : "text-sm")}>{shown ?? command}</code>
    <CopyButton clip={() => textClip(command)} label={t("diffCard.copyCommand")} words className="-my-1" />
  </div>;
}
