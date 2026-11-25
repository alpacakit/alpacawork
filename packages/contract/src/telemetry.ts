/** Browser-safe telemetry wire, producer calculations and screen contracts. */
import { z } from 'zod';

export const TELEMETRY_ENDPOINT = 'https://alpacakit-telemetry.alpacakit.workers.dev/v1/report';
/**
 * The page explaining usage data for a screen language: docs/telemetry.md in English, the default, and
 * docs/<language>/telemetry.md for every other language the screen ships.
 */
export function telemetryDetailsUrl(language: string): string {
  return `https://github.com/alpacakit/alpacawork/blob/main/docs/${language === 'en' ? '' : `${language}/`}telemetry.md`;
}
/** The receiver's public page that deletes what was sent with a number typed into it. */
export const TELEMETRY_DELETE_URL = 'https://alpacakit-telemetry.alpacakit.workers.dev/delete';
export const TELEMETRY_CONSENT_VERSION = 3;
export const TELEMETRY_SCHEMA_VERSION = 2;
/**
 * The largest report the receiver accepts. A day's events are many small tuples (an op with each attribute's value):
 * TELEMETRY_MAX_EVENTS of the longest names fit under it with the rest of the report and room for one more attribute
 * (tests/telemetry-contract). 4096 held about 40 such events, fewer than one busy day of one person.
 */
export const TELEMETRY_MAX_REPORT_BYTES = 16_384;
/** Events one report carries at most; a busier day keeps its most frequent ones. */
export const TELEMETRY_MAX_EVENTS = 160;
/** One event's count is the day's count, capped here. */
export const TELEMETRY_MAX_COUNT = 9_999;
export const TELEMETRY_DAY_MS = 86_400_000;
/** A day's report is sent during the next day and retried until this long after the day ends. */
export const TELEMETRY_RETRY_MS = 7 * TELEMETRY_DAY_MS;

/**
 * The receiver stores names and values by their position in these lists: a list is never reordered, nothing is
 * inserted into it or removed from it; a new name or value goes at its end (tests/telemetry-contract).
 */
export const TELEMETRY_AGENTS = ['claude', 'codex', 'grok', 'agy', 'copilot', 'opencode', 'hermes', 'goose', 'qwen', 'amp', 'deepseek', 'pi', 'other'] as const;

/**
 * What people do, counted one by one where it happens. Each name is a fixed literal, so no words, title or path can
 * become one. What each name counts is noted beside it. Append only (see TELEMETRY_AGENTS).
 */
