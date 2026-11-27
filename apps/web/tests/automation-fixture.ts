import { queryClient } from "../src/data/query-client";
import { madeTasksKey } from "../src/features/automations/data";
import type { Automation, AutomationList, Doc, Run, Version } from "../src/features/automations/shape";
import type { screenData } from "./fixtures";

const doc = (summary: string): Doc => ({ summary, body: "", params: [], returns: null, throws: [] });

/** One version: a program run by a signal, up to 10 a day, asking an AI for a task. */
export const version = (extra: Partial<Version> = {}): Version => ({
  digest: "sha256:" + "a".repeat(64), contractVersion: 1, savedAt: "2026-11-27T05:00:00.000Z",
  savedBy: { kind: "coordinator", name: null, request: "only from 3 on" },
  files: [{ path: "main.ts", bytes: 400 }],
  facts: { when: { event: "signal", where: {}, textKey: "trigger.signal", filter: null },
    limits: { perDay: 10, cooldownMinutes: 0, waitForPrevious: true, until: null, timeoutMinutes: 10, aiCallsPerDay: 20, tasksPerRun: 1, timezone: "UTC" },
    ai: [{ name: "worker", agent: "claude", model: "opus", effort: "high", use: "task", costHint: null }], outside: [] },
  docs: { run: doc("Counts the waiting tasks and asks for one summary task"), trigger: null },
  parts: [], direct: [],
  review: { state: "ok", findings: [], summary: "", model: "sonnet", at: "2026-11-27T05:01:00.000Z", acknowledged: null },
  preview: null, ...extra,
});

/** One automation as the server lists it: on, running the version above, asking for nothing, unless told otherwise. */
export const automation = (extra: Partial<Automation> = {}): Automation => {
  const latest = extra.latest ?? version();
  return {
    id: "A2", project: "P1", name: "Morning", enabled: true, disabledReason: null, hash: "h".repeat(64),
    latest, live: latest, awaitingEnable: false, everEnabled: true, hook: { exists: false }, pendingSignal: null, lastRun: null, next: [],
    attention: [], week: { matched: 0, started: 0, done: 0, failed: 0, stopped: 0, skipped: 0, skippedBy: [], busiestDay: 0 }, ...extra,
  };
};

/** One run: done, having made no task, unless told otherwise. */
export const run = (number: number, extra: Partial<Run> = {}): Run => ({
  automationId: "A2", number, version: 1, at: "2026-11-27T00:00:00.000Z", kind: "real", state: "done", phase: null,
  event: { kind: "signal", ref: `s${number}`, manual: false }, digest: "sha256:" + "a".repeat(64), trigger: null, summary: "Did it", notify: false,
  reasonKind: null, reasonText: null, error: null, startedAt: null, endedAt: null, tasks: [], ...extra,
});

export const listOf = (automations: Automation[], extra: Partial<AutomationList> = {}): AutomationList => ({ automations, today: { ai: 0, outside: 0 }, ...extra });

/** Puts the list (and each automation's runs) where the screen reads them, as read already. */
export function seedAutomations(data: ReturnType<typeof screenData>, list: AutomationList, runs: Record<string, Run[]> = {}) {
  queryClient.setQueryData(["automations", data.info.root, data.info.automationsVersion, madeTasksKey(data.tasks, null)], list);
  for (const [id, each] of Object.entries(runs)) queryClient.setQueryData(["automation-runs", data.info.root, id, data.info.automationsVersion, madeTasksKey(data.tasks, id)], each);
}

/** Puts one automation, read whole, where its window reads it. */
export function seedOne(data: ReturnType<typeof screenData>, one: Automation) {
  queryClient.setQueryData(["automation", data.info.root, one.id, data.info.automationsVersion, madeTasksKey(data.tasks, one.id)], one);
}

/** A signal the server keeps, in its own shape. */
export const serverSignal = (ref: string, data: Record<string, unknown> = {}) => ({ kind: "signal", ref, at: "2026-11-27T00:37:00.000Z", manual: false, count: 1,
  firstAt: "2026-11-27T00:37:00.000Z", lastAt: "2026-11-27T00:37:00.000Z", items: [{ at: "2026-11-27T00:37:00.000Z", by: { kind: "human" }, key: null, data }] });

/** A showing as the server answers it: `trigger` alone, or with what `run` would do. */
export const serverPreview = (ref: string, reason: string, operations: unknown[] = [], summary: string | null = null, ran = summary !== null) => ({
  hash: `p-${ref}${operations.length ? "-run" : ""}`, at: "2026-11-27T01:00:00.000Z", by: "you", event: { kind: "signal", ref, manual: false },
  trigger: { run: true, reason }, ran, operations, outcome: { state: "done", summary, report: null, notify: false, error: null } });

/** A run as the server answers it. */
export const serverRun = (number: number, mode: "live" | "trial" = "live") => ({ number, version: 1, digest: "sha256:" + "a".repeat(64), activationRevision: null,
  event: { kind: "signal", ref: `s${number}`, manual: false }, mode, state: "done", phase: null, at: "2026-11-27T01:00:00.000Z", lastAt: "2026-11-27T01:00:00.000Z",
  startedAt: null, phaseStartedAt: null, runStartedAt: null, finishedAt: null, count: 1, reasonKind: null, reason: null, trigger: null, summary: "did it",
  report: null, notify: false, error: null, operations: [], output: [] });
