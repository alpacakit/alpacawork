import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { fileKind } from "@alpacawork/contract";
import { commitTitle, parseReportDiff, pinnedDiffCommand, type ReportDiff, type ReportDiffCommits } from "@alpacawork/contract/report-diff";
import { CopyButton } from "@/components/ui/copy-button";
import { Message, type MessageTone } from "@/components/ui/message";
import { useWorkspaceInfo } from "@/data/queries";
import { resources } from "@/data/resources";
import { taskFilesLink } from "@/data/task-file-url";
import type { TaskFile } from "@/domain/task-files";
import { textClip } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useViewStore } from "@/state/view-store";
import { CodeBlock } from "../CodeBlock";
import { COLUMN } from "../reading-column";
import { LineRows, paint, SideRows, type Band, type Half, type Line, type SideLine } from "../viewer/LineRows";
import type { Look, ViewerDocument } from "../viewer/Viewer";
import { DiffBlock } from "./DiffBlock";
import { useDiffColours } from "./diff-colours";
import { codeRows, folderOf, proseChanges, proseRows, readDiffFile, hasDiffRows, readDiff, readsAsProse, sideBySide, sideText, summarizeFiles, type DiffEntry, type DiffSummary } from "./diff-files";
import type { StructuredDiffDocument } from "./diff-types";
import type { ExcerptPiece } from "./word-changes";

/**
 * What a diff adds to the viewer (Viewer.tsx), and only that: each of its files a page whose name says what was done
 * to the file and how many lines it adds and removes, whose body reads a document by the words that changed and code
 * by its rows (each hunk under the function it is in, a changed line's changed words marked), and its counts as the
 * viewer's title. How it opens is the viewer's, by its size (viewerLayout). A text that is no patch the viewer can list
 * is shown as written.
 */
export function diffDocument(text: string, path: string, renderProse: (text: string) => ReactNode): ViewerDocument {
  const diff = readDiff(text);
  if (diff.kind === "raw") return { kind: "whole", content: diff.tooLarge ? <TooLarge name={path.split("/").at(-1)!} /> : <DiffBlock text={diff.text} /> };
  const summary = summarizeFiles(diff.files);
  // Which looks change something here: side by side where a file both removes and adds lines; its lines as written where one is a document.
  const both = (file: DiffEntry) => !!file.added && !!file.deleted;
  const looks = { split: diff.files.some(both), code: diff.files.some(file => both(file) && !readsAsProse(file.path)),
    source: diff.files.some(file => readsAsProse(file.path) && hasDiffRows(readDiffFile(file))) };
  return { kind: "pages", counts: <SummaryCounts summary={summary} quiet />, lines: summary.added + summary.deleted, looks,
    pages: diff.files.map(file => ({ key: file.key, path: file.path, place: file.oldPath ? `← ${file.oldPath}` : folderOf(file.path),
      name: line => <FileName file={file} line={line} />,
      body: look => <FileChanges file={file} renderProse={renderProse} look={look} /> })) };
}

function TooLarge({ name }: { name: string }) {
  const { t } = useTranslation("reader");
  return <Message tone="caution" icon="file" title={t("diffCard.tooLarge", { name })} />;
}

/**
 * What a Task's report diff says of itself for a person: its commits' title (null where its file names no commit: one
 * written before diffs named their commits, or a range with none between its versions), its commits, how much it
 * changes, and the git command that shows it again by the commits it compared (to copy). SHAs and branch names are
 * never shown: they say nothing to a person, and a branch moves.
 */
export type DiffNaming = { title: string | null; commits: ReportDiffCommits | null; summary: DiffSummary; command: string };
export const diffNaming = (report: Pick<ReportDiff, "source" | "commits" | "files">): DiffNaming => ({
  title: report.commits && commitTitle(report.commits.title), commits: report.commits, summary: summarizeFiles(report.files),
  command: pinnedDiffCommand(report.source) });

/** A Task's diff file's naming (diffNaming), read from its header alone; null for any other file. */
export function useDiffNaming(owner: string, file: TaskFile | undefined): DiffNaming | null {
  const root = useWorkspaceInfo(info => info.root);
  const diff = !!file && fileKind(file.name) === "diff" && file.readable !== false;
  const head = useQuery({ ...resources.diffHead(root, owner, file?.name ?? "", file?.revision ?? ""), enabled: diff });
  const text = diff ? head.data : undefined;
  return useMemo(() => { const report = text ? parseReportDiff(text) : null; return report && diffNaming(report); }, [text]);
}

