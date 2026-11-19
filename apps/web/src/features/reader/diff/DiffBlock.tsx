import { useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useScrollMore } from "@/lib/scroll-more";
import { cn } from "@/lib/utils";
import { CodeCopy, CodeFrame } from "../CodeBlock";
import { WrapToggle } from "../WrapToggle";
import { useDiffColours } from "./diff-colours";
import { describeDiff } from "./diff-source";
import type { DiffColours, DiffFile, DiffHunk, DiffPart, DiffSpan, LinesDiffDocument, SourceLine, StructuredDiffDocument } from "./diff-types";

/**
 * A diff in a code block, read once (describeDiff) and drawn whole at once: each file a band with its name, what was
 * done to it and how many lines it adds and removes, then its rows, each added or removed one on its ground; only the
 * letters' colours come later. What paints them (the runtime, its Worker and grammars) is loaded only once a diff is on
 * the screen: a body drawn but not shown (the folded conversation is kept drawn off the page) asks nothing. A text it
 * cannot paint (an unknown language, missing context, a failure) keeps its letters in the code's colour, without a word
 * or a mark; a text that changes or leaves the screen takes no late colours. A text that names no file but has a +/- line
 * is its rows alone, each added or removed one on its ground, no band, nothing asked. Any other text describeDiff does
 * not take as a diff (beyond its bounds, a format it does not know) is its text alone, nothing asked, in the same frame and code.
 *
 * Its lines are kept whole (each code scrolls sideways under its band, the bands and marks standing still) until its
 * wrap mark folds them at the frame's edge; that is the diff's own, for all its files, kept while it is on the page
 * (a new text, a move to the coordinator's own window) and gone with it. The copy mark copies the text as written, its
 * git lines too; a selection copies what it covers as shown: a band's words, a hunk's line number, the rows' letters
 * with their +/-.
 */
export function DiffBlock({ text, className, codeClassName }: { text: string; className?: string; codeClassName?: string }) {
  const diff = useMemo(() => describeDiff(text), [text]);
  const [wrapped, setWrapped] = useState(false);
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  useBleed(frame);
  const marks = <DiffMarks text={text} wrapped={wrapped} onWrap={setWrapped} />;
  // The marks stand in the first file's band; a diff that does not start with one has them on a line of their own.
  const banded = diff.kind === "structured" && diff.parts[0]!.kind === "file";
  return <CodeFrame ref={setFrame} className={className} data-diff-wrap={wrapped ? "" : undefined}>
    {!banded && <div className="-mt-1 -me-1 flex justify-end">{marks}</div>}
    {diff.kind === "structured" ? <DiffFiles diff={diff} frame={frame} marks={banded ? marks : undefined} codeClassName={codeClassName} />
      : diff.kind === "lines" ? <DiffLines diff={diff} codeClassName={codeClassName} />
      : <DiffCode last className={cn("px-(--diff-bleed) pb-(--diff-foot)", codeClassName)}>{text}</DiffCode>}
  </CodeFrame>;
}

/**
 * The diff's own marks: fold its lines at the frame's edge or keep them whole, and copy it as written. They are a code
 * block's corner marks, as its copy mark is (CODE_COPY): 28px, so the band keeps the height of its name; on a phone each
 * press reaches 36 by 44, the two meeting without overlapping. They stand on the band's tint, where the hover ground of
 * the page would not show; the lit one does.
 */
const CORNER_PRESS = "relative size-7 min-h-7 shrink-0 hover:bg-lit narrow:size-7 narrow:min-h-7 narrow:after:absolute narrow:after:-inset-x-1 narrow:after:-inset-y-2 narrow:after:content-['']";
function DiffMarks({ text, wrapped, onWrap }: { text: string; wrapped: boolean; onWrap: (wrapped: boolean) => void }) {
  return <span data-diff-marks="" className="flex shrink-0 items-center gap-2">
    <WrapToggle wrapped={wrapped} onWrap={onWrap} className={CORNER_PRESS} />
    <CodeCopy text={text} className={CORNER_PRESS} />
  </span>;
}

/**
 * A diff's code as a frame holds it: the plain code's letters (Pre's font and size), reaching the frame's edges through
 * its padding (useBleed) and, the last, its foot, so a row's ground meets them. Kept whole, its lines run on and it
 * scrolls sideways, as wide as its longest line, every row's ground as long; folded (the frame's `data-diff-wrap`),
 * they fold at the frame's edge, anywhere if a word is longer than the line.
 */