export const TELEMETRY_OPS = [
  // How a message or answer leaves: the send button, the keyboard, or a swipe on the reader's card.
  'send.button', 'send.key', 'swipe.send', 'swipe.done', 'swipe.hold', 'swipe.refused',
  // The reader's auto-swipe (named pin before it was turned around): turned on or off, and sends from the input that
  // stayed on their card (auto-swipe off).
  'pin.on', 'pin.off', 'send.pinned',
  // Every write, by what it does: on the screen at its admission, and the CLI's writes at the server.
  'w.message', 'w.sendback', 'w.continue', 'w.retry', 'w.approve', 'w.hold', 'w.unhold', 'w.body', 'w.move',
  'w.responsible', 'w.project', 'w.archive', 'w.delete', 'w.restore', 'w.stop', 'w.runStop',
  // Inputs and dialogs opened (one count where the one open dialog changes).
  'form.report', 'form.edit', 'form.responsible', 'form.move', 'open.settings', 'open.diagnostics', 'open.project',
  // The coordinator's window.
  'coord.pip', 'coord.max', 'coord.fold', 'coord.clear', 'coord.sendNow',
  // Reading and moving around.
  'tree.go', 'tree.fold', 'tree.more', 'reader.back', 'search', 'project.filter', 'strips', 'markAllRead', 'undo', 'attach', 'voice',
  'key.focus', 'key.settings', 'key.search', 'key.hold', 'pick.model', 'pick.option',
  // Outcomes outside the screen: the update it started, and the effort chosen for each Run (from the DB at sending).
  'update.ok', 'update.failed',
  // Failures the screen said (its one failure record): refused by the server, or no answer / a fault of the screen.
  'error.refused', 'error.failed',
  'effort.low', 'effort.medium', 'effort.high', 'effort.xhigh', 'effort.max', 'effort.other',
  // The CLI's own writes, which the screen does not make: a state report, a question, a comment, a new Task, a file.
  'w.report', 'w.ask', 'w.comment', 'w.task', 'w.file',
  // A failed Task continued with another AI (its draft sent), beside w.retry for the same AI.
  'w.switch',
] as const;
/** A screen's device, decided in the browser: its kind and its system, never the user agent's words or a size. */
export const TELEMETRY_DEVICE_CLASSES = ['phone', 'tablet', 'desktop'] as const;
export const TELEMETRY_DEVICE_OSES = ['ios', 'android', 'macos', 'windows', 'linux', 'chromeos', 'other'] as const;
export type TelemetryDevice = `${typeof TELEMETRY_DEVICE_CLASSES[number]}.${typeof TELEMETRY_DEVICE_OSES[number]}`;
/** An attribute's value for what happened outside a screen (a screen's device, language and theme are unknown there). */
export const TELEMETRY_NONE = '-';
/**
 * One attribute every event carries: its fixed values, and those a screen may send of itself (the rest are the
 * server's to set). Nothing that narrows down a device or a place is one: no browser or its version, no screen size,
 * no time zone, no country.
 */
export type TelemetryAttribute = { name: string; values: readonly string[]; screen: readonly string[] };
const attribute = <const Name extends string, const Values extends readonly string[], const Screen extends readonly Values[number][]>(
  name: Name, values: Values, screen: Screen) => ({ name, values, screen });
const DEVICES = [
  'phone.ios', 'phone.android', 'phone.macos', 'phone.windows', 'phone.linux', 'phone.chromeos', 'phone.other',
  'tablet.ios', 'tablet.android', 'tablet.macos', 'tablet.windows', 'tablet.linux', 'tablet.chromeos', 'tablet.other',
  'desktop.ios', 'desktop.android', 'desktop.macos', 'desktop.windows', 'desktop.linux', 'desktop.chromeos', 'desktop.other',
] as const satisfies readonly TelemetryDevice[];
/** Every kind with every system is written out above: a missing one fails the type check here. */
const everyDevice: [Exclude<TelemetryDevice, typeof DEVICES[number]>] extends [never] ? true : never = true;
void everyDevice;
/**
 * The attributes of each event, in the order an event lists their values. Adding one is one line here: the report's
 * check, the local counts, the screen's sending and the receiver's storage, aggregation and choices follow this list.
 * Attributes and each one's values are append only (see TELEMETRY_AGENTS); each value is written out, never derived,
 * so a new agent or system cannot move the values after it.
 */