/**
 * How many files and lines a diff changes, the numbers in their colours. `quiet`: as a title, where the files lead and
 * the lines follow a step smaller, so it stands as plain as a task's title.
 */
export function SummaryCounts({ summary, className, quiet }: { summary: DiffSummary; className?: string; quiet?: boolean }) {
  const { t } = useTranslation("reader");
  return <span data-diff-counts="" className={cn("inline-flex flex-wrap items-baseline gap-x-[0.4em] tabular-nums", className)}>{t("diffCard.files", { count: summary.files })}{" "}
    <span className={cn("inline-flex items-baseline gap-x-[0.4em]", quiet && "text-base font-normal")}>
      <Lines added={summary.added} deleted={summary.deleted} /></span></span>;
}

function Lines({ added, deleted }: { added: number | null; deleted: number | null }) {
  return <span className="tabular-nums">
    {!!added && <span className="text-done">+{added}</span>}{!!added && !!deleted && " "}{!!deleted && <span className="text-error">−{deleted}</span>}
  </span>;
}

/**
 * A file's name on one line: what was done to it (new, deleted, renamed; nothing for a change), its name, its lines
 * added and removed; cut short to its line in a heading (`line`), else folded where it is longer. Its folder is the
 * viewer's to show beside it.
 */
function FileName({ file, line }: { file: DiffEntry; line: boolean }) {
  const { t } = useTranslation("reader");
  const word = file.change === "new" ? t("diff.new") : file.change === "deleted" ? t("diff.deleted")
    : file.change === "rename" ? t("diff.renamed") : file.change === "copy" ? t("diff.copied") : null;
  return <span data-diff-file-name={file.path} className="flex min-w-0 items-baseline gap-2">
    {word && <span className="shrink-0 rounded-sm border border-line bg-bg px-1.5 text-xs text-muted">{word}</span>}
    <span className={cn("min-w-0 font-semibold", line ? "truncate" : "[overflow-wrap:anywhere]")}>{file.path.slice(file.path.lastIndexOf("/") + 1)}</span>
    {/* The counts follow the name, in a heading as in the list, so the eye goes from one to the other. */}
    <span className="shrink-0 text-xs">{file.binary ? <span className="text-muted">{t("diffCard.binary")}</span> : <Lines added={file.added} deleted={file.deleted} />}</span>
  </span>;
}