const CODE = "m-0 w-max min-w-full font-mono text-sm whitespace-pre [overflow-wrap:anywhere] in-data-diff-wrap:w-auto in-data-diff-wrap:whitespace-pre-wrap";
function DiffCode({ last, className, children }: { last: boolean; className?: string; children: ReactNode }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  return <div ref={setBox} data-diff-code="" data-more={useScrollMore(box)} className={cn("-mx-(--diff-bleed) overflow-x-auto scroll-more-x", last && "-mb-(--diff-foot)")}>
    <pre className={cn(CODE, className)}>{children}</pre>
  </div>;
}

/**
 * The parts of a diff in the order they come: a file's head lines (one or more parts) make one band where its first
 * part stands, and the rows after it, up to the next file, are its code. Rows before any file (words before the
 * patch) stand alone at the top.
 */
type Section = { file?: DiffFile; parts: Exclude<DiffPart, { kind: "file" }>[] };
function sections(diff: StructuredDiffDocument): Section[] {
  const files = new Map(diff.files.map(file => [file.id, file]));
  const drawn: Section[] = [];
  for (const part of diff.parts) {
    if (part.kind === "file") {
      if (drawn.at(-1)?.file?.id !== part.file) drawn.push({ file: files.get(part.file)!, parts: [] });
      continue;
    }
    if (!drawn.length) drawn.push({ parts: [] });
    drawn.at(-1)!.parts.push(part);
  }
  return drawn;
}

/**
 * A diff's files, each its band and its code. The code is drawn from the diff, its colours and the words alone: folding
 * or unfolding the lines draws no row again.
 */
function DiffFiles({ diff, frame, marks, codeClassName }: { diff: StructuredDiffDocument; frame: HTMLElement | null; marks?: ReactNode; codeClassName?: string }) {
  const { t } = useTranslation("reader");
  const colours = useDiffColours(diff, frame);
  const painted = colours?.length === diff.lines.length ? colours : null;
  const drawn = useMemo(() => {
    const place = (line: number) => `⋯ ${t("diff.line", { line })}`;
    // Hunk IDs are original source line indices, unique across files. Resolve their display locations once;
    // looking up the file and then the hunk for every part repeatedly scans the same document.
    const places = new Map<number, number | null>();
    for (const file of diff.files) for (const hunk of file.hunks) {
      places.set(hunk.id, hunk === file.hunks[0] && atStart(hunk) ? null : hunk.newCount ? hunk.newStart : hunk.oldStart);
    }
    const all = sections(diff);
    return all.map(({ file, parts }, i) => {
      const shown: Row[] = [];
      for (const part of parts) appendRows(shown, diff, part, painted, place, places);
      const last = i === all.length - 1;
      return { file, last, code: shown.length ? <DiffCode last={last} className={codeClassName}>
        {shown.map((row, j) => <DiffRow key={row.line} {...row} foot={last && j === shown.length - 1} />)}
      </DiffCode> : null };
    });
  }, [diff, painted, t, codeClassName]);
  return drawn.map(({ file, last, code }, i) => <div key={file?.id ?? "before"} data-diff-file={file ? "" : undefined}>
    {file && <FileBand file={file} first={i === 0} last={last && !code} marks={i === 0 ? marks : undefined} />}
    {code}
  </div>);
}

/** A diff's rows without its files: its lines as written, each added or removed one on its ground. */
function DiffLines({ diff, codeClassName }: { diff: LinesDiffDocument; codeClassName?: string }) {
  return useMemo(() => <DiffCode last className={codeClassName}>
    {diff.changes.map((kind, line) => <DiffRow key={line} line={line} kind={kind} {...sourceOf(diff, line)} spans={null} foot={line === diff.changes.length - 1} />)}
  </DiffCode>, [diff, codeClassName]);
}

/**
 * A row's ground runs to the frame's edges, through the frame's padding, which is the place's (Markdown's page or note):
 * --diff-bleed at the sides, --diff-top and --diff-foot for what meets the frame's top and its foot. Read from the frame
 * once it is laid out: a body may be drawn before it is put on a page (the coordinator's conversation is drawn into an
 * element added later), where it has no style yet, so it is read again whenever the frame is laid out.
 */