export const TELEMETRY_EVENT_ATTRIBUTES = [
  // The screen's kind and system, or `-` for what the server counts.
  attribute('device', [TELEMETRY_NONE, ...DEVICES], DEVICES),
  // Who did it: a person on the screen, an agent checking the screen (`?agent=1`), the coordinator in the screen's
  // window or in an outside conversation (by agent), an AI Run (by agent), or a person at a terminal.
  attribute('via', ['screen', 'agent', 'coord.screen',
    'coord.chat.claude', 'coord.chat.codex', 'coord.chat.grok', 'coord.chat.agy', 'coord.chat.copilot', 'coord.chat.opencode', 'coord.chat.hermes',
    'coord.chat.goose', 'coord.chat.qwen', 'coord.chat.amp', 'coord.chat.deepseek', 'coord.chat.pi', 'coord.chat.other',
    'run.claude', 'run.codex', 'run.grok', 'run.agy', 'run.copilot', 'run.opencode', 'run.hermes',
    'run.goose', 'run.qwen', 'run.amp', 'run.deepseek', 'run.pi', 'run.other',
    'cli', 'coord.chat.mcp'], ['screen', 'agent']),
  // The screen's language, and the theme chosen in its settings (`system` follows the OS).
  attribute('lang', [TELEMETRY_NONE, 'ja', 'en', 'other'], ['ja', 'en', 'other']),
  attribute('theme', [TELEMETRY_NONE, 'light', 'dark', 'system'], ['light', 'dark', 'system']),
] as const satisfies readonly TelemetryAttribute[];
type EventAttributes = typeof TELEMETRY_EVENT_ATTRIBUTES;
export type TelemetryAttributeName = EventAttributes[number]['name'];
/** An event's attribute values, by name. */
export type TelemetryAttributeValues = { [A in EventAttributes[number] as A['name']]: A['values'][number] };
/** The attribute values a screen sends of itself. */
export type TelemetryScreenAttributes = { [A in EventAttributes[number] as A['name']]: A['screen'][number] };
export type TelemetryVia = TelemetryAttributeValues['via'];
/**
 * Sizes counted when the report is made: projects, tasks, the tree's depth and width, long threads, and the most AI
 * Runs that ran at once on the reported day. Append only (see TELEMETRY_AGENTS).
 */
export const TELEMETRY_SHAPES = ['projects', 'tasks', 'open', 'depth', 'children', 'top', 'turns', 'talk', 'parallel'] as const;
/** How long the screen took: `open` from loading the page to its list, `task` from opening a task to its content. Names have no `.`. */
export const TELEMETRY_TIMES = ['open', 'task'] as const;
export const TELEMETRY_TIME_BUCKETS = ['<0.25s', '0.25-0.5s', '0.5-1s', '1-2s', '2-5s', '5-10s', '10s+'] as const;
export const TELEMETRY_SIZE_BUCKETS = ['0', '1', '2', '3-4', '5-9', '10-19', '20-49', '50-99', '100+'] as const;
/** Append only (see TELEMETRY_AGENTS). */
export const TELEMETRY_FAILURES = ['exit', 'output', 'timeout', 'launch', 'conversation_busy', 'attachment_save', 'manager_lost'] as const;
export const TELEMETRY_COUNT_BUCKETS = ['0', '1-5', '6-20', '21-100', '101+'] as const;

export type TelemetryOp = typeof TELEMETRY_OPS[number];
export type TelemetryShape = typeof TELEMETRY_SHAPES[number];
export type TelemetryTime = typeof TELEMETRY_TIMES[number];
export type TimeBucket = typeof TELEMETRY_TIME_BUCKETS[number];
export type SizeBucket = typeof TELEMETRY_SIZE_BUCKETS[number];
export type TelemetryFailure = typeof TELEMETRY_FAILURES[number];
export type TelemetryAgent = typeof TELEMETRY_AGENTS[number];
export type CountBucket = typeof TELEMETRY_COUNT_BUCKETS[number];
export type TelemetryDay = string;

function timeValue(time: number | string | Date): number {
  const value = typeof time === 'number' ? time : time instanceof Date ? time.getTime() : Date.parse(time);
  if (!Number.isFinite(value)) throw new RangeError('Invalid telemetry time');
  return value;
}

/** The UTC day of a time, as `YYYY-MM-DD`. */
export function utcDay(time: number | string | Date): TelemetryDay {
  const value = timeValue(time);
  if (value < Date.UTC(1, 0, 1) || value >= Date.UTC(10000, 0, 1)) throw new RangeError('Unsupported telemetry year');
  return new Date(value).toISOString().slice(0, 10);
}

/** Half-open interval [start, end) of a UTC day, both expressed as Unix milliseconds. */
export function dayRange(day: TelemetryDay): { start: number; end: number } {
  if (!/^\d{4}-\d{2}-\d{2}$(?![\s\S])/u.test(day)) throw new RangeError('Invalid telemetry day');
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start) || utcDay(start) !== day) throw new RangeError('Invalid telemetry day');
  return { start, end: start + TELEMETRY_DAY_MS };
}