/** What changed in one file, read out whole. */
function FileChanges({ file, renderProse, look }: { file: DiffEntry; renderProse: (text: string) => ReactNode; look: Look }) {
  const { t } = useTranslation("reader");
  const whole = file.change === "new" || file.change === "deleted";
  const doc = useMemo(() => readDiffFile(file), [file]);
  const rows = useMemo(() => doc?.kind === "structured" && readsAsProse(file.path) ? proseRows(doc) : null, [doc, file.path]);
  const changes = useMemo(() => rows && !whole ? proseChanges(rows) : null, [rows, whole]);
  // Why the file shows no rows: nothing changed in its lines (empty), or what was done instead (info).
  const note = (text: string, tone: MessageTone = "info") => <Message tone={tone} size="line" className="px-4 narrow:px-3" title={text} />;
  if (!file.kept) return <NotKept command={file.command} />;
  if (file.binary) return note(t("diffCard.binaryRows"));
  // A part the reader could not take is shown as written: its lines are not read as no change.
  if (doc && doc.kind !== "structured" && file.patch) return <div className="px-4 narrow:px-3"><CodeBlock text={file.patch} /></div>;
  if (!hasDiffRows(doc)) return file.change === "deleted" ? note(t("diffCard.deletedFile"))
    : file.oldPath ? note(t("diffCard.renamedOnly", { from: file.oldPath })) : note(t("diffCard.noRows"), "empty");
  // A document read by its lines, as code is (a computer's choice): the rows its patch holds.
  if (look.source && readsAsProse(file.path) && file.patch) return <StructuredRows doc={doc} split={look.split} />;
  // A new or deleted document as it reads, edged in its side's colour; side by side, on its own side, the other empty.
  if (readsAsProse(file.path) && whole) {
    const added = file.change === "new";
    const words = renderProse(sideText(rows!, added ? "add" : "del"));
    const text = (place?: string) => <div className={cn("border-s-4 ps-3", added ? "border-done" : "border-error", place)}>{words}</div>;
    if (look.split) return <ProseSides>{added ? <Empty /> : text()}{added ? text() : <Empty />}</ProseSides>;
    // One above the other, its edge and room (1rem) stand out in the column's side room where there is room for them
    // (the column's sides at least 2rem: a page 52rem wide), so its words start at the column's left as any document's
    // do; with less, they stand inside it, its words 1rem in, which a wide table's reach takes back (`--inset`).
    return <ProseColumn>{text("[--inset:1rem] @min-[52rem]:-ms-4 @min-[52rem]:[--inset:0px]")}</ProseColumn>;
  }
  if (!changes) return file.patch ? <StructuredRows doc={doc} split={look.split} /> : note(t("diffCard.noRows"), "empty");
  if (!changes.length) return note(t("diffCard.blankOnly"));
  // Side by side (a computer): each changed paragraph as it was at the left, its removed words marked, and as it is now
  // at the right, its added words marked; a paragraph only added or only removed stands on its own side, the other empty.
  if (look.split) return <ProseSides>
    {changes.map((change, i) => {
      const side = (drop: "add" | "del") => change.pieces.filter(piece => piece.kind !== drop);
      const has = (kind: "add" | "del") => change.pieces.some(piece => piece.kind === kind || piece.kind === "same");
      return [has("del") ? <p key={`${i}l`} className="m-0 text-base [overflow-wrap:anywhere]">{side("add").map((piece, j) => <Piece key={j} piece={piece} />)}</p> : <Empty key={`${i}l`} />,
        has("add") ? <p key={`${i}r`} className="m-0 -ms-3 border-s border-rule ps-3 text-base [overflow-wrap:anywhere]">{side("del").map((piece, j) => <Piece key={j} piece={piece} />)}</p> : <Empty key={`${i}r`} />];
    })}
  </ProseSides>;
  return <ProseColumn><div data-diff-prose="" className="flex flex-col gap-3">
    {changes.map((change, i) => <p key={i} className="m-0 text-base [overflow-wrap:anywhere]">
      {change.pieces.map((piece, j) => <Piece key={j} piece={piece} />)}
    </p>)}
  </div></ProseColumn>;
}

/**
 * A document one above the other, as it reads: in the reader's column (reading-column.ts), the detail panel's measure,
 * in the middle of the page with even room at its sides. A table wider than the column keeps its left on the words' and
 * reaches right as far as the page's room (its width is its words', at most to the page's right edge), then scrolls in
 * its own frame (TableFrame): the eye comes back to one left edge, and a new or removed document's coloured edge runs
 * unbroken beside it. `--inset`: how far inside the column the words start (a whole document's edge and room), taken
 * back from that reach. Code is not here: its rows keep the page's whole width (StructuredRows).
 */
function ProseColumn({ children }: { children: ReactNode }) {
  return <div className="@container px-4 narrow:px-3">
    <div data-diff-column="" className={cn(COLUMN.body, "[&_[data-table-frame]]:w-max [&_[data-table-frame]]:max-w-[calc(50cqw+50%-var(--inset,0px)/2)]")}>{children}</div>
  </div>;
}

/**
 * A document side by side: as it was at the left, as it is now at the right, each side at most 42em (about 42 Japanese
 * letters), the two in the middle of a page wider than both, as a document one above the other stands (ProseColumn).
 */
function ProseSides({ children }: { children: ReactNode }) {
  return <div data-diff-prose="split" className="grid grid-cols-[repeat(2,minmax(0,42em))] justify-center gap-x-6 gap-y-3 px-4">{children}</div>;
}

/** The side a change has nothing on (a new file's old side, a removed paragraph's new one): filled grey and square, as an empty code row's is. */
function Empty() {
  return <div aria-hidden="true" data-diff-empty="" className="bg-well" />;
}

