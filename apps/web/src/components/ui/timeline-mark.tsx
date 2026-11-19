import { cn } from "@/lib/utils";
import { Icon, type IconName } from "./icon";
import { TONE, type Tone } from "./tone";

/**
 * The one set of event marks for every timeline (the list's time view and the reader's
 * History), drawn with the screen's own icons (components/ui/icon). The shape says what happened; the
 * colour is whose turn it is after it (components/ui/tone: working, turn, error, done, or quiet), the same
 * colour the list's line takes from there on.
 */
export type MarkKind = "request" | "report" | "approve" | "error" | "wait" | "estimate" | "start" | "record" | "held" | "up" | "down" | "by";
/** Whose turn it is after an event: an agent's (working), yours (turn), nobody's because it stopped (error), finished (done), or unchanged (quiet). */
export type MarkTone = Tone;

const ICON: Record<MarkKind, IconName> = {
  request: "request", report: "report", approve: "done", error: "error",
  wait: "waiting", held: "held", estimate: "doing", start: "run", record: "record", up: "arrowUp", down: "arrowDown", by: "record",
};
/**
 * What stands on a timeline's rail (a mark, the dot of a write being sent, the line of the row in view) is centred on
 * the rail's centre, whatever its own width: `--rail` is the x of the 1px rail's left edge in the row the timeline sets
 * it on, so a timeline says where its rail runs once (ReportFeed, CoordinatorThread). The box is laid out on that
 * whole pixel and the half pixel to the rail's centre is in its translate: a browser rounds a laid-out half pixel when
 * it paints, either way, so a mark laid out on the centre itself stood half a pixel beside the rail.
 */
export const ON_RAIL = "absolute left-(--rail) translate-x-[calc(0.5px-50%)]";
/**
 * A mark in an HTML row (History's rail): a 14px icon on a disc of the row's own colour, so the rail stops at it.
 * A `live` mark stands for work going on now and pulses as the screen's other marks of work at work do (the
 * coordinator's dot, `animate-pulse`); only its glyph pulses, so the disc keeps the rail stopped at it.
 */
export function TimelineMark({ kind, tone, live, className }: { kind: MarkKind; tone: MarkTone; live?: boolean; className?: string }) {
  return <Icon name={ICON[kind]} data-live-mark={live || undefined}
    className={cn("size-3.5 rounded-full bg-lit ring-2 ring-lit", TONE[tone], live && "motion-safe:*:animate-pulse", className)} />;
}

/** The same mark inside an SVG (the list's line), centred on (x, y), with `surface` under it. */
export function MarkShape({ kind, tone, x, y, surface }: { kind: MarkKind; tone: MarkTone; x: number; y: number; surface: string }) {
  return <g className={TONE[tone]}>
    <circle cx={x} cy={y} r={6.5} className={surface} fill="currentColor" />
    <Icon name={ICON[kind]} x={x - 6} y={y - 6} width={12} height={12} className={cn("size-3", TONE[tone])} />
  </g>;
}