/** A day's report is no longer sent (nor accepted) from this time. */
export function deadline(day: TelemetryDay): number {
  return dayRange(day).end + TELEMETRY_RETRY_MS;
}

function naturalNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Expected a nonnegative safe integer');
}

export function countBucket(count: number): CountBucket {
  naturalNumber(count);
  return count === 0 ? '0' : count <= 5 ? '1-5' : count <= 20 ? '6-20' : count <= 100 ? '21-100' : '101+';
}

/** Finer at the small end, where a screen's limits (depth 3 or 4, a handful of uses) are decided. */
export function sizeBucket(count: number): SizeBucket {
  naturalNumber(count);
  return count <= 2 ? String(count) as SizeBucket : count <= 4 ? '3-4' : count <= 9 ? '5-9' : count <= 19 ? '10-19'
    : count <= 49 ? '20-49' : count <= 99 ? '50-99' : '100+';
}

const TIME_LIMITS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000];
/** Index into TELEMETRY_TIME_BUCKETS of a duration in milliseconds. */
export function timeBucketIndex(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Expected a nonnegative duration');
  const at = TIME_LIMITS_MS.findIndex(limit => ms < limit);
  return at === -1 ? TIME_LIMITS_MS.length : at;
}

export const telemetryDaySchema = z.string().refine(day => {
  try { dayRange(day); return true; } catch { return false; }
}, 'Expected a real UTC day');
export const telemetryCountBucketSchema = z.enum(TELEMETRY_COUNT_BUCKETS);
export const telemetryOpSchema = z.enum(TELEMETRY_OPS);
export const telemetrySizeBucketSchema = z.enum(TELEMETRY_SIZE_BUCKETS);
export const telemetryTimeSchema = z.enum(TELEMETRY_TIMES);
export const telemetryTimeBucketSchema = z.enum(TELEMETRY_TIME_BUCKETS);
export const telemetryFailureSchema = z.enum(TELEMETRY_FAILURES);
export const telemetryAgentSchema = z.enum(TELEMETRY_AGENTS);
/** This PC's reporting number: random, made when sending is chosen, never from the PC or the person. */
export const telemetryIdSchema = z.uuidv4();

/** One event: what was done, how often that day, then each attribute's value in the list's order. */
export function telemetryEventSchemaOf(attributes: readonly TelemetryAttribute[]) {
  return z.tuple([telemetryOpSchema, z.number().int().min(1).max(TELEMETRY_MAX_COUNT)],
    z.string()).superRefine((event, context) => {
    const values = event.slice(2) as string[];
    if (values.length !== attributes.length) context.addIssue({ code: 'custom', message: 'Expected one value per attribute' });
    else attributes.forEach((attribute, at) => {
      if (!attribute.values.includes(values[at]!)) context.addIssue({ code: 'custom', path: [at + 2], message: `Unknown ${attribute.name}` });
    });
  });
}
/** The events of one report: bounded, each combination of op and attribute values once. */
export function telemetryEventsSchemaOf(attributes: readonly TelemetryAttribute[]) {
  return z.array(telemetryEventSchemaOf(attributes)).max(TELEMETRY_MAX_EVENTS)
    .refine(events => new Set(events.map(([op, , ...values]) => [op, ...values].join(' '))).size === events.length, 'Expected each event once');
}
export type TelemetryEvent = [TelemetryOp, number, ...string[]];
/** The key of one combination: the op, then each attribute's value in the list's order (no name has a space). */
export const telemetryEventKey = (op: TelemetryOp, values: Partial<Record<string, string>>, attributes: readonly TelemetryAttribute[] = TELEMETRY_EVENT_ATTRIBUTES): string =>
  [op, ...attributes.map(attribute => values[attribute.name] ?? TELEMETRY_NONE)].join(' ');
