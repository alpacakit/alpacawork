import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countBucket, dayRange, deadline, sizeBucket, telemetryEventKey, telemetryEventOf, telemetryEventSchemaOf, telemetryEventsSchemaOf,
  telemetryScreenUseSchemaOf, timeBucketIndex, utcDay, telemetryDetailsUrl, TELEMETRY_AGENTS, TELEMETRY_CONSENT_VERSION, TELEMETRY_DAY_MS,
  TELEMETRY_EVENT_ATTRIBUTES, TELEMETRY_FAILURES, TELEMETRY_MAX_COUNT, TELEMETRY_MAX_EVENTS, TELEMETRY_MAX_REPORT_BYTES, TELEMETRY_OPS, TELEMETRY_SHAPES,
  TELEMETRY_TIMES, TELEMETRY_FIELDS, dayReportSchema, telemetryReportSchema, type DayReport, type TelemetryAttribute, type TelemetryEvent } from '@alpacawork/contract/telemetry';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const report: DayReport = {
  schema: 2, id: '3f2b9c4e-8a1d-4f6b-9c2e-7d5a1b3c9e01', day: '2026-11-03', version: '0.3.0', os: 'linux', arch: 'x64', node: 24,
  events: [['search', 1, 'phone.ios', 'screen', 'ja', 'dark'], ['w.message', 3, '-', 'run.codex', '-', '-']],
  failures: {}, shape: { projects: '2', tasks: '20-49', open: '5-9', depth: '3-4', children: '5-9', top: '10-19', turns: '20-49', talk: '100+', parallel: '3-4' },
  times: { open: ['0.5-1s', '2-5s'] }, agents: ['codex'],
};

test('UTC days keep real calendar boundaries; a day is sent until seven days after it ends', () => {
  for (const [time, expected] of [['2026-11-03T23:59:59.999Z', '2026-11-03'], ['2026-11-04T00:00:00Z', '2026-11-04'],
    ['2028-02-29T12:00:00Z', '2028-02-29'], ['2026-12-31T23:59:59.999Z', '2026-12-31']]) assert.equal(utcDay(time!), expected);
  assert.deepEqual(dayRange('2026-12-31'), { start: Date.parse('2026-12-31T00:00:00Z'), end: Date.parse('2027-01-01T00:00:00Z') });
  assert.equal(deadline('2026-12-31'), Date.parse('2027-01-08T00:00:00Z'));
  for (const invalid of ['2026-02-29', '2026-13-01', '2026-11-3', '2026-11-03\n', '20261103']) {
    assert.throws(() => dayRange(invalid), RangeError);
    assert.equal(telemetryReportSchema.safeParse({ ...report, day: invalid }).success, false);
  }
  assert.throws(() => utcDay('invalid'), RangeError);
  assert.equal(dayRange('2026-11-03').end - dayRange('2026-11-03').start, TELEMETRY_DAY_MS);
});

test('counts are reduced at every bucket boundary', () => {
  assert.deepEqual([0, 1, 5, 6, 20, 21, 100, 101].map(countBucket), ['0', '1-5', '1-5', '6-20', '6-20', '21-100', '21-100', '101+']);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9, 10, 19, 20, 49, 50, 99, 100].map(sizeBucket),
    ['0', '1', '2', '3-4', '3-4', '5-9', '5-9', '10-19', '10-19', '20-49', '20-49', '50-99', '50-99', '100+']);
  for (const invalid of [-1, 0.5, Infinity, NaN]) { assert.throws(() => countBucket(invalid), RangeError); assert.throws(() => sizeBucket(invalid), RangeError); }
  assert.deepEqual([0, 249, 250, 499, 500, 999, 1000, 1999, 2000, 4999, 5000, 9999, 10000, 60000].map(timeBucketIndex), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  for (const invalid of [-1, Infinity, NaN]) assert.throws(() => timeBucketIndex(invalid), RangeError);
});