const WORD = { add: "rounded-sm bg-diff-add-word", del: "rounded-sm bg-diff-del-word", ctx: "" } as const;
/** A diff's rows as the viewer's lines (LineRows): numbers of both files, its +/− and ground, letters painted. */
function StructuredRows({ doc, split }: { doc: StructuredDiffDocument; split: boolean }) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  // Rows are readable on their first frame; the worker adds colours without holding up the text.
  const colours = useDiffColours(doc, frame, true);
  const text = (line: number) => { const { start, contentEnd } = doc.lines[line]!; return doc.text.slice(start, contentEnd); };
  const read = useMemo(() => codeRows(doc), [doc]);
  // A hunk's start: the function it is in, on one line (its line numbers are the rows' own under it); with none, a thin gap.
  const band = (row: (typeof read)[number]): Band | null => row.kind === "hunk" ? { kind: "band", id: `h${row.line}`,
      content: row.context ? <code title={row.context} className="block truncate font-mono">{row.context}</code> : null } : null;
  const letters = (row: Extract<(typeof read)[number], { words: unknown }>) => paint(text(row.line), colours?.[row.line] ?? null, row.words, WORD[row.kind], 1);
  const rows = useMemo(() => split ? null : read.map((row): Line | Band => row.kind === "hunk" ? band(row)! : {
    kind: "line", id: `l${row.line}`, numbers: [row.old, row.next], phone: row.next, tone: row.kind === "ctx" ? undefined : row.kind, text: letters(row) }),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `band` and `letters` read `doc` and `colours`
  [read, colours, split]);
  // Side by side: each row's old line at the left and its new one at the right (sideBySide).
  const sides = useMemo(() => !split ? null : sideBySide(read.map(row => ({ kind: row.kind, text: row.kind === "hunk" ? "" : text(row.line).slice(1) }))).map((step, at): SideLine | Band => {
    if (step.kind === "band") return band(read[step.row]!)!;
    const half = (index: number | null, side: "left" | "right"): Half | null => {
      if (index === null) return null;
      const row = read[index] as Extract<(typeof read)[number], { words: unknown }>;
      return { number: side === "left" ? row.old : row.next, tone: row.kind === "ctx" ? undefined : row.kind, text: letters(row) };
    };
    return { kind: "side", id: `s${at}`, left: half(step.left, "left"), right: half(step.right, "right") };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
  }), [read, colours, split]);
  return sides ? <SideRows frame={setFrame} rows={sides} /> : <LineRows frame={setFrame} rows={rows!} signs />;
}

/**
 * A file whose lines the report diff did not keep: they are in no diff on the screen, so the note says so and gives the
 * git command that shows them (the header's repo, both versions and the file), to copy.
 */
function NotKept({ command }: { command: string | null }) {
  const { t } = useTranslation("reader");
  return <div className="flex flex-col gap-1 px-4 narrow:px-3">
    <Message tone="info" size="line" title={t("diffCard.notKept")} description={command ? t("diffCard.notKeptHint") : undefined} />
    {command && <div className="flex items-start gap-1">
      <code className="min-w-0 flex-1 font-mono text-sm [overflow-wrap:anywhere]">{command}</code>
      <CopyButton clip={() => textClip(command)} label={t("diffCard.copyCommand")} className="-my-1 size-7 min-h-7 shrink-0" />
    </div>}
  </div>;
}

/** A piece of a changed paragraph: shared words as they read, added ones on green with a line under, removed ones on red struck through. */
function Piece({ piece }: { piece: ExcerptPiece }) {
  if (piece.kind === "gap") return <span className="text-muted">…</span>;
  if (piece.kind === "same") return <>{piece.text}</>;
  return piece.kind === "add"
    ? <ins className="rounded-sm bg-diff-add-word px-0.5 underline decoration-done decoration-2 underline-offset-4 [text-decoration-skip-ink:none]">{piece.text}</ins>
    : <del className="rounded-sm bg-diff-del-word px-0.5 line-through decoration-error">{piece.text}</del>;
}

/** A path of a Task's folder opened as it opens (openTaskFile), in this tab. */
export function FilesLink({ owner, path, className, children }: { owner: string; path: string; className?: string; children: ReactNode }) {
  return <a href={taskFilesLink(owner, path)} className={className} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    useViewStore.getState().openTaskFile(owner, path);
  }}>{children}</a>;
}
