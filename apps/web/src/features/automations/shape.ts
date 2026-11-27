import { z } from "zod";
import { automationEventReferenceSchema, automationProgramErrorSchema } from "@alpacawork/contract/automation-program";

/**
 * What the server hands the screen about automations, as the screen reads it. An automation is a program an AI wrote:
 * its entry exports `config` (values the server reads before running anything), an optional `trigger` and `run`, each
 * described by its JSDoc. The server turns `config` into the facts the screen shows (`Facts`) and the JSDoc into words
 * (`Docs`); the screen draws them and never works out on its own what may be done or what a sentence says.
 *
 * The server's own shapes (contract automation-program.ts) are turned into these in one place (adapt.ts); a field the
 * server does not say yet is null here, and the screen draws it as unknown.
 */

const at = z.string();
const json = z.unknown();

/** One function's JSDoc, as words: its first line, its body (Markdown), what it takes, what it returns, when it throws. */
export const docSchema = z.object({
  summary: z.string(), body: z.string(), params: z.array(z.object({ name: z.string(), text: z.string() })),
  returns: z.string().nullable(), throws: z.array(z.string()),
});
export type Doc = z.infer<typeof docSchema>;

/** The four lines of facts the server makes from `config`: when, the limits, the AI it may use, where it may send. */
export const factsSchema = z.object({
  /** The kind of event and how it is narrowed (`textKey` picks the words), and the first line of `trigger`, if any. */
  when: z.object({ event: z.string(), where: z.record(z.string(), json), textKey: z.string(), filter: z.string().nullable() }),
  limits: z.object({ perDay: z.number(), cooldownMinutes: z.number(), waitForPrevious: z.boolean(), until: z.string().nullable(),
    timeoutMinutes: z.number(), aiCallsPerDay: z.number(), tasksPerRun: z.number(), timezone: z.string() }),
  /** Each AI it may use, by its name in the program: a short question (`ai.ask`) or a task's agent. The cost is the last 7 days' average per call. */
  ai: z.array(z.object({ name: z.string(), agent: z.string(), model: z.string(), effort: z.string().nullable(),
    use: z.enum(["ask", "task"]).optional(), costHint: z.object({ perCallUsd: z.number() }).nullable() })),
  /** Where it may send: a destination's name and its host (null, and not ready, until a person enters it). */
  outside: z.array(z.object({ name: z.string(), host: z.string().nullable(), ready: z.boolean() })),
});
export type Facts = z.infer<typeof factsSchema>;

/** An AI's look at a version after it was saved: whether it found something to fix, and where. */
export const reviewSchema = z.object({
  state: z.enum(["ok", "fix", "unavailable", "running"]),
  findings: z.array(z.object({ level: z.enum(["must", "note"]), file: z.string(), line: z.number().nullable(), text: z.string() })),
  summary: z.string(), model: z.string().nullable(), at: at.nullable(),
  acknowledged: z.object({ by: z.string(), at }).nullable(),
});
export type Review = z.infer<typeof reviewSchema>;

/** One operation the program asked of alpacawork through its SDK (made a task, asked an AI, sent…). */
export const operationSchema = z.object({
  name: z.string(), target: z.string().nullable(), input: json, replaced: z.boolean(), result: json.nullable(), code: z.string().nullable(),
  usage: z.object({ model: z.string(), costUsd: z.number().nullable() }).nullable(),
});
export type Operation = z.infer<typeof operationSchema>;

/** The event a run or a preview went by. `title` is its line in words; `fields` what arrived, as names and values. */
export const eventSchema = automationEventReferenceSchema.extend({ at: at.optional(),
  title: z.string().nullable().optional(), fields: z.array(z.tuple([z.string(), z.string()])).optional() });
export type RunEvent = z.infer<typeof eventSchema>;

/** What showing it did at one event: `trigger`'s answer, and (once `run` was shown too) what it would do. */
export const previewSchema = z.object({
  hash: z.string(), at, by: z.string(), event: eventSchema,
  trigger: z.object({ run: z.boolean(), reason: z.string() }).nullable(),
  /** Whether `run` was shown as well (the second step): until then only `trigger` ran. */
  ran: z.boolean(),
  durationMs: z.number().nullable().optional(),
  operations: z.array(operationSchema),
  outcome: z.object({ state: z.enum(["done", "skipped", "stopped", "failed"]), summary: z.string().nullable(), report: z.string().nullable(),
    notify: z.boolean(), error: automationProgramErrorSchema.nullable() }).nullable(),
});
export type Preview = z.infer<typeof previewSchema>;

/** One version of an automation: its files, the facts and words made from them, the AI's look, the last showing. */
export const versionSchema = z.object({
  digest: z.string(), contractVersion: z.number(), savedAt: at,
  /** Who saved it, and from what: a person, or the coordinator asked in these words (`request`). */
  savedBy: z.object({ kind: z.enum(["person", "coordinator", "agent"]), name: z.string().nullable(), request: z.string().nullable() }),
  files: z.array(z.object({ path: z.string(), bytes: z.number() })),
  facts: factsSchema, docs: z.object({ run: docSchema, trigger: docSchema.nullable() }),
  /** The `node:` parts it uses, and what it does that does not go through alpacawork (files, the network, other programs). */
  parts: z.array(z.string()), direct: z.array(z.object({ kind: z.enum(["file", "network", "process", "other"]), text: z.string() })).nullable(),
  review: reviewSchema, preview: previewSchema.nullable(),
});
export type Version = z.infer<typeof versionSchema>;

