import type { Task } from "@/data/types";

/** A length of time as a list says it: minutes, then whole hours, then whole days. */
export function shortLength(ms: number): { unit: "minutes" | "hours" | "days"; count: number } {
  const minutes = Math.max(0, ms) / 60_000;
  if (minutes < 60) return { unit: "minutes", count: Math.max(1, Math.floor(minutes)) };
  if (minutes < 24 * 60) return { unit: "hours", count: Math.floor(minutes / 60) };
  return { unit: "days", count: Math.floor(minutes / (24 * 60)) };
}

/** A length of work as a list says it: minutes, then whole hours, never days (it is an amount, not a span of the calendar). */
export function workLength(ms: number): { unit: "minutes" | "hours"; count: number } {
  const minutes = Math.max(0, ms) / 60_000;
  return minutes < 60 ? { unit: "minutes", count: Math.max(1, Math.floor(minutes)) } : { unit: "hours", count: Math.floor(minutes / 60) };
}

type RowSource = Pick<Task, "homeRow">;
type RowTask = Pick<Task, "state" | "rowFacts" | "homeRow">;

/** The home list's section for a row it lists; none for a row drawn outside it (a dated Done row). */
export const rowSection = (task: RowSource) => task.homeRow?.section ?? null;

/**
 * A Working row whose own Run does not run stands for the work below it: running while a Task below runs, else queued
 * (the server lists it in Working only while its own Run or one below is at work).
 */
export function representedWork(task: Pick<RowTask, "homeRow" | "rowFacts">): "running" | "queued" | null {
  const own = task.rowFacts.status?.kind;
  if (rowSection(task) !== "doing" || own === "running" || own === "queued" || own === "unclear") return null;
  return task.rowFacts.childrenRunning > 0 ? "running" : "queued";
}

/** How many Runs a Working row says are running on it and under it; any other row, or none running, says nothing. */
export const runningRunsSaid = (task: Pick<RowTask, "homeRow" | "rowFacts">) => rowSection(task) === "doing" ? task.rowFacts.runningRuns : 0;

/** A review row says no Run status, work time, state time or end words: its icon says the review. */
export const saysRuns = (task: RowSource) => rowSection(task) !== "review";

/** An awaited row does not repeat that it is idle. */
export function saysStatus(task: RowSource, kind: NonNullable<RowTask["rowFacts"]["status"]>["kind"]): boolean {
  return saysRuns(task) && (rowSection(task) !== "awaited" || kind === "unclear");
}
