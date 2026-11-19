import type { CSSProperties, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import type { DiffSpan } from "../diff/diff-types";

/**
 * A line of a file as the viewer shows it, a file's text and a diff's rows alike: its numbers (one column for a file;
 * the old file's and the new one's for a diff, of which a phone shows only `phone`), its letters, and for a diff the
 * line's +/− and its ground. `id` names the line within its page: where a line is chosen or remarked on, this is what
 * names it.
 */
export type Line = { kind: "line"; id: string; numbers: readonly (number | null)[]; phone: number | null; tone?: "add" | "del"; text: ReactNode };
/** A band across the rows: a hunk's start, saying the function it is in; null where git names none, a thin gap. */
export type Band = { kind: "band"; id: string; content: ReactNode | null };

const SIGN = { add: "+", del: "−" } as const;
const GROUND = { add: "bg-diff-add", del: "bg-diff-del" } as const;
/** A changed row's number and +/−, a step deeper than its letters' ground, so a run of changes reads down the edge. */
const EDGE = { add: "bg-diff-add-number", del: "bg-diff-del-number" } as const;
const NUMBER = "select-none pe-2 text-end text-aside tabular-nums";

/**
 * The one way the viewer lays out lines: a grid of numbers, the +/− when `signs`, and the letters, folding at the frame's
 * edge (a fold stays in the letters' column). Numbers and signs are only read, never copied with the letters.
 */
export function LineRows({ rows, signs, frame, className }: { rows: readonly (Line | Band)[]; signs: boolean; frame?: Ref<HTMLDivElement>; className?: string }) {
  const lines = rows.filter((row): row is Line => row.kind === "line");
  const columns = lines[0]?.numbers.length ?? 1;
  const widest = lines.reduce((most, line) => Math.max(most, ...line.numbers.map(number => number ?? 0)), 0);
  const numbers = (count: number) => Array.from({ length: count }, (_, at) => at ? "calc(var(--digits) + 1rem)" : "calc(var(--digits) + var(--pad) + 0.5rem)").join(" ");
  const sign = signs ? " 2ch" : "";
  // The first column reaches from the frame's edge: its widest number starts at the room the viewer's head and headings
  // keep at the left (--pad), so a line's number lines up under the title; the others are a number and its room apart.
  return <div ref={frame} data-line-rows="" style={{ "--digits": `${String(widest).length}ch`,
    "--wide": `${numbers(columns)}${sign} 1fr`, "--narrow": `${numbers(1)}${sign} 1fr` } as CSSProperties}
    className={cn("grid grid-cols-(--wide) font-mono text-sm [--pad:--spacing(4)] narrow:grid-cols-(--narrow) narrow:[--pad:--spacing(3)]", className)}>
    {rows.map(row => row.kind === "band"
      ? <div key={row.id} data-line-band="" className={cn("col-span-full px-4 narrow:px-3", "min-w-0 bg-rule text-xs text-aside", row.content === null ? "h-1.5" : "py-0.5")}>{row.content}</div>
      : <div key={row.id} data-line={row.tone ?? "ctx"} data-line-id={row.id} className={cn("col-span-full grid grid-cols-subgrid", row.tone && GROUND[row.tone])}>
        {row.numbers.map((number, i) => <span key={i} className={cn(NUMBER, row.tone && EDGE[row.tone], columns > 1 && "narrow:hidden")}>{number}</span>)}
        {/* A phone has one column of numbers: a diff's new file's, none for a removed line, so they read on without jumping back. */}
        {columns > 1 && <span className={cn(NUMBER, row.tone && EDGE[row.tone], "hidden narrow:block")}>{row.phone}</span>}
        {signs && <span aria-hidden="true" className={cn("select-none text-center", row.tone && EDGE[row.tone], row.tone === "add" ? "text-done" : row.tone === "del" ? "text-error" : "")}>{row.tone ? SIGN[row.tone] : " "}</span>}
        <span className="min-w-0 pe-4 whitespace-pre-wrap [overflow-wrap:anywhere] narrow:pe-3">{row.text}</span>
      </div>)}
  </div>;
}

/** One side of a row side by side: its number in its file, its +/− and ground, its letters. */
export type Half = { number: number | null; tone?: "add" | "del"; text: ReactNode };
/** A row side by side: the old file's line at the left, the new one's at the right; null where that side has none. */
export type SideLine = { kind: "side"; id: string; left: Half | null; right: Half | null };

/**
 * A diff's lines side by side (a computer's split view), laid out as LineRows lays out its lines: each side its number,
 * its +/− and its letters folding in its own half, the two halves parted by a rule; a side with no line is filled grey.
 */
export function SideRows({ rows, frame, className }: { rows: readonly (SideLine | Band)[]; frame?: Ref<HTMLDivElement>; className?: string }) {
  const widest = rows.reduce((most, row) => row.kind === "side" ? Math.max(most, row.left?.number ?? 0, row.right?.number ?? 0) : most, 0);
  const half = (side: Half | null, at: "left" | "right") => {
    const ground = side?.tone ? GROUND[side.tone] : side ? "" : "bg-well";
    const number = side?.tone ? EDGE[side.tone] : ground;
    const edge = at === "right" ? "border-s border-rule" : "";
    return <>
      <span className={cn(NUMBER, number, edge, at === "left" && "ps-4")}>{side?.number}</span>
      <span aria-hidden="true" className={cn("select-none text-center", number, side?.tone === "add" ? "text-done" : side?.tone === "del" ? "text-error" : "")}>{side?.tone ? SIGN[side.tone] : " "}</span>
      <span className={cn("min-w-0 pe-3 whitespace-pre-wrap [overflow-wrap:anywhere]", ground)}>{side?.text}</span>
    </>;
  };
  return <div ref={frame} data-line-rows="" data-side-rows="" style={{ "--digits": `${String(widest).length}ch` } as CSSProperties}
    className={cn("grid grid-cols-[calc(var(--digits)+1.5rem)_2ch_1fr_calc(var(--digits)+1rem)_2ch_1fr] font-mono text-sm", className)}>
    {rows.map(row => row.kind === "band"
      ? <div key={row.id} data-line-band="" className={cn("col-span-full px-4", "min-w-0 bg-rule text-xs text-aside", row.content === null ? "h-1.5" : "py-0.5")}>{row.content}</div>
      : <div key={row.id} data-line-id={row.id} className="col-span-full grid grid-cols-subgrid">{half(row.left, "left")}{half(row.right, "right")}</div>)}
  </div>;
}

/**
 * A line's letters from `from` (1 past a diff row's +/-, 0 for a file's line): in its letters' colours (the spans, both
 * themes', as DiffBlock paints them) and, on the words that changed, the changed ground. Spans and words that do not fit
 * the line leave its letters as they are.
 */
export function paint(line: string, spans: readonly DiffSpan[] | null, words: readonly (readonly [number, number])[] | null, changed: string, from: 0 | 1): ReactNode[] {
  const cuts = new Set([from, line.length]);
  const colour = (spans ?? []).filter(([start, end]) => start >= from && end <= line.length && start < end);
  const marked = (words ?? []).filter(([start, end]) => start >= from && end <= line.length && start < end);
  for (const [start, end] of [...colour, ...marked]) { cuts.add(start); cuts.add(end); }
  const at = [...cuts].sort((a, b) => a - b);
  const parts: ReactNode[] = [];
  for (let i = 0; i < at.length - 1; i++) {
    const start = at[i]!, end = at[i + 1]!;
    if (start >= end) continue;
    const span = colour.find(([from, to]) => from <= start && end <= to);
    const word = marked.some(([from, to]) => from <= start && end <= to);
    const letters = line.slice(start, end);
    parts.push(span || word ? <span key={start} className={cn(span && "text-(--code-light) dark:text-(--code-dark)", word && changed)}
      style={span ? { "--code-light": span[2], "--code-dark": span[3] } as CSSProperties : undefined}>{letters}</span> : letters);
  }
  return parts;
}
