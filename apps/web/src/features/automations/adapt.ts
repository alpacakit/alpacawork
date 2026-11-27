import type { z } from "zod";
import { automationEventDisplay } from "@alpacawork/contract/automation-program";
import type { automationProgramListResultSchema, automationProgramPreviewResultSchema, automationProgramRunSchema, AutomationProgramView,
  AutomationVersion, ProgramAutomationEvent } from "@alpacawork/contract/automation-program";
import type { Automation, AutomationList, Operation, Preview, PreviewResult, Run, RunDetail, RunEvent, Version } from "./shape";

/**
 * The server's automations, as the screen reads them: the one place that turns what the server hands over into what
 * the screen draws (shape.ts). What the server leaves unknown (how an AI row is used, when its static reading cannot tell) is
 * drawn as unknown, never made up.
 */
type ListItem = z.infer<typeof automationProgramListResultSchema>["automations"][number];
type ServerRun = z.infer<typeof automationProgramRunSchema>;
type ServerPreviewResult = z.infer<typeof automationProgramPreviewResultSchema>;

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const plain = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

/**
 * Who saved a version and from what, by the server's actors: a person (`human`), the coordinator (`main`, with the
 * person's words it was asked in), an agent's placement, an automation, or the server itself.
 */
function savedBy(value: unknown, request: AutomationVersion["sourceRequest"]): Version["savedBy"] {
  const by = record(value);
  if (by.kind === "human") return { kind: "person", name: null, request: null };
  // The coordinator's save names the person's words it was asked in: the message it was given, else its own quote.
  if (by.kind === "main") return { kind: "coordinator", name: null, request: request?.text ?? (typeof by.quote === "string" ? by.quote : null) };
  return { kind: "agent", name: null, request: null };
}

export function toPreview(preview: NonNullable<AutomationVersion["preview"]>): Preview {
  const operations = preview.operations.map(toOperation);
  return { hash: preview.hash, at: preview.at, by: typeof preview.by === "string" ? preview.by : "", event: { kind: preview.event.kind, ref: preview.event.ref, manual: preview.event.manual },
    trigger: preview.trigger, operations,
    ran: preview.ran,
    durationMs: null, outcome: preview.outcome };
}

/**
 * The facts of a version. An AI row is said as a short judgement or as whom a task is given to only when the server
 * read it used one way alone; used both ways, or not read, it is said by its name.
 */
function toFacts(facts: AutomationVersion["facts"]): Version["facts"] {
  return { ...facts, when: { ...facts.when, where: record(facts.when.where) },
    ai: facts.ai.map(row => ({ name: row.name, agent: row.agent, model: row.model, effort: row.effort, costHint: row.costHint,
      ...row.uses?.length === 1 ? { use: row.uses[0] === "ai.ask" ? "ask" as const : "task" as const } : {} })) };
}

export function toVersion(version: AutomationVersion): Version {
  return { digest: version.digest, contractVersion: version.contractVersion, savedAt: version.savedAt, savedBy: savedBy(version.savedBy, version.sourceRequest),
    files: version.files, facts: toFacts(version.facts),
    docs: version.docs, parts: version.parts, missingDestinations: version.missingDestinations, direct: version.outsideEffects.map(effect => ({ kind: effect.kind, text: effect.text })), review: version.review as Version["review"],
    preview: version.preview ? toPreview(version.preview) : null };
}

function toOperation(operation: { name: string; target: unknown; input: unknown; replaced: boolean; result: unknown; code: string | null;
  usage: { model: string | null; costUsd: number | null } | null; durationMs?: number | null; outcome?: string }): Operation {
  const result = operation.durationMs != null && record(operation.result) === operation.result ? { ...record(operation.result), durationMs: operation.durationMs } : operation.result;
  return { name: operation.name, target: targetWords(operation.target), input: operation.input, replaced: operation.replaced,
    result: result ?? null, code: operation.code, failed: operation.outcome === "failed" || operation.code !== null, usage: operation.usage ? { model: operation.usage.model ?? "", costUsd: operation.usage.costUsd } : null };
}

/**
 * What an operation was done to, as a person reads it: a destination by its name and host, a task by its number. A task
 * a showing would make has no number yet (`preview-1`): it is none here, said as the task it would make.
 */
function targetWords(target: unknown): string | null {
  if (target === null || target === undefined) return null;
  if (typeof target === "string") return target.startsWith("preview-") ? null : target;
  const named = record(target);
  if (typeof named.task === "string") return named.task.startsWith("preview-") ? null : named.task;
  if (typeof named.name === "string") return typeof named.host === "string" && named.host !== named.name ? `${named.name} (${named.host})` : named.name;
  return plain(target);
}

/** An event's line and what arrived with it, by its kind: a task's title, a signal's newest data, the pressure's kinds. */
export function toEvent(event: ProgramAutomationEvent): RunEvent {
  const { kind, ref, manual, at } = event;
  return { kind, ref, manual, at, ...automationEventDisplay(event) };
}