/** A key and its count as an event. */
export function telemetryEventOf(key: string, count: number): TelemetryEvent {
  const [op, ...values] = key.split(' ');
  return [op as TelemetryOp, count, ...values];
}
/** What a screen sends of one use: the op, and its own attributes, each from its `screen` values. */
export function telemetryScreenUseSchemaOf(attributes: readonly TelemetryAttribute[]) {
  return z.object({ op: telemetryOpSchema, attributes: z.object(Object.fromEntries(attributes.map(attribute =>
    [attribute.name, z.enum(attribute.screen as [string, ...string[]])]))).strict() }).strict();
}

/** The attributes of each report: the PC as a whole, the same for every event of the day. */
export const TELEMETRY_REPORT_ATTRIBUTES = {
  // Intake additionally checks this against the published package's real versions.
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$(?![\s\S])/u),
  os: z.enum(['linux', 'darwin', 'wsl']),
  arch: z.enum(['x64', 'arm64']),
  node: z.number().int().min(24).max(40),
};
export const dayReportSchema = z.object({
  schema: z.literal(TELEMETRY_SCHEMA_VERSION),
  id: telemetryIdSchema,
  day: telemetryDaySchema,
  ...TELEMETRY_REPORT_ATTRIBUTES,
  events: telemetryEventsSchemaOf(TELEMETRY_EVENT_ATTRIBUTES),
  failures: z.partialRecord(telemetryFailureSchema, z.enum(['1-5', '6-20', '21-100', '101+'])),
  shape: z.record(z.enum(TELEMETRY_SHAPES), telemetrySizeBucketSchema),
  // Per measured time: the typical (median) and the slowest of the day.
  times: z.partialRecord(telemetryTimeSchema, z.tuple([telemetryTimeBucketSchema, telemetryTimeBucketSchema])),
  agents: z.array(telemetryAgentSchema).max(TELEMETRY_AGENTS.length).refine(values => new Set(values).size === values.length, 'Expected a subset'),
}).strict();
export const telemetryReportSchema = dayReportSchema;
export type DayReport = z.infer<typeof dayReportSchema>;
export type TelemetryReport = DayReport;

/** Screen response contracts; eligibility is decided by the backend's telemetryGate alone. */
export const telemetryBlockedBySchema = z.enum(['env', 'test', 'container', 'fixture', 'source', 'edition', 'invalid_state', 'clock']);
export const telemetryStatusSchema = z.object({
  state: z.enum(['blocked', 'not_asked', 'needs_reask', 'off', 'on']),
  blockedBy: telemetryBlockedBySchema.nullable(),
  digest: z.string().nullable(),
  /** The number reports carry; kept after sending stops, so what was sent can still be deleted. */
  id: telemetryIdSchema.nullable(),
});
export type TelemetryStatus = z.infer<typeof telemetryStatusSchema>;
export const telemetryPreviewSchema = z.object({ state: telemetryStatusSchema.shape.state, next: dayReportSchema.nullable() });

const telemetryAttemptFields = {
  at: z.iso.datetime(),
  url: z.url(),
  outcome: z.enum(['unknown', 'accepted', 'rejected', 'retry']),
  status: z.number().int().min(100).max(599).optional(),
};
export const telemetryAttemptSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...telemetryAttemptFields, kind: z.literal('report'), day: telemetryDaySchema.optional(), method: z.literal('POST'), body: z.string() }),
  z.strictObject({ ...telemetryAttemptFields, kind: z.literal('delete'), method: z.literal('DELETE') }),
]);
export type TelemetryAttempt = z.infer<typeof telemetryAttemptSchema>;

export const telemetryHistorySchema = telemetryPreviewSchema.extend({
  queue: z.array(z.strictObject({ day: telemetryDaySchema, notBefore: z.number().finite(), report: dayReportSchema })),
  log: z.array(telemetryAttemptSchema),
});
export type TelemetryHistory = z.infer<typeof telemetryHistorySchema>;
