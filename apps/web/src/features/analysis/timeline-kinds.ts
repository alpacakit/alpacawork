import type { AnalysisBreakdownKeys, TraceSpan } from "./contract";

/**
 * How the timeline draws what `analysis trace` answers: one entry per kind of span and per part of the wall time. A new
 * kind of span is one more entry here (its colour, its height in the lane, and its name's key), and every lane, legend
 * and window draws it with the others.
 */
export type SpanLook = { color: (span: TraceSpan) => string; band: "full" | "thin" | "tick"; name: (span: TraceSpan) => string };
const STATE = { doing: "bg-working", waiting: "bg-turn", held: "bg-rest", todo: "bg-todo", done: "bg-done", stopped: "bg-stopped" } as Record<string, string>;
export const SPAN_LOOKS: Record<TraceSpan["kind"], SpanLook> = {
  "task-state": { color: span => STATE[(span as Extract<TraceSpan, { kind: "task-state" }>).state] ?? "bg-rest", band: "thin",
    name: span => `state.${(span as Extract<TraceSpan, { kind: "task-state" }>).state}` },
  question: { color: span => (span as Extract<TraceSpan, { kind: "question" }>).askedTo === "user" ? "bg-turn" : "bg-turn/50", band: "full",
    name: span => (span as Extract<TraceSpan, { kind: "question" }>).accept ? "span.acceptQuestion" : "span.question" },
  queued: { color: () => "bg-new", band: "thin", name: () => "span.queued" },
  run: { color: span => (span as Extract<TraceSpan, { kind: "run" }>).state === "failed" || (span as Extract<TraceSpan, { kind: "run" }>).state === "stopped"
    ? "bg-error" : "bg-working", band: "full", name: () => "span.run" },
  thinking: { color: () => "bg-working/40", band: "thin", name: () => "span.thinking" },
  step: { color: () => "bg-ink/70", band: "tick", name: () => "span.step" },
};

/** The parts of the wall time, in the order the trace gives an instant to them, with their colours. */
export const PART_COLOR: Record<AnalysisBreakdownKeys, string> = {
  "owner-working": "bg-working", "member-working": "bg-working/65", "child-working": "bg-working/35", held: "bg-rest",
  "waiting-answer": "bg-turn", "waiting-review": "bg-turn/60", queued: "bg-new", idle: "bg-rest/50",
};