test('only bounded reports and fixed names cross the telemetry boundary: no free text identifies a device or a person', () => {
  assert.deepEqual(telemetryReportSchema.parse(report), report);
  const event = report.events[0]!;
  for (const invalid of [
    { hostname: 'private' }, { id: '0123456789abcdef0123456789abcdef' }, { id: '3f2b9c4e-8a1d-1f6b-9c2e-7d5a1b3c9e01' }, { id: `${report.id}\n` },
    { os: 'windows' }, { arch: 'unknown' }, { node: 23 }, { node: 41 }, { version: '0.3.0\n' }, { schema: 1 },
    // Earlier report fields are gone: no week, no kind, no k or days.
    { week: '2026-W45' }, { kind: 'week' }, { k: 0 }, { days: 1 }, { userAgent: 'Mozilla/5.0' },
    { failures: { exit: '0' } }, { failures: { privateAgent: '1-5' } }, { agents: ['privateAgent'] },
    { shape: { ...report.shape, depth: 3 } }, { shape: { ...report.shape, title: '1' } }, { shape: { projects: '1' } },
    { times: { open: ['1-2s'] } }, { times: { open: [1200, 3000] } },
    // Each event is an op, a count and one fixed value per attribute in the list's order: never words, a size or a user agent.
    { events: [['my project', 1, ...event.slice(2)]] }, { events: [[event[0], 0, ...event.slice(2)]] },
    { events: [[event[0], TELEMETRY_MAX_COUNT + 1, ...event.slice(2)]] }, { events: [[event[0], 1.5, ...event.slice(2)]] },
    { events: [[event[0], 1, 'Mozilla/5.0 (iPhone)', 'screen', 'ja', 'dark']] }, { events: [[event[0], 1, 'phone.ios', 'screen', 'ja-JP', 'dark']] },
    { events: [[event[0], 1, '1170x2532', 'screen', 'ja', 'dark']] }, { events: [[event[0], 1, 'phone.ios', 'screen', 'ja']] },
    { events: [[...event, 'Asia/Tokyo']] }, { events: [event, [event[0], 2, ...event.slice(2)]] },
    { events: Array.from({ length: TELEMETRY_MAX_EVENTS + 1 }, (_, i) => [TELEMETRY_OPS[i % TELEMETRY_OPS.length], 1, 'desktop.linux', ['screen', 'agent', 'cli', 'coord.screen'][Math.floor(i / TELEMETRY_OPS.length)], 'ja', 'dark']) },
  ]) assert.equal(telemetryReportSchema.safeParse({ ...report, ...invalid }).success, false, JSON.stringify(invalid));
});

/**
 * What the person was asked about: the report's fields and each event's attributes, under the consent version that
 * asked. A new field or attribute is a new kind of data, so it is asked again (docs/telemetry.md): raise
 * TELEMETRY_CONSENT_VERSION, describe it on that page in every language, and change this record with them. A new name
 * or value in an existing list is not asked again.
 */
const ASKED = { consent: 3, fields: ['schema', 'id', 'day', 'version', 'os', 'arch', 'node', 'events', 'failures', 'shape', 'times', 'agents'],
  attributes: ['device', 'via', 'lang', 'theme'] };
test('a field added to the report cannot carry words or a raw number, and is asked about again', () => {
  assert.deepEqual({ consent: TELEMETRY_CONSENT_VERSION, fields: Object.keys(dayReportSchema.shape), attributes: TELEMETRY_EVENT_ATTRIBUTES.map(attribute => attribute.name) }, ASKED);
  // A report with every field and every name filled; an optional field must be here to be tried below.
  const fullest: DayReport = { ...report, failures: Object.fromEntries(TELEMETRY_FAILURES.map(failure => [failure, '1-5'])),
    times: Object.fromEntries(TELEMETRY_TIMES.map(time => [time, ['1-2s', '2-5s']])) };
  assert.deepEqual(Object.keys(fullest).sort(), [...ASKED.fields].sort());
  assert.ok(telemetryReportSchema.safeParse(fullest).success);
  // Every place of it in turn: its value as words or as a number never bucketed, one more key, one more item.
  const words = 'my project', raw = 123_456_789;
  const changed = (value: unknown): unknown[] => Array.isArray(value)
    ? [[...value, words], ...value.flatMap((item, at) => changed(item).map(other => value.map((kept, place) => place === at ? other : kept)))]
    : value !== null && typeof value === 'object'
      ? [{ ...value, [words]: Object.values(value)[0] }, ...Object.entries(value).flatMap(([key, item]) => changed(item).map(other => ({ ...value, [key]: other })))]
      : [words, raw];
  for (const other of changed(fullest)) assert.equal(telemetryReportSchema.safeParse(other).success, false, JSON.stringify(other));
});