/** What a run came to. Skipped: `run` never began; stopped: it began and was stopped. */
export const runStateSchema = z.enum(["waiting", "skipped", "running", "done", "failed", "stopped"]);
export type RunState = z.infer<typeof runStateSchema>;

/** One run, as listed: its event, how far it went, what `trigger` said, the line `run` returned or why it failed. */
export const runSchema = z.object({
  automationId: z.string(), number: z.number(), version: z.number(), at,
  kind: z.enum(["real", "trial"]), state: runStateSchema, phase: z.enum(["trigger", "run", "stopping"]).nullable(),
  event: eventSchema, digest: z.string(),
  trigger: z.object({ run: z.boolean(), reason: z.string() }).nullable(),
  summary: z.string().nullable(), notify: z.boolean(),
  /** Why it was skipped or failed: a kind the screen has words for, and the server's own sentence. */
  reasonKind: z.string().nullable(), reasonText: z.string().nullable(),
  error: automationProgramErrorSchema.nullable(),
  startedAt: at.nullable(), endedAt: at.nullable(),
  /** The tasks it made (from their origin), each with its state as the run last read it. */
  tasks: z.array(z.object({ id: z.string(), title: z.string(), state: z.string().nullable() })),
  /** Skipped runs folded into this one (the same reason, one after another). */
  folded: z.number().optional(),
});
export type Run = z.infer<typeof runSchema>;

/** One run in full: what arrived, its operations, its report and the end of what it printed. */
export const runDetailSchema = runSchema.extend({
  operations: z.array(operationSchema), report: z.string().nullable(),
  output: z.object({ stdout: z.string(), stderr: z.string() }).nullable(),
});
export type RunDetail = z.infer<typeof runDetailSchema>;

/**
 * What asks for a look: a failed run, turned off by itself, a new version waiting to be turned on, a run stopping. A
 * failure names the run that failed and why (later runs may have been skipped since, for other reasons).
 */
export const attentionSchema = z.object({ kind: z.enum(["failed", "disabled", "awaiting_enable", "stopping"]), at,
  run: z.number().nullable(), reasonKind: z.string().nullable(), reasonText: z.string().nullable() });
export type Attention = z.infer<typeof attentionSchema>;

/** The last 7 days of runs: those its event matched, those that went on to `run`, failed, skipped (and why, counted). */
export const weekSchema = z.object({ matched: z.number(), started: z.number(), failed: z.number(), skipped: z.number(),
  skippedBy: z.array(z.object({ reason: z.string(), count: z.number() })), busiestDay: z.number() });

export const automationSchema = z.object({
  id: z.string(), project: z.string(), name: z.string(), enabled: z.boolean(), deleted: z.boolean().optional(),
  /** Why it is off when it went off by itself (failures one after another, the SDK changed…): a kind with words. */
  disabledReason: z.string().nullable(),
  /** The hash a write to it is checked against: it moves with every change. */
  hash: z.string(),
  latest: versionSchema, live: versionSchema.nullable(),
  /** On, with a newer version than the one running: it waits for a person to turn it on. */
  awaitingEnable: z.boolean(),
  /** Whether it was ever on (a draft never was). */
  everEnabled: z.boolean(),
  hook: z.object({ exists: z.boolean() }),
  pendingSignal: z.object({ count: z.number(), firstAt: at, lastAt: at }).nullable(),
  lastRun: runSchema.nullable(),
  /** The next times it runs by the clock (on), or would (off). */
  next: z.array(at),
  attention: z.array(attentionSchema),
  week: weekSchema.nullable(),
  /** Read from the list, which holds only what the table draws: its window reads it whole. */
  listed: z.boolean().optional(),
});
export type Automation = z.infer<typeof automationSchema>;

export const automationListSchema = z.object({
  automations: z.array(automationSchema),
  /** Today's calls to an AI and operations sent out of this PC, across every automation. */
  today: z.object({ ai: z.number(), outside: z.number() }),
});
export type AutomationList = z.infer<typeof automationListSchema>;

export const automationGetSchema = z.object({ automation: automationSchema });
export const runsSchema = z.object({ runs: z.array(runSchema) });
export const runDetailResultSchema = z.object({ run: runDetailSchema });
/** A showing: the events it can be shown at (the newest first), the one chosen, and what showing it there did. */
export const previewResultSchema = z.object({
  candidates: z.array(eventSchema.extend({ at })),
  preview: previewSchema.nullable(),
});
export type PreviewResult = z.infer<typeof previewResultSchema>;
export const tryResultSchema = z.object({ run: runSchema });
export const automationResultSchema = z.object({ automation: automationSchema });
/** A version's files, read when a person opens one. */
export const filesSchema = z.object({ files: z.array(z.object({ path: z.string(), text: z.string() })) });