/** A run, with the tasks it made (from its operations) and the skipped runs folded into it. */
export function toRun(automationId: string, run: ServerRun): Run {
  const tasks = run.operations.flatMap(operation => {
    const result = record(operation.result), input = record(operation.input);
    return operation.name === "tasks.create" && !operation.replaced && typeof result.id === "string"
      ? [{ id: result.id, title: typeof input.title === "string" ? input.title : "", state: operation.taskState }] : [];
  });
  return { automationId, number: run.number, version: run.version, at: run.at, kind: run.mode === "live" ? "real" : "trial", state: run.state, phase: run.phase,
    event: run.event, digest: run.digest, trigger: run.trigger, summary: run.summary, notify: run.notify,
    reasonKind: run.reasonKind, reasonText: run.reason, error: run.error, startedAt: run.startedAt, endedAt: run.finishedAt, tasks, httpStatus: answeredStatus(run.operations),
    ...run.count > 1 ? { folded: run.count - 1 } : {} };
}

/** The status a destination answered with on the last send or read that did not go through (none when none answered). */
function answeredStatus(operations: readonly { name: string; outcome: string; result: unknown }[]): number | null {
  const failed = operations.filter(operation => (operation.name === "send" || operation.name === "fetch") && operation.outcome === "failed").at(-1);
  const status = record(failed?.result).status;
  return typeof status === "number" ? status : null;
}

export function toRunDetail(automationId: string, run: ServerRun, event: ProgramAutomationEvent | null): RunDetail {
  const stdout = run.output.filter(part => part.stream === "stdout").map(part => part.text).join("");
  const stderr = run.output.filter(part => part.stream === "stderr").map(part => part.text).join("");
  return { ...toRun(automationId, run), ...event ? { event: { ...run.event, ...toEvent(event) } } : {},
    operations: run.operations.map(toOperation), report: run.report, output: stdout || stderr ? { stdout, stderr } : null };
}

/** What asks for a look, with the run that failed and why when it is a failure (the server names it). */
function attentionOf(attention: AutomationProgramView["attention"], lastRun: ServerRun | null = null): Automation["attention"] {
  // What a destination answered is read from the run that failed, when it is the last one.
  return attention.map(item => item.kind === "failed" ? { kind: item.kind, at: item.at, run: item.run, reasonKind: item.reasonKind, reasonText: item.reason,
    httpStatus: lastRun?.number === item.run ? answeredStatus(lastRun.operations) : null }
    : { kind: item.kind, at: item.at, run: null, reasonKind: null, reasonText: null });
}

/** The last 7 days, as the server counts them. */
const toWeek = (week: AutomationProgramView["week"]): NonNullable<Automation["week"]> => week;

/** One automation in full (`automation get`). */
export function toAutomation(view: AutomationProgramView): Automation {
  return { id: view.id, project: view.project, name: view.name, enabled: view.enabled, disabledReason: view.disabledReason, hash: view.hash,
    latest: toVersion(view.latest), live: view.live ? toVersion(view.live) : null, awaitingEnable: view.awaitingEnable,
    everEnabled: view.everEnabled, hook: view.hook, pendingSignal: view.pendingSignal,
    lastRun: view.lastRun ? toRun(view.id, view.lastRun) : null, next: view.nextAt ? [view.nextAt] : [], attention: attentionOf(view.attention, view.lastRun), week: toWeek(view.week) };
}

/**
 * One automation as the list has it: what the table draws. What only its window reads (its versions in full, its
 * receiving point) is read with `automation get` when it opens.
 */
function fromListItem(item: ListItem): Automation {
  const latest: Version = { digest: "", contractVersion: 0, savedAt: "", savedBy: { kind: "person", name: null, request: null }, files: [],
    facts: toFacts(item.latest.facts), docs: item.latest.docs, parts: [], missingDestinations: item.latest.missingDestinations, direct: null,
    review: item.latest.review as Version["review"], preview: null };
  return { id: item.id, project: item.project, name: item.name, enabled: item.enabled, disabledReason: item.disabledReason, hash: item.hash, latest, live: null,
    awaitingEnable: item.awaitingEnable, everEnabled: item.everEnabled, hook: { exists: false }, pendingSignal: null,
    lastRun: item.lastRun ? toRun(item.id, item.lastRun) : null, next: item.nextAt ? [item.nextAt] : [], attention: attentionOf(item.attention, item.lastRun), week: toWeek(item.week), listed: true };
}

export function toList(list: z.infer<typeof automationProgramListResultSchema>): AutomationList {
  return { automations: list.automations.map(fromListItem), today: { ai: list.today.aiCalls, outside: list.today.outside } };
}

export function toPreviewResult(result: ServerPreviewResult): PreviewResult {
  return { candidates: result.events.map(event => ({ ...toEvent(event), at: event.at })), preview: result.preview ? toPreview(result.preview) : null };
}