test('an attribute is one line in the list: events, local keys and what a screen sends all follow it', () => {
  const extra: readonly TelemetryAttribute[] = [...TELEMETRY_EVENT_ATTRIBUTES, { name: 'input', values: ['-', 'touch', 'mouse'], screen: ['touch', 'mouse'] }];
  const event = schemaEvent(extra);
  assert.ok(telemetryEventSchemaOf(extra).safeParse(event).success);
  assert.equal(telemetryEventSchemaOf(extra).safeParse(event.slice(0, -1)).success, false);
  assert.equal(telemetryEventSchemaOf(extra).safeParse([...event.slice(0, -1), 'pen']).success, false);
  assert.equal(telemetryEventsSchemaOf(extra).safeParse([event, event]).success, false);
  // A local key and the event it becomes keep the list's order; attributes a server event leaves out are `-`.
  const key = telemetryEventKey('search', { via: 'cli', input: 'touch' }, extra);
  assert.deepEqual(telemetryEventOf(key, 2), ['search', 2, '-', 'cli', '-', '-', 'touch']);
  assert.ok(telemetryEventSchemaOf(extra).safeParse(telemetryEventOf(key, 2)).success);
  const screen = telemetryScreenUseSchemaOf(extra);
  const attributes = { device: 'phone.ios', via: 'agent', lang: 'en', theme: 'system', input: 'mouse' };
  assert.ok(screen.safeParse({ op: 'search', attributes }).success);
  for (const wrong of [{ ...attributes, input: undefined }, { ...attributes, via: 'cli' }, { ...attributes, device: '-' }, { ...attributes, extra: 'x' }])
    assert.equal(screen.safeParse({ op: 'search', attributes: wrong }).success, false, JSON.stringify(wrong));
  // Each attribute's screen values are among its values; only what the server sets is left to it.
  for (const attribute of TELEMETRY_EVENT_ATTRIBUTES) assert.ok(attribute.screen.every(value => (attribute.values as readonly string[]).includes(value)), attribute.name);
});
/** One event with every attribute's first screen value. */
function schemaEvent(attributes: readonly TelemetryAttribute[]): TelemetryEvent {
  return ['search', 1, ...attributes.map(attribute => attribute.screen[0]!)];
}

/** The longest names everywhere, as many distinct events as a report carries, each at the highest count, every key filled. */
function largestReport(): DayReport {
  const longest = <T extends string>(values: readonly T[], n: number) => [...values].sort((a, b) => b.length - a.length).slice(0, n);
  const combinations: TelemetryEvent[] = [];
  for (const op of longest(TELEMETRY_OPS, 8)) for (const device of longest(TELEMETRY_EVENT_ATTRIBUTES[0].values, 6))
    for (const via of longest(TELEMETRY_EVENT_ATTRIBUTES[1].values, 6))
      combinations.push([op, TELEMETRY_MAX_COUNT, device, via, ...TELEMETRY_EVENT_ATTRIBUTES.slice(2).map(attribute => longest(attribute.values, 1)[0]!)]);
  const events = combinations.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length).slice(0, TELEMETRY_MAX_EVENTS);
  return { ...report, os: 'darwin', arch: 'arm64', version: '10000.10000.10000-rc.10000', events,
    failures: Object.fromEntries(TELEMETRY_FAILURES.map(failure => [failure, '21-100'])),
    shape: Object.fromEntries(TELEMETRY_SHAPES.map(name => [name, '10-19'])) as DayReport['shape'],
    times: Object.fromEntries(TELEMETRY_TIMES.map(time => [time, ['0.25-0.5s', '0.25-0.5s']])), agents: [...TELEMETRY_AGENTS] };
}

test('the largest possible report still fits the size the receiver accepts', () => {
  const largest = largestReport();
  assert.equal(largest.events.length, TELEMETRY_MAX_EVENTS);
  assert.ok(telemetryReportSchema.safeParse(largest).success);
  assert.ok(Buffer.byteLength(JSON.stringify(largest)) <= TELEMETRY_MAX_REPORT_BYTES, String(Buffer.byteLength(JSON.stringify(largest))));
});

