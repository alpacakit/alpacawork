/** Rules, not UI: every write uses an isolated synthetic state directory. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { stringify } from 'yaml';
import { openControlDatabase } from '@alpacawork/db';
import { defaultAgentSetting } from '@alpacawork/contract';
import { PROBLEM_CODE } from '@alpacawork/core';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { telemetryGate, type GateFacts, type Consent } from '../apps/backend/test-dist/telemetry/consent.js';
import { TelemetryService } from '../apps/backend/test-dist/telemetry/service.js';
import { retryAt } from '../apps/backend/test-dist/telemetry/queue.js';
import { installTelemetryRoutes } from '../apps/backend/test-dist/telemetry/routes.js';
import { boundedEvents, buildDayReport, reportFromWorkspace, type Envelope } from '../apps/backend/test-dist/telemetry/report.js';
import { emptyMarks } from '../apps/backend/test-dist/telemetry/marks.js';
import { callerVia, countCliWrites, countedCommand, writeOp } from '../apps/backend/test-dist/telemetry/server-writes.js';
import { Hono } from '../apps/backend/node_modules/hono/dist/index.js';
import { commandCatalog } from '@alpacawork/contract/commands';
import { writeJson } from '../apps/backend/test-dist/telemetry/files.js';
import { dayRange, deadline, sizeBucket, telemetryEventKey, TELEMETRY_CONSENT_VERSION, TELEMETRY_DAY_MS, TELEMETRY_ENDPOINT,
  telemetryHistorySchema, TELEMETRY_EVENT_ATTRIBUTES, TELEMETRY_MAX_COUNT, TELEMETRY_MAX_EVENTS, TELEMETRY_OPS,
  TELEMETRY_FIELDS, type TelemetryAttempt } from '@alpacawork/contract/telemetry';

const at = Date.parse('2026-11-03T12:00:00.000Z'), day = '2026-11-03';
const ID = '3f2b9c4e-8a1d-4f6b-9c2e-7d5a1b3c9e01';
const consent: Consent = { version: 1, choice: 'on', consentVersion: TELEMETRY_CONSENT_VERSION, decidedAt: new Date(at).toISOString(), decidedBy: 'screen', id: ID,
  fields: [...TELEMETRY_FIELDS] };
const facts: GateFacts = { env: {}, source: false, edition: 'production', container: false, fixture: false, now: at, consent };
// Each runtime fact that blocks sending even when the PC chose to send.
const blockedPatches: Partial<GateFacts>[] = [{ env: { DO_NOT_TRACK: '1' } }, { env: { CI: '1' } }, { env: { NODE_TEST_CONTEXT: '' } }, { container: true },
  { fixture: true }, { source: true }, { edition: 'diagnostic' }, { latestDay: '2026-11-09' }];
const envelope: Envelope = { schema: 2, id: ID, day, version: '0.3.0', os: 'linux', arch: 'x64', node: 24 };
const makeEnvelope = (reported: string, id: string): Envelope => ({ ...envelope, day: reported, id });
const report = { ...envelope, events: [], failures: {}, shape: { projects: '1', tasks: '1', open: '1', depth: '1', children: '0', top: '1', turns: '1', talk: '0', parallel: '0' }, times: {}, agents: [] } as const;
function isolated(t: TestContext) { const root = mkdtempSync(join(tmpdir(), 'telemetry-rules-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function workspace(t: TestContext, seed: string) {
  const root = mkdtempSync(join(tmpdir(), 'telemetry-ws-')), original = createOriginal({ tasks: 14, logs: 19, runs: 7, seed }, join(root, 'cache'));
  const copy = copyWorkspace(original.root, join(root, 'copy'));
  t.after(() => { removeWorkspace(copy.root); removeWorkspace(original.root); rmSync(root, { recursive: true, force: true }); });
  return { root, copy: copy.root };
}
const service = (root: string | undefined, paths: { consent: string; state: string }, now: () => number, fetch?: typeof globalThis.fetch, patch: Partial<GateFacts> = {}) =>
  new TelemetryService(root, {}, { paths, now, facts: (c, time, latestDay) => ({ ...facts, consent: c, now: time, latestDay, ...patch }), envelope: makeEnvelope, fetch });

test('one eligibility table covers environment, consent, runtime, and backwards/future clocks', () => {
  for (const key of ['ALPACAWORK_TELEMETRY_DISABLED', 'DO_NOT_TRACK', 'CI']) {
    for (const value of ['1', 'true']) assert.equal(telemetryGate({ ...facts, env: { [key]: value } }).blockedBy, 'env');
    for (const value of ['', '0', 'false']) assert.equal(telemetryGate({ ...facts, env: { [key]: value } }).state, 'on');
  }
  for (const key of ['NODE_TEST_CONTEXT', 'VITEST', 'PLAYWRIGHT_TEST']) assert.equal(telemetryGate({ ...facts, env: { [key]: '' } }).blockedBy, 'test');
  for (const [patch, reason] of [[{ container: true }, 'container'], [{ env: { container: '' } }, 'container'], [{ fixture: true }, 'fixture'], [{ source: true }, 'source'], [{ edition: 'diagnostic' }, 'edition'], [{ latestDay: '2026-11-04' }, 'clock'], [{ now: at - 1 }, 'clock']] as const)
    assert.equal(telemetryGate({ ...facts, ...patch }).blockedBy, reason);
  assert.equal(telemetryGate({ ...facts, latestDay: day }).state, 'on');
  assert.equal(telemetryGate({ ...facts, consent: null }).state, 'not_asked');
  assert.equal(telemetryGate({ ...facts, consent: { ...consent, decidedBy: 'cli' } }).state, 'not_asked');
  assert.equal(telemetryGate({ ...facts, consent: { ...consent, consentVersion: TELEMETRY_CONSENT_VERSION - 1 } }).state, 'needs_reask');
  // A kind of information added to reports since the choice asks again, with no version to raise by hand.
  assert.equal(telemetryGate({ ...facts, consent: { ...consent, fields: TELEMETRY_FIELDS.slice(0, -1) } }).state, 'needs_reask');
  assert.equal(telemetryGate({ ...facts, consent: { ...consent, fields: undefined } }).state, 'needs_reask');
  // Chosen before reports carried a number: asked again, never sent without one.
  const { id: _, ...numberless } = consent;
  assert.equal(telemetryGate({ ...facts, consent: numberless }).state, 'needs_reask');
  assert.equal(telemetryGate({ ...facts, consent: { ...consent, choice: 'off' } }).state, 'off');
  assert.equal(telemetryGate(facts).state, 'on');
});

test('the number is a random UUID made once when sending is first chosen, kept through stopping and choosing again', t => {
  const root = isolated(t), paths = { consent: join(root, 'config/telemetry.json'), state: join(root, 'state') };
  let now = at;
  const telemetry = service(undefined, paths, () => now);
  telemetry.choose('off', 'screen'); assert.equal(telemetry.status().id, null);
  telemetry.choose('on', 'screen');
  const id = telemetry.status().id!;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  now++; telemetry.choose('off', 'screen'); assert.equal(telemetry.status().id, id);
  now++; telemetry.choose('on', 'screen'); assert.equal(telemetry.status().id, id);
  // A consent saved before numbers (an earlier version's keys included) is asked again and then numbered.
  writeJson(paths.consent, { version: 1, choice: 'on', consentVersion: 2, decidedAt: new Date(at).toISOString(), decidedBy: 'screen', startWeek: '2026-W45' });
  assert.equal(telemetry.status().state, 'needs_reask');
  telemetry.choose('on', 'screen', telemetry.status().digest!);
  assert.equal(telemetry.status().state, 'on'); assert.notEqual(telemetry.status().id, null);
  const stale = telemetry.status().digest!; telemetry.choose('off', 'cli');
  assert.throws(() => telemetry.choose('on', 'screen', stale), {
    code: PROBLEM_CODE.conflict, message: /changed/, reason: { kind: 'telemetry_consent_changed' },
  });
});

test('the screen can read every request before transport, including retries and a lost response', async t => {
  const root = isolated(t), paths = { consent: join(root, 'consent.json'), state: join(root, 'state') };
  const app = new Hono();
  const history = async () => {
    const response = await app.request('/api/telemetry/history');
    assert.equal(response.status, 200);
    return telemetryHistorySchema.parse(await response.json());
  };
  let now = at, status: number | undefined = 503;
  const requests: { request: Request; recorded: TelemetryAttempt | undefined }[] = [];
  const telemetry = service(undefined, paths, () => now, async (url, init) => {
    requests.push({ request: new Request(url, init), recorded: (await history()).log[0] });
    if (status === undefined) throw new Error('Response lost');
    return new Response(null, { status, headers: { 'retry-after': '7200' } });
  });
  installTelemetryRoutes(app, telemetry, () => {});
  writeJson(paths.consent, consent);
  const { queue } = telemetry;
  assert.equal(queue.enqueue(report, at), true);
  assert.equal(queue.enqueue({ ...report, version: '0.4.0' }, at), false);
  assert.deepEqual((await history()).queue, [{ day, notBefore: at, report }]);

  await telemetry.send();
  assert.equal(queue.queued()[0]!.value.nextAttempt, at + 7_200_000);
  now += 7_200_000;
  status = undefined;
  await telemetry.send();
  assert.equal(queue.queued()[0]!.value.nextAttempt, now + 10_800_000);
  status = 202;
  await telemetry.send();
  assert.equal(requests.length, 2);
  now += 10_800_000;
  await telemetry.send();
  assert.equal(queue.queued().length, 0);
  assert.equal(queue.has(day), true);
  assert.equal(telemetry.status().lastSentAt, new Date(now).toISOString());

  // A restart after recording the response can find the old queue file still present.
  writeJson(join(paths.state, 'queue', 'day-' + day + '.json'), { report, notBefore: at, nextAttempt: at, createdAt: at, attempts: 0 });
  assert.deepEqual((await history()).queue, []);
  await telemetry.send();
  assert.equal(requests.length, 3);
  assert.equal(queue.queued().length, 0);

  now += TELEMETRY_DAY_MS;
  assert.equal(queue.enqueue({ ...report, day: '2026-11-04' }, now), true);
  status = 400;
  await telemetry.send();
  assert.equal(queue.queued().length, 0);
  now++;
  status = 204;
  await telemetry.deleteSent();
  telemetry.choose('off', 'screen');

  const { log, state } = await history();
  assert.equal(state, 'off');
  assert.deepEqual(telemetry.show().log, log);
  assert.deepEqual(log.map(attempt => [attempt.outcome, attempt.status]), [
    ['accepted', 204], ['rejected', 400], ['accepted', 202], ['unknown', undefined], ['retry', 503],
  ]);
  assert.deepEqual(log.map(attempt => attempt.at), log.map(attempt => attempt.at).sort().reverse());
  assert.equal(requests.length, log.length);
  for (const [i, { request, recorded }] of requests.entries()) {
    const attempt = log.at(-1 - i)!;
    assert.ok(recorded);
    const { status: _status, ...requestFields } = attempt;
    assert.deepEqual(recorded, { ...requestFields, outcome: 'unknown' },
      'the outgoing request must already be visible with its response unknown');
    assert.deepEqual([attempt.method, attempt.url], [request.method, request.url]);
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    if (attempt.kind === 'report') {
      assert.deepEqual(Buffer.from(attempt.body), Buffer.from(await request.arrayBuffer()));
      assert.equal(attempt.url, TELEMETRY_ENDPOINT);
      assert.equal(request.headers.get('content-type'), 'application/json');
    } else {
      assert.equal(request.body, null);
      assert.equal(attempt.url, TELEMETRY_ENDPOINT + '/' + ID);
    }
  }
  const reports = log.filter(attempt => attempt.kind === 'report').slice(1);
  assert.equal(reports.length, 3);
  assert.deepEqual(reports.map(attempt => attempt.body), Array(3).fill(reports[0]!.body));
  assert.deepEqual(JSON.parse(reports[0]!.body), report);

  now = at + 13 * 7 * TELEMETRY_DAY_MS;
  await telemetry.tick();
  assert.deepEqual((await history()).log, log.slice(0, -1));
});

test('queue stops on terminal errors and expires seven days after the reported day', async t => {
  const root = isolated(t), consentPath = join(root, 'consent.json');
  let now = at, calls = 0;
  const paths = (name: string) => ({ consent: consentPath, state: join(root, name) });
  writeJson(consentPath, consent);
  for (const status of [410, 413, 429]) {
    const telemetry = service(undefined, paths(String(status)), () => now, async () => new Response(null, { status }));
    telemetry.queue.enqueue(report, at);
    await telemetry.send();
    assert.equal(telemetry.queue.queued().length, status < 429 ? 0 : 1);
  }
  assert.equal(deadline(day), dayRange(day).end + 7 * TELEMETRY_DAY_MS);
  const expires = service(undefined, paths('expires'), () => now, async () => { calls++; throw new Error('Expired'); });
  expires.queue.enqueue(report, at); now = deadline(day);
  await expires.send(); assert.equal(calls, 0); assert.equal(expires.queue.queued().length, 0);
  assert.equal(retryAt(4, at, null), at + 86_400_000);
  // A week's report left from the earlier format is dropped, never sent.
  const { queue: old } = service(undefined, paths('old'), () => now);
  writeJson(join(root, 'old/queue/week-2026-W45.json'), { report: {}, notBefore: 0, nextAttempt: 0, createdAt: 0, attempts: 0 });
  assert.deepEqual(old.queued(), []); assert.equal(existsSync(join(root, 'old/queue/week-2026-W45.json')), false);
});

test('storage failures prevent an unrecorded request and preserve uncertain attempts', async t => {
  const root = isolated(t), paths = { consent: join(root, 'consent.json'), state: join(root, 'state') };
  const log = join(paths.state, 'log'), backup = join(paths.state, 'log-backup');
  let calls = 0;
  const telemetry = service(undefined, paths, () => at, async () => {
    calls++;
    renameSync(log, backup);
    writeFileSync(log, 'blocks update');
    return new Response(null, { status: 202 });
  });
  writeJson(paths.consent, consent);
  telemetry.queue.enqueue(report, at);
  writeFileSync(log, 'blocks creation');
  await assert.rejects(telemetry.send(), { code: 'ENOTDIR' });
  await assert.rejects(telemetry.deleteSent(), { reason: { kind: 'telemetry_delete_failed' } });
  assert.equal(calls, 0);
  rmSync(log);
  telemetry.queue.enqueue(report, at);
  try { await assert.rejects(telemetry.send(), { code: 'EEXIST' }); }
  finally {
    if (existsSync(backup)) { rmSync(log, { force: true }); renameSync(backup, log); }
  }
  assert.equal(calls, 1);
  const restarted = service(undefined, paths, () => at);
  assert.deepEqual(restarted.history().log.map(attempt => [attempt.outcome, attempt.status]), [['unknown', undefined]]);
  assert.equal(restarted.history().queue.length, 1);
});

test('production telemetry destinations are owned by the outbox', () => {
  const root = resolve(import.meta.dirname, '..');
  const contract = 'packages/contract/src/telemetry.ts', outbox = 'apps/backend/src/telemetry/outbox.ts';
  const host = new URL(TELEMETRY_ENDPOINT).hostname;
  const unexpected: string[] = [];
  for (const area of ['apps', 'packages']) {
    for (const project of readdirSync(join(root, area), { withFileTypes: true })) {
      const src = join(root, area, project.name, 'src');
      if (!project.isDirectory() || !existsSync(src)) continue;
      for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.[cm]?[jt]sx?$/u.test(entry.name)) continue;
        const path = join(entry.parentPath, entry.name), file = relative(root, path);
        if (file === contract || file === outbox) continue;
        const source = readFileSync(path, 'utf8');
        if (source.includes('TELEMETRY_ENDPOINT') || source.includes(host)) unexpected.push(file);
      }
    }
  }
  assert.deepEqual(unexpected, []);
});

test('without screen consent, or with any blocked gate, no service path records or sends', async t => {
  const root = isolated(t);
  const withoutConsent: Partial<GateFacts>[] = [{ consent: null }, { consent: { ...consent, choice: 'off' } },
    { consent: { ...consent, decidedBy: 'cli' } }, { consent: { ...consent, consentVersion: 0 } }];
  for (const [i, patch] of [...withoutConsent, ...blockedPatches].entries()) {
    const paths = { consent: join(root, String(i), 'config/telemetry.json'), state: join(root, String(i), 'state') };
    let calls = 0;
    const telemetry = service(root, paths, () => at + 86_400_000, (async () => { calls++; throw Error('must not send'); }) as typeof fetch, patch);
    const saved = 'consent' in patch ? patch.consent : consent;
    if (saved) writeJson(paths.consent, saved);
    telemetry.queue.enqueue(report, at);
    telemetry.mark({ kind: 'activity' }); telemetry.mark({ kind: 'event', op: 'send.button', attributes: { via: 'screen' } });
    assert.deepEqual(telemetry.marks.snapshot(day, consent.decidedAt), emptyMarks(consent.decidedAt));
    assert.equal(telemetry.preview(), null);
    await telemetry.send(); await telemetry.tick(); await telemetry.close();
    assert.equal(calls, 0, JSON.stringify(patch)); assert.equal(telemetry.history().log.length, 0);
  }
});

test('opt-out under a blocked gate discards pending state and keeps the number for deleting', t => {
  const root = isolated(t), paths = { consent: join(root, 'config/telemetry.json'), state: join(root, 'state') };
  const telemetry = service(root, paths, () => at, undefined, { env: { DO_NOT_TRACK: '1' } });
  writeJson(paths.consent, consent); telemetry.queue.enqueue(report, at);
  writeJson(join(paths.state, `marks/${day}.json`), emptyMarks(consent.decidedAt)); writeJson(join(paths.state, 'next.json'), {});
  const digest = telemetry.status().digest!;
  telemetry.choose('off', 'screen', digest); assert.equal(telemetry.store.read()!.id, ID);
  for (const name of ['queue', 'marks', 'next.json']) assert.equal(existsSync(join(paths.state, name)), false);
  assert.throws(() => telemetry.choose('on', 'screen', digest), /cannot be enabled/);
});

test('deleting asks the receiver to delete this number\'s reports, drops unsent ones, and says when it could not', async t => {
  const root = isolated(t), paths = { consent: join(root, 'config/telemetry.json'), state: join(root, 'state') };
  const asked: unknown[] = [];
  let status = 204;
  const telemetry = service(undefined, paths, () => at, (async (url, init) => {
    // The whole request: the number in the path and nothing beside it (no body, no cookie, no other header).
    const { signal: _, ...rest } = init ?? {};
    asked.push([String(url), rest]); return new Response(null, { status });
  }) as typeof fetch,
    // Deleting is the person's choice, whether or not sending is possible now.
    { env: { DO_NOT_TRACK: '1' } });
  await assert.rejects(telemetry.deleteSent(), { code: PROBLEM_CODE.conflict, reason: { kind: 'telemetry_no_number' } });
  assert.deepEqual(asked, []);
  writeJson(paths.consent, { ...consent, choice: 'off' }); telemetry.queue.enqueue(report, at);
  assert.deepEqual(await telemetry.deleteSent(), { id: ID });
  assert.deepEqual(asked, [[`${TELEMETRY_ENDPOINT}/${ID}`, { method: 'DELETE', redirect: 'error', credentials: 'omit', headers: { 'user-agent': 'alpacawork-telemetry' } }]]);
  assert.equal(telemetry.queue.queued().length, 0);
  status = 404; await telemetry.deleteSent();
  status = 503; await assert.rejects(telemetry.deleteSent(), { code: PROBLEM_CODE.unavailable, reason: { kind: 'telemetry_delete_failed' } });
  assert.deepEqual(telemetry.history().log.map(attempt => [attempt.status, attempt.outcome]).sort(), [
    [204, 'accepted'], [404, 'accepted'], [503, 'retry'],
  ]);
});

test('a day\'s report counts its events with their attributes, the effort of its Runs by agent, and only the consented part', t => {
  const { copy } = workspace(t, 'telemetry');
  const db = openControlDatabase(copy, { busyTimeoutMs: 1000 }, false);
  try {
    const { start, end } = dayRange(day);
    const runs = db.prepare('SELECT id FROM runs ORDER BY id LIMIT 7').all();
    [at - 1, at, at, at, at, end - 1, end].forEach((time, i) => db.prepare("UPDATE runs SET record=json_set(record,'$.created_at',?,'$.agent','private-name','$.state','failed','$.reason','exit') WHERE id=?").run(new Date(time).toISOString(), runs[i]!.id));
    // Names people write must never reach a report: every title, body and Run setting carries this mark.
    const secret = 'PRIVATE-TITLE-7f3a';
    db.prepare("UPDATE tasks SET title=?").run(secret);
    ['high', 'high', secret, null, null, null, null].forEach((effort, i) => db.prepare("UPDATE runs SET record=json_set(record,'$.launch',json(?)) WHERE id=?")
      .run(JSON.stringify({ values: { model: secret, ...effort && { effort } } }), runs[i]!.id));
    const screen = { device: 'phone.ios', via: 'screen', lang: 'ja', theme: 'dark' } as const;
    const marks = { ...emptyMarks(consent.decidedAt), active: true, events: {
      [telemetryEventKey('send.key', screen)]: 7, [telemetryEventKey('search', { ...screen, via: 'agent' })]: 2,
      [telemetryEventKey('w.message', { via: 'cli' })]: 1, [telemetryEventKey('w.hold', { via: 'run.codex' })]: TELEMETRY_MAX_COUNT + 5,
    } };
    const agentOf = (profile: string) => profile === 'private-name' ? 'grok' as const : 'other' as const;
    const made = buildDayReport({ db, consent, day, marks, envelope, agentOf });
    assert.ok(made);
    // Effort of the Runs created after consent and before the day's end; a value outside the known steps is "other".
    assert.deepEqual(made.events, [
      ['effort.high', 1, '-', 'run.grok', '-', '-'], ['effort.other', 1, '-', 'run.grok', '-', '-'],
      ['search', 2, 'phone.ios', 'agent', 'ja', 'dark'], ['send.key', 7, 'phone.ios', 'screen', 'ja', 'dark'],
      ['w.hold', TELEMETRY_MAX_COUNT, '-', 'run.codex', '-', '-'], ['w.message', 1, '-', 'cli', '-', '-'],
    ]);
    assert.deepEqual(made.failures, { exit: '1-5' }); assert.deepEqual(made.agents, ['grok']);
    assert.equal(JSON.stringify(made).includes(secret), false); assert.equal(JSON.stringify(made).includes('private-name'), false);
    // Before consent nothing counts; a day with no use has no report.
    assert.equal(buildDayReport({ db, consent: { ...consent, decidedAt: new Date(end).toISOString() }, day, marks, envelope, agentOf }), null);
    assert.equal(buildDayReport({ db, consent: { ...consent, decidedAt: new Date(start - 3 * TELEMETRY_DAY_MS).toISOString() }, day: '2026-11-01', marks: emptyMarks(consent.decidedAt), envelope, agentOf }), null);
  } finally { db.close(); }
});

test('a busy day keeps its most frequent events up to the limit a report carries', () => {
  const devices = TELEMETRY_EVENT_ATTRIBUTES[0].screen;
  const counts = Object.fromEntries(Array.from({ length: TELEMETRY_MAX_EVENTS + 20 }, (_, i) =>
    [telemetryEventKey(TELEMETRY_OPS[i % TELEMETRY_OPS.length]!, { device: devices[Math.floor(i / TELEMETRY_OPS.length)], via: 'screen', lang: 'ja', theme: 'light' }), i + 1]));
  const events = boundedEvents(counts);
  assert.equal(events.length, TELEMETRY_MAX_EVENTS);
  assert.equal(Math.min(...events.map(event => event[1])), 21);
});

test('each closed day is reported once, during the next day, until seven days after it', async t => {
  const { copy, root } = workspace(t, 'telemetry-days');
  const paths = { consent: join(root, 'config/consent.json'), state: join(root, 'state') };
  let now = at;
  const telemetry = service(copy, paths, () => now, (async () => new Response(null, { status: 503 })) as typeof fetch);
  telemetry.choose('on', 'screen');
  const id = telemetry.status().id!;
  telemetry.mark({ kind: 'event', op: 'search', attributes: { device: 'desktop.linux', via: 'screen', lang: 'en', theme: 'system' } });
  await telemetry.tick(); assert.equal(telemetry.queue.queued().length, 0);
  // Once the day is over its report is queued once, for some time during the next day; a day with no use has none.
  now = at + TELEMETRY_DAY_MS; await telemetry.tick(); await telemetry.tick(); now += TELEMETRY_DAY_MS; await telemetry.tick();
  const queued = telemetry.queue.queued().map(item => item.value);
  assert.deepEqual(queued.map(value => value.report.day), [day]);
  assert.equal(queued[0]!.report.id, id);
  assert.ok(queued[0]!.notBefore >= dayRange(day).end && queued[0]!.notBefore < dayRange(day).end + TELEMETRY_DAY_MS);
  assert.deepEqual(queued[0]!.report.events, [['search', 1, 'desktop.linux', 'screen', 'en', 'system']]);
});

test('the workspace shape measures the live tree: depth, widest parent, longest task thread, never archived tasks', t => {
  const { copy } = workspace(t, 'telemetry');
  const db = openControlDatabase(copy, { busyTimeoutMs: 1000 }, false);
  try {
    // Every task straight under its project, then one branch: a → b → c → (d, e), and an archived f under c.
    db.prepare("UPDATE tasks SET parent_id=project_task_id, lifecycle='active', base_state='todo' WHERE kind='task'").run();
    const big = db.prepare("SELECT project_task_id p FROM tasks WHERE kind='task' GROUP BY project_task_id ORDER BY count(*) DESC LIMIT 1").get()!.p;
    const [a, b, c, d, e, f, ...rest] = db.prepare("SELECT id, external_id FROM tasks WHERE kind='task' AND project_task_id=? ORDER BY number").all(big);
    assert.ok(f && rest.length);
    for (const [child, parent] of [[b, a], [c, b], [d, c], [e, c], [f, c]]) db.prepare('UPDATE tasks SET parent_id=? WHERE id=?').run(parent!.id, child!.id);
    db.prepare("UPDATE tasks SET lifecycle='archived' WHERE id=?").run(f.id);
    db.prepare("UPDATE tasks SET base_state='done' WHERE id IN (?,?)").run(d!.id, e!.id);
    const perTask = new Map<string, number>();
    for (const { task } of db.prepare('SELECT task_id task FROM runs WHERE task_id IS NOT NULL').all())
      if (task !== f.external_id) perTask.set(String(task), (perTask.get(String(task)) ?? 0) + 1);
    // Three Runs overlap at at+1.5h (one still running); one ended before the day and does not count.
    const allRuns = db.prepare('SELECT id FROM runs ORDER BY id').all(), hour = 3_600_000, iso = (time: number) => new Date(time).toISOString();
    allRuns.forEach((run, i) => {
      const [start, end] = [[at, at + 3 * hour], [at + hour, at + 2 * hour], [at + 1.5 * hour, null], [at + 2.5 * hour, at + 4 * hour]][i]
        ?? [dayRange(day).start - 2 * hour, dayRange(day).start - hour];
      db.prepare("UPDATE runs SET record=json_set(record,'$.started_at',?,'$.ended_at',?) WHERE id=?").run(iso(start!), end === null ? null : iso(end!), run.id);
    });
    const count = (sql: string) => Number(db.prepare(sql).get()!.n);
    const live = count("SELECT count(*) n FROM tasks WHERE kind='task' AND lifecycle='active'");
    const marks = { ...emptyMarks(consent.decidedAt), active: true };
    const made = buildDayReport({ db, consent, day, marks, envelope, agentOf: () => 'other' });
    assert.deepEqual(made!.shape, {
      projects: sizeBucket(count("SELECT count(*) n FROM tasks WHERE kind='project'")), tasks: sizeBucket(live), open: sizeBucket(live - 2),
      depth: '3-4', children: '2', top: sizeBucket(rest.length + 1), turns: sizeBucket(Math.max(0, ...perTask.values())),
      // The synthetic workspace has no coordinator conversation.
      talk: '0', parallel: '3-4',
    });
    // Archiving marks the project alone; nothing below it is on the screen, so nothing below it counts.
    db.prepare('UPDATE tasks SET lifecycle=? WHERE id=?').run('archived', big);
    const archived = buildDayReport({ db, consent, day, marks, envelope, agentOf: () => 'other' });
    assert.equal(archived!.shape.depth, '0'); assert.equal(archived!.shape.children, '0'); assert.equal(archived!.shape.top, '0');
  } finally { db.close(); }
});

test('a Run counts as its profile\'s built-in adapter in the current settings, never by its name', t => {
  const { copy } = workspace(t, 'telemetry');
  const db = openControlDatabase(copy, { busyTimeoutMs: 1000 }, false);
  try {
    const runs = db.prepare('SELECT id FROM runs ORDER BY id LIMIT 3').all();
    ['private-alias', 'claude', 'lost-profile'].forEach((agent, i) => db.prepare("UPDATE runs SET record=json_set(record,'$.created_at',?,'$.agent',?) WHERE id=?")
      .run(new Date(at).toISOString(), agent, runs[i]!.id));
  } finally { db.close(); }
  const settings = (text: string) => writeFileSync(join(copy, 'config.yaml'), text);
  const agents = () => {
    const made = reportFromWorkspace(copy, consent, day, emptyMarks(consent.decidedAt), makeEnvelope);
    assert.ok(made);
    for (const name of ['private-alias', 'lost-profile']) assert.equal(JSON.stringify(made).includes(name), false, name);
    return [...made.agents].sort();
  };
  // An alias with its adapter written, a built-in profile that leaves it out, and a Run whose profile is gone.
  settings(stringify({ agents: { 'private-alias': fixtureAgentSetting('codex'), claude: defaultAgentSetting('claude') } }));
  assert.deepEqual(agents(), ['claude', 'codex', 'other']);
  settings(stringify({ agents: { 'private-alias': fixtureAgentSetting('grok'), 'lost-profile': fixtureAgentSetting('pi') } }));
  assert.deepEqual(agents(), ['grok', 'other', 'pi']);
  settings('agents: [\n');
  assert.deepEqual(agents(), ['other']);
});

test('a CLI write counts as the action authorization reads of it, by the way its caller came', () => {
  const spec = (name: string) => commandCatalog.commands.find(command => command.words.join(' ') === name)!;
  const person = { kind: 'human' } as const, run = { kind: 'run', runId: 'R1', placementId: 'P1', taskId: 'T1', role: 'owner', responsible: true } as const;
  const task = (facts: { baseState?: 'todo' | 'doing' | 'waiting' | 'done'; hold?: boolean }) => () => ({ id: 'T1', baseState: facts.baseState ?? 'doing', hold: facts.hold ?? false, openUserQuestion: false });
  const report = (input: object, caller: typeof person | typeof run, facts: Parameters<typeof task>[0] = {}) => writeOp(spec('task report'), input, caller, task(facts));
  // The screen's writes keep the screen's names, whatever the way.
  assert.equal(report({ task: 'T1', state: 'held' }, person), 'w.hold');
  assert.equal(report({ task: 'T1', state: 'stopped' }, person), 'w.stop');
  assert.equal(report({ task: 'T1', state: 'doing' }, person, { baseState: 'doing', hold: true }), 'w.unhold');
  assert.equal(report({ task: 'T1', state: 'done', aboutRun: 'R1' }, person, { baseState: 'waiting' }), 'w.approve');
  // A confirmation of a result no Run submitted is the same confirmation.
  assert.equal(report({ task: 'T1', state: 'done' }, person, { baseState: 'waiting' }), 'w.approve');
  // A Run's own state report and question, and a withdrawn question, are the CLI's own.
  assert.equal(report({ state: 'done' }, run), 'w.report');
  assert.equal(report({ state: 'waiting', askTo: 'user' }, run), 'w.ask');
  assert.equal(report({ withdraw: 'L1' }, run), 'w.ask');
  assert.equal(writeOp(spec('task new'), { title: 'x' }, run, task({})), 'w.task');
  assert.equal(writeOp(spec('task new'), { title: 'x', kind: 'project' }, person, task({})), 'w.project');
  assert.equal(writeOp(spec('task comment'), { task: 'T1', body: 'x' }, run, task({})), 'w.comment');
  assert.equal(writeOp(spec('task request'), { task: 'T1', body: 'x', answers: 'L1' }, person, task({})), 'w.message');
  assert.equal(writeOp(spec('task file put'), null, run, task({})), 'w.file');
  assert.equal(writeOp(spec('dependency set'), { task: 'T1', after: [] }, run, task({})), null);
  // Each counted command is found by its method and path, a file put by its Task's path; reads are not counted.
  assert.equal(countedCommand('PUT', '/api/tasks/T12/file')?.id, 'task/file/put');
  assert.equal(countedCommand('GET', '/api/tasks/T12/file'), undefined);
  const agentOf = (placement: string) => placement === 'P1' ? 'codex' as const : 'other' as const;
  assert.equal(callerVia(person, agentOf), 'cli');
  assert.equal(callerVia({ kind: 'coordinator', conversation: 'c', source: 'screen', provider: 'claude', runId: 'R1' }, agentOf), 'coord.screen');
  assert.equal(callerVia({ kind: 'coordinator', conversation: 'c', source: 'claude' }, agentOf), 'coord.chat.claude');
  assert.equal(callerVia(run, agentOf), 'run.codex');
});

test('while sending is on, one CLI comment counts once as w.comment by cli, and its resend under the same ID does not', async t => {
  const root = isolated(t), paths = { consent: join(root, 'config/telemetry.json'), state: join(root, 'state') };
  const telemetry = service(undefined, paths, () => at);
  telemetry.choose('on', 'screen');
  const comment = commandCatalog.commands.find(command => command.id === 'task/comment')!;
  const saved = new Set<string>();
  const app = new Hono();
  app.use('/api/*', countCliWrites(telemetry, { caller: () => ({ kind: 'human' }), task: () => { throw Error('a comment reads no Task'); },
    agentOf: () => 'other', recorded: id => saved.has(id) }));
  app.post(comment.path, async c => { const opId = c.req.header('x-alpacawork-op-id')!; await c.req.json(); saved.add(opId); return c.json({ ok: true }); });
  const send = (opId: string, client = 'cli') => app.request(comment.path, { method: 'POST', body: JSON.stringify({ task: 'T1', body: 'note', opId }),
    headers: { 'content-type': 'application/json', 'x-alpacawork-client': client, 'x-alpacawork-op-id': opId } });
  assert.equal((await send('op-1')).status, 200);
  assert.equal((await send('op-1')).status, 200);
  // The screen's own writes are counted on the screen, not here.
  assert.equal((await send('op-2', 'screen')).status, 200);
  assert.deepEqual(telemetry.marks.snapshot(day, telemetry.store.read()!.decidedAt).events, { [telemetryEventKey('w.comment', { via: 'cli' })]: 1 });
});

test('a delete while sending stops the send before it, and the deleted days are not reported again', async t => {
  const { copy, root } = workspace(t, 'telemetry-delete');
  const paths = { consent: join(root, 'config/consent.json'), state: join(root, 'state') };
  let now = at;
  const calls: string[] = [];
  const telemetry = service(copy, paths, () => now, (async (url, init) => {
    if (init?.method === 'DELETE') { calls.push('DELETE'); return new Response(null, { status: 204 }); }
    calls.push('POST');
    // The report's send holds until it is stopped.
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => { calls.push('POST stopped'); reject(Error('aborted')); }));
  }) as typeof fetch);
  telemetry.choose('on', 'screen');
  const attributes = { device: 'desktop.linux', via: 'screen', lang: 'ja', theme: 'light' } as const;
  telemetry.mark({ kind: 'event', op: 'search', attributes });
  // The first day also has a Run in the database, which alone would make its report again.
  const db = openControlDatabase(copy, { busyTimeoutMs: 1000 }, false);
  try { db.prepare("UPDATE runs SET record=json_set(record,'$.created_at',?,'$.launch',json('{\"values\":{\"effort\":\"high\"}}')) WHERE id=(SELECT min(id) FROM runs)").run(new Date(at + 1).toISOString()); }
  finally { db.close(); }
  // Two days later the first day's report is due and goes out; meanwhile today is used too.
  now = at + 2 * TELEMETRY_DAY_MS;
  telemetry.mark({ kind: 'event', op: 'tree.go', attributes });
  const ticking = telemetry.tick();
  assert.deepEqual(calls, ['POST']);
  // The send is stopped, not waited out until its own timeout.
  const asked = performance.now();
  await telemetry.deleteSent();
  assert.ok(performance.now() - asked < 5_000);
  await ticking;
  assert.deepEqual(calls, ['POST', 'POST stopped', 'DELETE']);
  // Nothing counted before the delete is reported again: not the sent day, not today's earlier use.
  await telemetry.tick();
  now += TELEMETRY_DAY_MS; await telemetry.tick();
  assert.deepEqual(telemetry.queue.queued(), []);
  assert.deepEqual(calls, ['POST', 'POST stopped', 'DELETE']);
  assert.equal(telemetry.preview(), null);
});

test('every blocked gate refuses screen opt-in without writing consent, but accepts opt-out', t => {
  const root = isolated(t);
  for (const [i, patch] of blockedPatches.entries()) {
    const paths = { consent: join(root, String(i), 'consent.json'), state: join(root, String(i), 'state') };
    const telemetry = service(undefined, paths, () => at, undefined, patch);
    assert.equal(telemetry.status().state, 'blocked');
    assert.throws(() => telemetry.choose('on', 'screen'), {
      code: PROBLEM_CODE.forbidden, message: /cannot be enabled/, reason: { kind: 'telemetry_opt_in_unavailable' },
    });
    assert.equal(existsSync(paths.consent), false);
    telemetry.choose('off', 'cli'); assert.equal(telemetry.store.read()!.choice, 'off');
  }
  const paths = { consent: join(root, 'damaged.json'), state: join(root, 'damaged-state') };
  writeJson(paths.consent, { broken: true });
  const damaged = service(undefined, paths, () => at);
  assert.equal(damaged.status().blockedBy, 'invalid_state');
  damaged.choose('off', 'cli'); assert.equal(damaged.store.read()!.choice, 'off');
});

test('screen preview includes pending use, stays read-only and never queues or sends a report', async t => {
  const { copy, root } = workspace(t, 'telemetry-preview');
  const paths = { consent: join(root, 'config/consent.json'), state: join(root, 'state') };
  let calls = 0;
  const telemetry = service(copy, paths, () => at, (async () => { calls++; throw Error('preview must not send'); }) as typeof fetch);
  telemetry.choose('on', 'screen');
  assert.equal(telemetry.preview(), null);
  const attributes = { device: 'desktop.macos', via: 'screen', lang: 'ja', theme: 'light' } as const;
  telemetry.mark({ kind: 'event', op: 'search', attributes }); telemetry.mark({ kind: 'event', op: 'search', attributes });
  for (const ms of [100, 300, 3_000]) telemetry.mark({ kind: 'time', time: 'open', ms });
  const queued = telemetry.queue.queued(), digest = telemetry.store.digest();
  assert.deepEqual(telemetry.preview()!.events, [['search', 2, 'desktop.macos', 'screen', 'ja', 'light']]);
  // The typical (median) and the slowest of the day's three page openings.
  assert.deepEqual(telemetry.preview()!.times, { open: ['0.25-0.5s', '2-5s'] });
  assert.deepEqual(telemetry.queue.queued(), queued); assert.equal(telemetry.store.digest(), digest);
  assert.equal(existsSync(join(paths.state, 'marks')), false); assert.equal(existsSync(join(paths.state, 'log')), false);
  assert.equal(calls, 0);
  telemetry.choose('off', 'screen'); assert.equal(telemetry.preview(), null);
  assert.throws(() => telemetry.choose('on', 'cli'), /cannot be enabled/);
  await telemetry.close();
});