function useBleed(frame: HTMLElement | null) {
  useLayoutEffect(() => {
    const view = frame?.ownerDocument.defaultView;
    if (!frame || !view) return;
    const read = () => {
      const style = view.getComputedStyle(frame);
      if (!style.paddingInlineEnd) return;
      frame.style.setProperty("--diff-bleed", style.paddingInlineEnd);
      frame.style.setProperty("--diff-top", style.paddingTop);
      frame.style.setProperty("--diff-foot", style.paddingBottom);
    };
    read();
    const laid = new view.ResizeObserver(read);
    laid.observe(frame);
    return () => laid.disconnect();
  }, [frame]);
}

/** A path as one line of words: a control character (a newline, a tab) in a name is shown as its escape. */
const CONTROL: Record<string, string> = { "\t": "\\t", "\n": "\\n", "\r": "\\r" };
const visible = (path: string) => path.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, c => CONTROL[c]
  ?? (c.charCodeAt(0) < 0x80 ? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
/** A path's folder (up to its last /, kept) and its name. */
const split = (path: string) => { const at = path.lastIndexOf("/") + 1; return [path.slice(0, at), path.slice(at)] as const; };
/** A path that folds after each / first, and anywhere only if a part is longer than the line. */
const folded = (path: string) => visible(path).split("/").flatMap((part, i, all) => i < all.length - 1 ? [part + "/", <wbr key={i} />] : [part]);

/**
 * A file's band: its name first, in the words' font and weight over the code's, what was done to it before it (new,
 * deleted, renamed, copied; nothing for a change), how many lines it adds and removes at its end, and its folder under
 * it, smaller and quieter. A rename or a copy keeps its old name too: in the same folder the name reads old → new, from
 * another folder the folder line reads the old path → the new one. Every name and path is shown whole, folding where
 * the line ends. Each piece is an element of its own (a flex item), so a selection copies them a line each, never run
 * together.
 */
const BAND = "-mx-(--diff-bleed) bg-rule px-(--diff-bleed) py-2 font-sans whitespace-normal";
function FileBand({ file, first, last, marks }: { file: DiffFile; first: boolean; last: boolean; marks?: ReactNode }) {
  const { t } = useTranslation("reader");
  const word = file.change === "new" ? t("diff.new") : file.change === "deleted" ? t("diff.deleted")
    : file.change === "rename" ? t("diff.renamed") : file.change === "copy" ? t("diff.copied") : undefined;
  const [folder, name] = split((file.newPath ?? file.oldPath)!);
  const [before, was] = file.change === "rename" || file.change === "copy" ? split(file.oldPath!) : [];
  const moved = before !== undefined && before !== folder;
  const { added, deleted } = file.stats;
  return <div className={cn(BAND, first ? "-mt-(--diff-top)" : "mt-1.5", last ? "-mb-(--diff-foot) pb-[calc(var(--diff-foot)+--spacing(2))]" : "mb-1.5")}>
    <div className="flex items-baseline gap-2">
      <span className="min-w-0 flex-1 text-sm font-semibold text-ink">
        {word && <><span className="inline-block rounded-sm border border-line bg-lit px-1.5 text-xs font-normal text-muted">{word}</span>{" "}</>}
        {was !== undefined && !moved ? <>{folded(was)} → {folded(name)}</> : folded(name)}
      </span>
      {(added > 0 || deleted > 0) && <span className="shrink-0 text-xs tabular-nums">
        {added > 0 && <span className="text-done">+{added}</span>}{added > 0 && deleted > 0 && " "}{deleted > 0 && <span className="text-error">−{deleted}</span>}
      </span>}
      {/* The diff's marks, centred on the name's first line, 12px past what the band says. */}
      {marks && <div className="-my-1 ms-1 -me-1 self-start">{marks}</div>}
    </div>
    {(moved || folder) && <div className="text-xs text-aside">{moved ? <>{folded(file.oldPath!)} → {folded(file.newPath!)}</> : folded(folder)}</div>}
  </div>;
}

/** A row as drawn: an original line (its letters and its line's end), or a hunk's place in words. */
type Row = { line: number; kind: "add" | "del" | "ctx" | "raw" | "hunk"; text: string; end: string; spans: readonly DiffSpan[] | null };

/** An original line's letters and its line's end. */
const sourceOf = (diff: { text: string; lines: readonly SourceLine[] }, line: number) => {
  const { start, contentEnd, end } = diff.lines[line]!;
  return { text: diff.text.slice(start, contentEnd), end: diff.text.slice(contentEnd, end) };
};

/** Where a hunk starts in its file, if not at the file's start on both sides (an empty side's start is 0). */
const atStart = (hunk: DiffHunk) => (hunk.oldCount ? hunk.oldStart === 1 : hunk.oldStart === 0) && (hunk.newCount ? hunk.newStart === 1 : hunk.newStart === 0);

/**
 * A part's rows. A hunk's `@@` line is not drawn: a file's first hunk at its start needs no word, any other is its first
 * line in the new file (in the old one, for a hunk that only removes) after a ⋯. Its whole `@@` line is in the copy mark's.
 */
function appendRows(shown: Row[], diff: StructuredDiffDocument, part: Exclude<DiffPart, { kind: "file" }>, colours: DiffColours | null, place: (line: number) => string, places: ReadonlyMap<number, number | null>): void {
  if (part.kind === "body") {
    shown.push({ line: part.line, kind: part.change, ...sourceOf(diff, part.line), spans: colours?.[part.line] ?? null });
    return;
  }
  if (part.kind === "raw") {
    for (let line = part.source[0]; line < part.source[1]; line++) shown.push({ line, kind: "raw", ...sourceOf(diff, line), spans: null });
    return;
  }
  const line = places.get(part.hunk)!;
  if (line !== null) shown.push({ line: part.hunk, kind: "hunk", text: place(line), end: "\n", spans: null });
}

/**
 * Each kind of row's look, under its letters' colours. An added or removed row has its ground and its +/- in the same
 * hue; a line describeDiff keeps as written (a mode, a `\ No newline at end of file`, words around the patch) and a
 * hunk's place are in the words under a title's colour, on the code's ground, the place smaller and in the words' font.
 * Each is 4.5:1 or more on its ground in either theme.
 */
const LOOK = { add: "bg-diff-add", del: "bg-diff-del", ctx: undefined, raw: "text-aside", hunk: "py-1 font-sans text-xs text-aside" } as const;
const MARK = { add: "text-done", del: "text-error" } as const;
/**
 * A row pads in by as much as its code reaches out to the frame's edges (DiffCode), the diff's last row to its foot
 * too, so its ground meets the frame and its letters stay where they were.
 */
const ROW = "block pe-(--diff-bleed)";
/** How far a folded row's next lines stand in from its text's start, and the most of a line's indent they follow. */
const FOLD_IN = 2, FOLD_INDENT = 8;

/**
 * One row. Its first column is the diff's +/- (or the space of a line kept): a folded row's next lines start FOLD_IN
 * columns in from where its text starts, so that column stays the +/-'s alone and a fold reads as the row it continues.
 * Each painted span carries both themes' colours (`--code-light`, `--code-dark`) and shows the applied theme's, so a
 * change of theme (in the coordinator's own window too) repaints nothing. Only colour: no weight or slant changes a
 * letter's width.
 */
function DiffRow({ kind, text, end, spans, foot }: Row & { foot: boolean }) {
  const hang = kind === "hunk" ? "0ch" : `${1 + Math.min(/^ */.exec(text.slice(1))![0].length, FOLD_INDENT) + FOLD_IN}ch`;
  return <span data-diff-line={kind} className={cn(ROW, LOOK[kind], foot && "pb-(--diff-foot)")}
    style={{ paddingInlineStart: `calc(var(--diff-bleed, 0px) + ${hang})`, textIndent: `-${hang}` }}>
    {kind === "add" || kind === "del" ? <><span className={MARK[kind]}>{text.slice(0, 1)}</span>{paint(text, spans, 1)}</>
      : kind === "ctx" ? paint(text, spans, 0) : text}{end}
  </span>;
}

function paint(line: string, spans: readonly DiffSpan[] | null, from: number) {
  const parts: ReactNode[] = [];
  let at = from;
  for (const [start, end, light, dark] of spans ?? []) {
    // The spans are the diff's (diff-types.ts); one that does not fit the line leaves its letters unpainted, never lost.
    if (start < at || end > line.length || start >= end) continue;
    if (start > at) parts.push(line.slice(at, start));
    parts.push(<span key={start} className="text-(--code-light) dark:text-(--code-dark)"
      style={{ "--code-light": light, "--code-dark": dark } as CSSProperties}>{line.slice(start, end)}</span>);
    at = end;
  }
  if (at < line.length) parts.push(line.slice(at));
  return parts;
}