// A consent covers TELEMETRY_FIELDS; a report must not carry a kind of information outside it, or it would be sent
// without asking again.
test('every key and every named value a report carries is a field that consent covers', () => {
  const carried = Object.entries(largestReport()).flatMap(([key, value]) => [key,
    ...(key === 'events' ? TELEMETRY_EVENT_ATTRIBUTES.map(({ name }) => `events.${name}`)
      : value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).map(name => `${key}.${name}`) : [])]);
  assert.deepEqual(carried.filter(field => !TELEMETRY_FIELDS.includes(field)), []);
  assert.deepEqual(Object.keys(dayReportSchema.shape).filter(key => !carried.includes(key)), []);
});

/**
 * The lists as the second report form began: the receiver stores names and values by position, so each list keeps this
 * as its start and only grows at its end.
 */
const FIRST = {
  ops: ['send.button', 'send.key', 'swipe.send', 'swipe.done', 'swipe.hold', 'swipe.refused', 'pin.on', 'pin.off', 'send.pinned',
    'w.message', 'w.sendback', 'w.continue', 'w.retry', 'w.approve', 'w.hold', 'w.unhold', 'w.body', 'w.move', 'w.responsible', 'w.project',
    'w.archive', 'w.delete', 'w.restore', 'w.stop', 'w.runStop', 'form.report', 'form.edit', 'form.responsible', 'form.move', 'open.settings',
    'open.diagnostics', 'open.project', 'coord.pip', 'coord.max', 'coord.fold', 'coord.clear', 'coord.sendNow', 'tree.go', 'tree.fold',
    'tree.more', 'reader.back', 'search', 'project.filter', 'strips', 'markAllRead', 'undo', 'attach', 'voice', 'key.focus', 'key.settings',
    'key.search', 'key.hold', 'pick.model', 'pick.option', 'update.ok', 'update.failed', 'error.refused', 'error.failed', 'effort.low',
    'effort.medium', 'effort.high', 'effort.xhigh', 'effort.max', 'effort.other', 'w.report', 'w.ask', 'w.comment', 'w.task', 'w.file'],
  attributes: ['device', 'via', 'lang', 'theme'],
  device: ['-', ...['phone', 'tablet', 'desktop'].flatMap(kind => ['ios', 'android', 'macos', 'windows', 'linux', 'chromeos', 'other'].map(os => `${kind}.${os}`))],
  via: ['screen', 'agent', 'coord.screen', ...['coord.chat.', 'run.'].flatMap(prefix =>
    ['claude', 'codex', 'grok', 'agy', 'copilot', 'opencode', 'hermes', 'goose', 'qwen', 'amp', 'deepseek', 'pi', 'other'].map(agent => prefix + agent)), 'cli'],
  lang: ['-', 'ja', 'en', 'other'],
  theme: ['-', 'light', 'dark', 'system'],
  agents: ['claude', 'codex', 'grok', 'agy', 'copilot', 'opencode', 'hermes', 'goose', 'qwen', 'amp', 'deepseek', 'pi', 'other'],
  failures: ['exit', 'output', 'timeout', 'launch', 'conversation_busy', 'attachment_save', 'manager_lost'],
  shapes: ['projects', 'tasks', 'open', 'depth', 'children', 'top', 'turns', 'talk', 'parallel'],
};
test('names and values keep their positions: each list only grows at its end', () => {
  const starts = (list: readonly string[], first: readonly string[], name: string) => assert.deepEqual(list.slice(0, first.length), first, name);
  starts(TELEMETRY_OPS, FIRST.ops, 'ops');
  starts(TELEMETRY_EVENT_ATTRIBUTES.map(attribute => attribute.name), FIRST.attributes, 'attributes');
  for (const attribute of TELEMETRY_EVENT_ATTRIBUTES.slice(0, FIRST.attributes.length))
    starts(attribute.values, FIRST[attribute.name as 'device' | 'via' | 'lang' | 'theme'], attribute.name);
  starts(TELEMETRY_AGENTS, FIRST.agents, 'agents');
  starts(TELEMETRY_FAILURES, FIRST.failures, 'failures');
  starts(TELEMETRY_SHAPES, FIRST.shapes, 'shapes');
});

test('the consent details link opens the page in the screen language, English by default', () => {
  const repository = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  for (const language of readdirSync(new URL('../packages/i18n/src/locales/', import.meta.url))) {
    const page = language === 'en' ? 'telemetry.md' : `${language}/telemetry.md`;
    assert.equal(telemetryDetailsUrl(language), `${repository}/blob/main/docs/${page}`);
    assert.ok(existsSync(new URL(`../docs/${page}`, import.meta.url)), page);
  }
});
