import { randomUUID } from 'node:crypto';
/** Web Push from serve: the notices the tree's balls and home rows are, endpoints, the public host, and delivery records. */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveEvents, endpointAllowed, holdingKeys, PushStore, type PushSender } from '@alpacawork/backend/test-dist/receiver/push.js';
import { defaultSettings, type Ball, type PushPayload } from '@alpacawork/contract';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { createPersonSettings } from '@alpacawork/backend/test-dist/receiver/person-state.js';
import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';
import { ControlStore } from '@alpacawork/db';
import type { Problem } from '@alpacawork/core';

const FCM = 'https://fcm.googleapis.com/fcm/send/device-one';
const APNS = 'https://web.push.apple.com/QWxhZGRpbjpvcGVu';
type Task = Parameters<typeof holdingKeys>[0][number];
type Log = Task['log'][number];
/** A Task of the screen's tree as push reads it, below the root project P1; the user asked for it unless `fields` say not. */
const task = (id: string, state: Task['state'], log: Log[], fields: Partial<Task> = {}): Task =>
  ({ id, kind: 'task', parentId: 'P1', title: `Task ${id}`, state, lifecycle: 'active', userRequested: true, log, ...fields });
/** A person's record that sets `toState`. */
const record = (id: string, at: string, toState: Log['toState'], title: string | null = null): Log =>
  ({ id, kind: 'reported', at, title, description: null, actor: { kind: 'human' }, fromState: null, toState });
type UserBall = Extract<Ball, { holder: 'user' }>;
/** The user's ball, as the tree sends it: each reason with the detail it carries. */
const userBall = (reason: UserBall['reason'], key: string, at = '2026-09-29T00:00:00Z'): UserBall =>
  ({ holder: 'user', reason, at, key, questionId: reason === 'question' ? key : null, aboutRunId: reason === 'review' ? 'R1' : null,
    count: reason === 'limit' ? 2 : null, code: reason === 'blocked' ? 'too_deep' : null, failure: null });
/** A Task waiting for the user's review of report `key`. */
const reviewTask = (id: string, key: string, at = '2026-10-14T00:00:00Z') => task(id, 'waiting', [record(key, at, 'waiting')]);
const subscription = (endpoint = FCM) => ({ endpoint, expirationTime: null, keys: { p256dh: 'BAAeFXiNM4nLLiGrGmHlXrcRxEiganHmMidSakDxHs8vMYDqt4vtd9nqOGW6MAH9rzXsFSETkMJd06dq3yX_kc8', auth: 'UUALvnVwjZoGLy-BHN4_LA' } });
const noticeCases = [
  { reason: 'review', ja: '要確認', en: 'Please review', shortJa: '確認待ち', shortEn: 'Review' },
  { reason: 'question', ja: '要回答', en: 'Please answer', shortJa: '回答待ち', shortEn: 'Question' },
  { reason: 'limit', ja: '上限で停止・続けるか決めてください', en: 'Stopped at the wake limit. Decide whether to continue', shortJa: '上限で停止', shortEn: 'At limit' },
  { reason: 'unconfirmed', ja: '届いたか不明・確かめてください', en: 'A request may not have arrived. Please check', shortJa: '届いたか不明', shortEn: 'Unconfirmed' },
  { reason: 'blocked', ja: '起動できず・理由を確かめてください', en: "Couldn't wake the agent. Please check why", shortJa: '起動できず', shortEn: "Couldn't wake" },
  { reason: 'failed', ja: 'エラーで停止・やり直すか決めてください', en: 'Stopped by an error. Decide whether to retry', shortJa: 'エラー', shortEn: 'Error' },
  { reason: 'done', ja: '完了', en: 'Completed', shortJa: '完了', shortEn: 'Completed' },
  { reason: 'stopped', ja: '中止', en: 'Stopped', shortJa: '中止', shortEn: 'Stopped' },
] as const;
/** Match the ball key to a report even for follow-up reasons; summaries must never use its title as the reason. */
const noticeFixture = (reason: typeof noticeCases[number]['reason'], id: string, at: string, title: string | null) => {
  const ended = reason === 'done' || reason === 'stopped';
  const key = `L${id}`;
  const state = ended ? reason : reason === 'failed' ? 'error' : 'waiting';
  return { task: task(id, state, [record(key, at, state, title)]),
    balls: ended ? {} : { [id]: userBall(reason, key, at) } };
};

describe('Task notices', () => {
  const settings = { ...defaultSettings(), language: 'en' };
  const at = '2026-10-14T00:00:00Z';
  test('the user\'s ball is the notice: its kind from one table of reasons, its key the ball\'s', () => {
    const waiting = task('T2', 'waiting', [record('L1', '2026-10-13T00:00:00Z', 'todo'), record('L2', at, 'waiting', 'Please review'),
      { ...record('LQ', at, null, 'Which one?'), kind: 'asked', actor: { kind: 'placement', placementId: 'P1' },
        description: 'Pick one', askedTo: null, decide: [{ decide_kind: 'choose', decide_question: 'Which one?' }] }]);
    const cases: [UserBall, string][] = [[userBall('review', 'L2', at), 'Please review: Please review'], [userBall('question', 'LQ', at), 'Please answer: Which one?'],
      [userBall('limit', 'limit:RET1', at), 'Stopped at the wake limit. Decide whether to continue'],
      [userBall('unconfirmed', 'uncertain:RET2', at), 'A request may not have arrived. Please check'],
      [userBall('blocked', 'too_deep:RET3', at), "Couldn't wake the agent. Please check why"],
      [userBall('failed', 'L2', at), 'Stopped by an error. Decide whether to retry: Please review']];
    for (const [ball, body] of cases) {
      const balls = { T2: ball };
      assert.deepEqual([...holdingKeys([waiting], balls).keys()], [`T2:${ball.key}`]);
      assert.deepEqual(deriveEvents(new Set(), [waiting], balls, settings).map(event =>
        [event.key, event.payload.title, event.payload.body, event.payload.url, event.urgency, event.occurredAt]),
        [[`T2:${ball.key}`, 'T2 Task T2', body, '/?task=T2', 'high', at]], ball.reason);
    }
    // Each kind is chosen by its own setting: a failure with the follow-ups.
    const off = (key: string) => ({ ...settings, [key]: false });
    for (const [ball, setting] of [[userBall('review', 'L2', at), 'push.review'], [userBall('question', 'LQ', at), 'push.question'],
      [userBall('limit', 'limit:RET1', at), 'push.followup'], [userBall('unconfirmed', 'uncertain:RET2', at), 'push.followup'],
      [userBall('blocked', 'too_deep:RET3', at), 'push.followup'], [userBall('failed', 'L2', at), 'push.followup']] as const)
      assert.deepEqual(deriveEvents(new Set(), [waiting], { T2: ball }, off(setting)), [], setting);
    // A notice already seen is not new; a ball that is not the user's is no notice.
    assert.deepEqual(deriveEvents(new Set(['T2:L2']), [waiting], { T2: userBall('review', 'L2', at) }, settings), []);
    const others: Ball[] = [{ holder: 'parent', reason: 'failed' }, { holder: 'parent', reason: 'question' }, { holder: 'child' },
      { holder: 'owner' }];
    for (const ball of others) assert.deepEqual([...holdingKeys([waiting], { T2: ball }).keys()], [], ball.holder);
  });
  test('a finished Task is noticed only as a row of the home list, under the entry that finished it', () => {
    const finished = (state: 'done' | 'stopped', fields: Partial<Task> = {}) => task('T2', state, [record('L1', '2026-10-13T00:00:00Z', 'todo'),
      record('L2', at, 'doing'), record('L3', at, state), record('L4', at, state, 'Said again')], fields);
    const done = { ...settings, 'push.done': true };
    assert.deepEqual(deriveEvents(new Set(), [finished('done')], {}, settings), [], 'done is off by default');
    // Repeated reports in the finished state are not a new end.
    assert.deepEqual(deriveEvents(new Set(), [finished('done')], {}, done).map(event =>
      [event.key, event.payload.body, event.payload.url, event.urgency]), [['T2:L3', 'Completed', '/?task=T2', 'normal']]);
    assert.deepEqual(deriveEvents(new Set(), [finished('stopped')], {}, settings).map(event =>
      [event.key, event.payload.body, event.urgency]), [['T2:L3', 'Stopped', 'high']]);
    // Every top Task can notify, with or without the old user-request mark. Children never notify on completion.
    for (const state of ['done', 'stopped'] as const) {
      const top = finished(state, { userRequested: false });
      assert.equal(deriveEvents(new Set(), [top], {}, done).length, 1);
      const parent = task('T1', 'doing', []);
      const child = finished(state, { parentId: parent.id, userRequested: true });
      assert.deepEqual(deriveEvents(new Set(), [parent, child], {}, done), []);
      assert.equal(deriveEvents(new Set(), [child], {}, done).length, 1, 'a missing parent is a top row');
    }
    // Finished again after more work: the entry that finished it this time.
    const again = task('T2', 'done', [record('L3', at, 'done'), record('L5', at, 'doing'), record('L6', at, 'done')]);
    assert.deepEqual([...holdingKeys([again], {}).keys()], ['T2:L6']);
  });
});

describe('endpoints', () => {
  test('only the browsers\' push services, over https on the default port', () => {
    for (const ok of [FCM, APNS, 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://sin.notify.windows.com/w/?token=x'])
      assert.equal(endpointAllowed(ok), true, ok);
    for (const bad of ['http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.example/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.example/x', 'https://push.apple.com/x', 'https://a.b.push.apple.com/x', 'https://user@fcm.googleapis.com/x', 'not a url'])
      assert.equal(endpointAllowed(bad), false, bad);
  });
});

describe('serve', () => {
  let area: string, root: string;
  const sender: PushSender = async () => ({ status: 201 });
  const apps: Awaited<ReturnType<typeof startServer>>[] = [];
  async function server(publicHost?: string) {
    const app = await startServer(root, 0, { publicHost, pushSender: sender });
    apps.push(app);
    return app;
  }
  // Node's fetch ignores a Host header, so requests that impersonate the public name go through node:http.
  const raw = (base: string, path: string, headers: Record<string, string>, method = 'GET', body?: string) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: () => unknown }>((done, fail) => {
      const url = new URL(base);
      const req = request({ host: url.hostname, port: url.port, path, method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
        let text = '';
        res.on('data', chunk => text += chunk);
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, json: () => JSON.parse(text) }));
      });
      req.on('error', fail); req.end(body);
    });
  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => raw(base, path, headers, 'POST', JSON.stringify(body));
  /** A settings save is a write with its own operation ID, as the screen and the command line send it. */
  const saving = () => ({ 'X-Alpacawork-Op-Id': randomUUID() });
  const pushFile = () => JSON.parse(readFileSync(join(root, '.alpacawork', 'push.json'), 'utf8')) as
    { events: { key: string; pending: boolean; created_at: string; deliveries: Record<string, { closed_at?: string }> }[] };
  beforeEach(async () => {
    area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-push-')));
    root = join(area, 'root'); mkdirSync(root, { mode: 0o700 });
    await initializeWorkspace(root);
  });
  afterEach(async () => { for (const app of apps.splice(0)) await app.close(); rmSync(area, { recursive: true, force: true }); });

  for (const language of ['ja', 'en'] as const) for (const reportTitle of [null, '報告の題 / Report title']) {
    for (const example of noticeCases) {
      // The label comes from the reason and language; the report's title joins any label the same way (push.ts).
      if (reportTitle === null || example.reason === 'review' || example.reason === 'done') test(`single ${example.reason}, ${language}, report title ${reportTitle === null ? 'absent' : 'present'}`, async () => {
        const delivered: PushPayload[] = [];
        const store = await PushStore.open(root, { subject: 'https://localhost', sender: async (_device, payload) => {
          delivered.push(payload); return { status: 201 };
        } });
        try {
          const at = '2026-10-14T00:00:00Z', now = Date.parse(at);
          const settings = { ...defaultSettings(), language, 'push.done': true };
          await store.subscribe(subscription(), 'Phone');
          await store.observe([], {}, settings, now);
          const fixture = noticeFixture(example.reason, 'T2', at, reportTitle);
          await store.observe([fixture.task], fixture.balls, settings, now);
          await store.tick(now, { state: 'away', until: null }, null, language);
          assert.deepEqual(delivered, [{ title: 'T2 Task T2',
            body: example[language] + (reportTitle === null ? '' : `${language === 'ja' ? '：' : ': '}${reportTitle}`),
            url: '/?task=T2', tag: 'T2:LT2' }]);
        } finally { await store.close(); }
      });

      // A summary never uses the title, which only a report with one can show.
      if (reportTitle !== null) test(`summary ${example.reason}, ${language}, report title present`, async () => {
        const delivered: PushPayload[] = [];
        let store = await PushStore.open(root, { subject: 'https://localhost', sender: async () => ({ status: 201 }) });
        try {
          const at = '2026-10-14T00:00:00Z', now = Date.parse(at);
          const settings = { ...defaultSettings(), language, 'push.done': true };
          await store.subscribe(subscription(), 'Phone');
          await store.observe([], {}, settings, now);
          const fixtures = ['T2', 'T3'].map(id => noticeFixture(example.reason, id, at, reportTitle));
          const tasks = fixtures.map(fixture => fixture.task);
          const balls = Object.assign({}, ...fixtures.map(fixture => fixture.balls));
          await store.observe(tasks, balls, settings, now);
          await store.tick(now, { state: 'present', until: null }, null, language);
          await store.close();
          // Rebuild the reason from the current tree after restart, without adding fields to push.json.
          store = await PushStore.open(root, { subject: 'https://localhost', sender: async (_device, payload) => {
            delivered.push(payload); return { status: 201 };
          } });
          await store.observe(tasks, balls, settings, now);
          await store.tick(now, { state: 'away', until: null }, null, language);
          const short = language === 'ja' ? example.shortJa : example.shortEn;
          assert.equal(delivered.length, 1);
          assert.equal(delivered[0]!.title, language === 'ja' ? '2件の知らせ' : '2 updates');
          assert.equal(delivered[0]!.body, `${short} T2 Task T2\n${short} T3 Task T3`);
          assert.equal(delivered[0]!.url, '/');
          assert.match(delivered[0]!.tag, /^pending:[a-f0-9]{16}$/);
          const saved = JSON.parse(readFileSync(join(root, '.alpacawork', 'push.json'), 'utf8'));
          assert.equal(saved.version, 4);
          assert.deepEqual(Object.keys(saved.events[0]).sort(), ['key', 'payload', 'urgency', 'created_at', 'log_count', 'pending', 'deliveries'].sort());
        } finally { await store.close(); }
      });
    }
  }

  test('unset or unsupported languages fall back to English and an empty report title adds no separator; task titles still clip at 80', () => {
    const fixture = noticeFixture('review', 'T2', '2026-10-14T00:00:00Z', '');
    fixture.task.title = '長'.repeat(100);
    for (const language of ['en', 'fr', null]) {
      const events = deriveEvents(new Set(), [fixture.task], fixture.balls, { ...defaultSettings(), language });
      assert.equal(events[0]!.payload.body, 'Please review');
      assert.equal(events[0]!.payload.title, 'T2 ' + '長'.repeat(76) + '…');
    }
  });

  test('a summary with Task context removed while another device sends falls back to titles alone', async () => {
    const delivered: PushPayload[] = [];
    const at = '2026-10-14T00:00:00Z', now = Date.parse(at), settings = defaultSettings();
    const store = await PushStore.open(root, { subject: 'https://localhost', sender: async (_device, payload) => {
      delivered.push(payload);
      if (delivered.length === 1) await store.observe([], {}, settings, now);
      return { status: 201 };
    } });
    try {
      await store.subscribe(subscription(), 'Phone');
      await store.subscribe(subscription(APNS), 'Tablet');
      await store.observe([], {}, settings, now);
      await store.observe([reviewTask('T2', 'L2'), reviewTask('T3', 'L3')],
        { T2: userBall('review', 'L2', at), T3: userBall('review', 'L3', at) }, settings, now);
      await store.tick(now, { state: 'away', until: null });
      assert.equal(delivered.length, 2);
      assert.equal(delivered[0]!.body, 'Review T2 Task T2\nReview T3 Task T3');
      assert.equal(delivered[1]!.body, 'T2 Task T2\nT3 Task T3');
    } finally { await store.close(); }
  });

  for (const language of ['ja', 'en'] as const) test(`summary lines clip at 40, the whole body at 180, and host titles stay intact (${language})`, async () => {
    const delivered: PushPayload[] = [];
    const store = await PushStore.open(root, { subject: 'https://localhost', sender: async (_device, payload) => {
      delivered.push(payload); return { status: 201 };
    } });
    try {
      const at = '2026-10-14T00:00:00Z', now = Date.parse(at);
      const settings = { ...defaultSettings(), language };
      await store.subscribe(subscription(), 'Phone');
      await store.observe([], {}, settings, now);
      const fixtures = Array.from({ length: 5 }, (_, index) => noticeFixture('review', `T${index + 2}`, at, 'Not in summary'));
      const tasks = fixtures.map(fixture => ({ ...fixture.task, title: '長'.repeat(100) }));
      const balls = Object.assign({}, ...fixtures.map(fixture => fixture.balls));
      await store.observe(tasks, balls, settings, now);
      const hostPayload = { title: language === 'ja' ? '端末の負荷が高くなっています' : 'This machine is under load',
        body: 'Host body stays unchanged', url: '/', tag: `host:${now}` };
      store.holdHost(hostPayload.tag);
      await store.record({ key: hostPayload.tag, payload: hostPayload, urgency: 'high', occurredAt: at }, now);
      await store.tick(now, { state: 'away', until: null }, null, language);
      const prefix = language === 'ja' ? '確認待ち' : 'Review';
      const lines = tasks.map(item => `${prefix} ${item.id} ${item.title}`.slice(0, 39) + '…');
      assert.equal(delivered[0]!.body, [...lines, hostPayload.title].join('\n').slice(0, 179) + '…');
      assert.equal(delivered[0]!.body.length, 180);
      assert.ok(delivered[0]!.body.split('\n').every(line => line.length <= 40));

      // A short mixed summary exposes the complete host line, which total clipping hid above.
      const later = now + 60_000;
      const next = noticeFixture('done', 'T9', new Date(later).toISOString(), null);
      await store.observe([next.task], {}, { ...settings, 'push.done': true }, later);
      const nextHost = { ...hostPayload, tag: `host:${later}` };
      store.holdHost(nextHost.tag);
      await store.record({ key: nextHost.tag, payload: nextHost, urgency: 'high', occurredAt: new Date(later).toISOString() }, later);
      await store.tick(later, { state: 'away', until: null }, null, language);
      assert.equal(delivered[1]!.body, `${language === 'ja' ? '完了' : 'Completed'} T9 Task T9\n${hostPayload.title}`);
      // A single host notice continues to use the recorded payload verbatim.
      const last = later + 60_000, singleHost = { ...hostPayload, tag: `host:${last}` };
      store.holdHost(singleHost.tag);
      await store.record({ key: singleHost.tag, payload: singleHost, urgency: 'high', occurredAt: new Date(last).toISOString() }, last);
      await store.tick(last, { state: 'away', until: null }, null, language);
      assert.deepEqual(delivered[2], singleHost);
    } finally { await store.close(); }
  });

  test('the first read is a baseline; a reopened store repeats nothing, and a kind enabled later sends none of its old notices', async () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const finished = (id: string) => task(id, 'done', [record(`L${id}`, '2026-10-14T00:00:00Z', 'done')]);
    let store = await PushStore.open(root, { subject: 'https://localhost', sender });
    await store.subscribe(subscription(), 'Phone');
    const waiting = reviewTask('T2', 'L2'), later = reviewTask('T3', 'L3');
    const balls = { T2: userBall('review', 'L2', '2026-10-14T00:00:00Z'), T3: userBall('review', 'L3', '2026-10-14T00:00:00Z') };
    assert.deepEqual(await store.observe([waiting], balls, defaultSettings(), now), [], 'what holds at the first read is the baseline');
    assert.deepEqual((await store.observe([waiting, later], balls, defaultSettings(), now)).map(event => event.key), ['T3:L3']);
    await store.close();
    store = await PushStore.open(root, { subject: 'https://localhost', sender });
    assert.deepEqual(await store.observe([waiting, later], balls, defaultSettings(), now), [], 'the seen keys survive a restart');
    // Done is off by default: one seen while it is off is not sent once it is on; one that ends after that is.
    assert.deepEqual(await store.observe([waiting, later, finished('T4')], balls, defaultSettings(), now), []);
    const done = { ...defaultSettings(), 'push.done': true };
    assert.deepEqual(await store.observe([waiting, later, finished('T4')], balls, done, now), []);
    assert.deepEqual((await store.observe([waiting, later, finished('T4'), finished('T5')], balls, done, now)).map(event => event.key),
      ['T5:LT5']);
    assert.deepEqual(pushFile().events.map(event => event.key), ['T3:L3', 'T5:LT5']);
    await store.close();
  });

  test('holding a turn and taking it back keep its ball\'s key, so neither notifies again', async () => {
    const store = await PushStore.open(root, { subject: 'https://localhost', sender });
    await store.subscribe(subscription(), 'Phone');
    const now = Date.parse('2026-10-14T00:00:00Z');
    // The ball of a held review is the same ball: its key and time are those of the report it waits on.
    const balls = { T2: userBall('review', 'L2', '2026-10-14T00:00:00Z') };
    const waiting = reviewTask('T2', 'L2');
    const held = { ...waiting, state: 'held' as const, log: [...waiting.log, { ...record('L3', '2026-10-14T00:01:00Z', 'held'), fromState: 'waiting' as const }] };
    const back = { ...held, state: 'waiting' as const, log: [...held.log, { ...record('L4', '2026-10-14T00:02:00Z', 'waiting'), fromState: 'held' as const }] };
    await store.observe([], {}, defaultSettings(), now);
    assert.deepEqual((await store.observe([waiting], balls, defaultSettings(), now)).map(event => event.key), ['T2:L2']);
    assert.deepEqual(await store.observe([held], balls, defaultSettings(), now + 60_000), []);
    assert.deepEqual(await store.observe([back], balls, defaultSettings(), now + 120_000), []);
    assert.deepEqual(pushFile().events.map(event => event.key), ['T2:L2']);
    await store.close();
  });

  test('a push.json of another version is refused as unreadable, like a damaged one', async () => {
    await (await PushStore.open(root, { subject: 'https://localhost', sender })).close();
    const file = join(root, '.alpacawork', 'push.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version: 3 }));
    await assert.rejects(PushStore.open(root, { subject: 'https://localhost', sender }), (error: Problem) => error.code === 'unavailable' && error.reason?.kind === 'push_unavailable');
  });

  test('held notifications survive restart, combine on return, and skip opened or changed turns', async () => {
    const delivered: { title: string; body: string; url: string }[] = [];
    const send: PushSender = async (_device, payload) => { delivered.push(payload); return { status: 201 }; };
    const one = reviewTask('T2', 'L2'), two = reviewTask('T3', 'L3');
    const balls = { T2: userBall('review', 'L2', '2026-10-14T00:00:00Z'), T3: userBall('review', 'L3', '2026-10-14T00:00:00Z') };
    let store = await PushStore.open(root, { subject: 'https://localhost', sender: send });
    await store.subscribe(subscription(), 'Phone');
    await store.observe([], {}, defaultSettings());
    await store.observe([one, two], balls, defaultSettings(), Date.parse('2026-10-14T00:00:00Z'));
    await store.tick(Date.parse('2026-10-14T00:00:01Z'), { state: 'present', until: null });
    assert.equal(delivered.length, 0);
    assert.ok(pushFile().events.every(event => event.pending));
    await store.close();
    store = await PushStore.open(root, { subject: 'https://localhost', sender: send });
    await store.observe([one, two], balls, defaultSettings());
    await store.tick(Date.parse('2026-10-14T00:01:00Z'), { state: 'away', until: null });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.title, '2 updates');
    assert.equal(delivered[0]!.url, '/');
    assert.ok(pushFile().events.every(event => !event.pending));

    const three = reviewTask('T4', 'L4', '2026-10-14T00:02:00Z');
    await store.observe([one, two, three], { ...balls, T4: userBall('review', 'L4', '2026-10-14T00:02:00Z') }, defaultSettings(), Date.parse('2026-10-14T00:02:00Z'));
    await store.tick(Date.parse('2026-10-14T00:02:01Z'), { state: 'muted', until: '2026-10-14T01:00:00Z' });
    const read = { version: 4 as const, checkpoint: { at: '2026-10-14T00:00:00Z', tasks: {} },
      reads: { T4: { log: three.log.length, state: 'waiting' as const, body: '', turnKey: 'L4' } } };
    await store.tick(Date.parse('2026-10-14T01:00:00Z'), { state: 'away', until: null }, read);
    assert.equal(delivered.length, 1, 'an opened turn is discarded');
    const four = reviewTask('T5', 'L5', '2026-10-14T01:02:00Z');
    await store.observe([one, two, three, four], { ...balls,
      T4: userBall('review', 'L4', '2026-10-14T00:02:00Z'),
      T5: userBall('review', 'L5', '2026-10-14T01:02:00Z') }, defaultSettings(), Date.parse('2026-10-14T01:02:00Z'));
    await store.tick(Date.parse('2026-10-14T01:03:00Z'), { state: 'muted', until: '2026-10-15T01:03:00Z' });
    await store.tick(Date.parse('2026-10-15T01:03:01Z'), { state: 'away', until: null });
    assert.equal(delivered.length, 1, 'a held event older than 24 hours is not sent');
    await store.close();
  });

  test('a changed held turn is closed without delivering its old notice', async () => {
    const delivered: string[] = [];
    const send: PushSender = async (_device, payload) => { delivered.push(payload.title); return { status: 201 }; };
    const store = await PushStore.open(root, { subject: 'https://localhost', sender: send });
    await store.subscribe(subscription(), 'Phone');
    const review = { T2: userBall('review', 'L1', '2026-10-14T00:00:00Z') };
    const now = Date.parse('2026-10-14T00:00:00Z');
    await store.observe([], {}, defaultSettings());
    await store.observe([reviewTask('T2', 'L1')], review, defaultSettings(), now);
    await store.tick(now, { state: 'muted', until: new Date(now + 60_000).toISOString() });
    await store.observe([task('T2', 'done', [record('L2', '2026-10-14T00:00:00Z', 'done')])], {}, defaultSettings(), now + 60_000);
    await store.tick(now + 60_000, { state: 'away', until: null });
    assert.deepEqual(delivered, []);
    assert.ok(Object.values(pushFile().events[0]!.deliveries)[0]!.closed_at);
    await store.close();
  });

  test('a transition first found 25 hours after a restart is closed without a push', async () => {
    const delivered: string[] = [];
    const send: PushSender = async (_device, payload) => { delivered.push(payload.title); return { status: 201 }; };
    const happened = Date.parse('2026-10-14T00:00:00Z');
    let store = await PushStore.open(root, { subject: 'https://localhost', sender: send });
    await store.subscribe(subscription(), 'Phone');
    await store.observe([], {}, defaultSettings(), happened);
    await store.close();
    store = await PushStore.open(root, { subject: 'https://localhost', sender: send });
    const balls = { T2: userBall('review', 'L1', new Date(happened).toISOString()) };
    const found = happened + 25 * 60 * 60_000;
    await store.observe([reviewTask('T2', 'L1', new Date(happened).toISOString())], balls, defaultSettings(), found);
    await store.tick(found, { state: 'away', until: null });
    assert.deepEqual(delivered, []);
    assert.equal(pushFile().events[0]!.created_at, new Date(happened).toISOString());
    assert.ok(Object.values(pushFile().events[0]!.deliveries)[0]!.closed_at);
    await store.close();
  });

  test('different transition times combine into one Japanese push with the latest deadline', async () => {
    const delivered: { title: string; body: string; ttl: number }[] = [];
    const send: PushSender = async (_device, payload, options) => {
      delivered.push({ title: payload.title, body: payload.body, ttl: options.ttl });
      return { status: 201 };
    };
    const store = await PushStore.open(root, { subject: 'https://localhost', sender: send });
    await store.subscribe(subscription(), 'Phone');
    const waiting = (id: string, at: number) => reviewTask(id, `L${id}`, new Date(at).toISOString());
    const old = Date.parse('2026-10-14T00:00:00Z');
    const fresh = old + 24 * 60 * 60_000 - 60_000;
    // Each ball came to the user when its Task went to review: the push's time is the ball's.
    const balls = (ids: string[]) => Object.fromEntries(ids.map(id =>
      [id, userBall('review', `L${id}`, new Date(id === 'T2' ? old : fresh).toISOString())]));
    const settings = { ...defaultSettings(), language: 'ja' };
    await store.observe([], {}, settings);
    await store.observe([waiting('T2', old)], balls(['T2']), settings, old);
    await store.tick(old, { state: 'present', until: null });
    await store.observe([waiting('T2', old), waiting('T3', fresh)], balls(['T2', 'T3']), settings, fresh);
    await store.tick(fresh, { state: 'present', until: null });
    await store.tick(fresh + 30_000, { state: 'away', until: null }, null, 'ja');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.ttl, 86_370);
    assert.equal(delivered[0]!.title, '2件の知らせ');
    assert.equal(delivered[0]!.body, '確認待ち T2 Task T2\n確認待ち T3 Task T3');
    await store.close();
  });

  test('screen presence reports publish status and setting saves record the browser time zone', async () => {
    const app = await server();
    const base = new URL(app.url).origin;
    const initial = await (await fetch(base + '/api/workspace/live')).json() as { presence: { state: string } };
    assert.equal(initial.presence.state, 'away');
    const active = await post(base, '/api/presence', { screen: 'phone', seq: 1, touchSeq: 1, touchedAgo: 0, hiddenAgo: null });
    assert.equal(active.status, 200, JSON.stringify(active.json()));
    assert.equal((active.json() as { state: string }).state, 'present');
    assert.equal(((await (await fetch(base + '/api/workspace/live')).json()) as { presence: { state: string } }).presence.state, 'present');
    const away = await raw(base, '/api/presence/away', {}, 'POST');
    assert.equal(away.status, 200);
    assert.equal((away.json() as { state: string }).state, 'away');
    const current = await (await fetch(base + '/api/commands/settings/get')).json() as { revision: string };
    // A setting other than the daily quiet hours, so the one-hour pause below cannot run into them at any time of day.
    const changed = await post(base, '/api/commands/settings/set', { key: 'push.awayAfter', value: '10',
      timeZone: 'Asia/Tokyo', expectedRevision: current.revision }, saving());
    assert.equal(changed.status, 200);
    assert.equal((changed.json() as { values: Record<string, unknown> }).values['push.timeZone'], 'Asia/Tokyo');
    const absolute = await post(base, '/api/commands/settings/set', { key: 'push.mutedUntil',
      value: '2026-10-14T22:00:00.000Z', expectedRevision: (changed.json() as { revision: string }).revision }, saving());
    assert.equal(absolute.status, 400, 'clients cannot set the pause deadline directly');
    const quietBypass = await post(base, '/api/commands/settings/set', { key: 'push.quietResumedUntil',
      value: '2099-01-01T00:00:00.000Z', expectedRevision: (changed.json() as { revision: string }).revision }, saving());
    assert.equal(quietBypass.status, 400, 'clients cannot bypass daily quiet hours');
    const before = Date.now();
    const paused = await post(base, '/api/presence/pause', { duration: 'hour', timeZone: 'Asia/Tokyo' });
    assert.equal(paused.status, 200);
    const pauseStatus = paused.json() as { state: string; until: string };
    assert.equal(pauseStatus.state, 'muted');
    assert.ok(Date.parse(pauseStatus.until) >= before + 60 * 60_000);
    assert.ok(Date.parse(pauseStatus.until) <= Date.now() + 60 * 60_000);
    assert.equal(((await (await fetch(base + '/api/workspace/live')).json()) as
      { presence: { state: string } }).presence.state, 'muted');
    const savedPause = await (await fetch(base + '/api/commands/settings/get')).json() as
      { values: Record<string, unknown> };
    assert.equal(savedPause.values['push.mutedUntil'], pauseStatus.until);
    const resumed = await raw(base, '/api/presence/resume', {}, 'POST');
    assert.equal(resumed.status, 200);
    assert.equal((resumed.json() as { state: string }).state, 'away');
    assert.equal(((await (await fetch(base + '/api/commands/settings/get')).json()) as
      { values: Record<string, unknown> }).values['push.mutedUntil'], null);
    assert.equal((await post(base, '/api/presence/pause', { duration: 'invalid', timeZone: 'Asia/Tokyo' })).status, 400);
    assert.equal((await post(base, '/api/presence/pause', { duration: 'hour', timeZone: 'Invalid/Zone' })).status, 400);
  });

  test('the public host is accepted only with its https origin; manual notify route is absent', async () => {
    const app = await server('alpacawork.example.ts.net:8443');
    const base = new URL(app.url).origin;
    assert.equal(app.publicUrl, 'https://alpacawork.example.ts.net:8443/');
    const pub = { Host: 'alpacawork.example.ts.net:8443' };
    // A new workspace's page is its setup until that is finished.
    assert.equal((await raw(base, '/welcome', pub)).status, 200);
    assert.equal((await raw(base, '/api/workspace/live', pub)).status, 200);
    assert.equal((await raw(base, '/api/workspace/live', { ...pub, Origin: 'https://alpacawork.example.ts.net:8443' })).status, 200);
    assert.equal((await raw(base, '/api/workspace/live', { ...pub, Origin: 'http://alpacawork.example.ts.net:8443' })).status, 403);
    assert.equal((await raw(base, '/api/workspace/live', { Host: 'other.example.ts.net:8443' })).status, 403);
    assert.equal((await raw(base, '/api/workspace/live', { Host: 'alpacawork.example.ts.net' })).status, 403);
    // Loopback keeps its http origin.
    assert.equal((await raw(base, '/api/workspace/live', { Host: `127.0.0.1:${new URL(base).port}`, Origin: base })).status, 200);
    assert.equal((await raw(base, '/api/workspace/live', { Host: `127.0.0.1:${new URL(base).port}`, Origin: 'https://alpacawork.example.ts.net:8443' })).status, 403);
    // The PWA files are served, with the manifest allowed by CSP.
    for (const [path, type] of [['/manifest.webmanifest', 'application/manifest+json'], ['/sw.js', 'text/javascript'], ['/icons/icon-192-2c.png', 'image/png']]) {
      const response = await raw(base, path, pub);
      assert.equal(response.status, 200, path);
      assert.ok(String(response.headers['content-type']).startsWith(type!), path);
      assert.ok(String(response.headers['content-security-policy']).includes("manifest-src 'self'"));
    }
    assert.equal((await post(base, '/api/notify/send', { title: 'x', body: 'y' }, pub)).status, 404);
    assert.equal((await post(base, '/api/notify/send', { title: 'x', body: 'y' })).status, 404);
    // Without a public host, no public name is accepted at all.
    await app.close();
    const plain = await server();
    assert.equal((await raw(new URL(plain.url).origin, '/api/workspace/live', pub)).status, 403);
    assert.equal(plain.publicUrl, undefined);
    await plain.close();
    await assert.rejects(startServer(root, 0, { publicHost: 'Bad Host', pushSender: sender }), /public-host/);
  });

  test('the installed app name and launch colors come from workspace settings, the saved theme and CSS', async () => {
    const app = await server();
    const base = new URL(app.url).origin;
    const colors = JSON.parse(readFileSync(join(import.meta.dirname, '../apps/backend/public/pwa-colors.json'), 'utf8')) as { light: string; dark: string };
    const initial = await (await fetch(base + '/manifest.webmanifest')).json() as Record<string, unknown>;
    // The app takes the title of a workspace's only project: setup names it Sample Project.
    assert.equal(initial.name, 'Sample Project');
    assert.equal(initial.short_name, initial.name);
    assert.equal(initial.theme_color, colors.light);
    assert.equal(initial.background_color, colors.light);
    assert.equal(initial.display, 'standalone');
    assert.deepEqual((initial.icons as { purpose: string }[]).map(icon => icon.purpose), ['any', 'any', 'maskable']);

    const control = new ControlStore(root);
    try { control.write(db => db.prepare("UPDATE tasks SET title=? WHERE kind='project' AND parent_id IS NULL").run('North & South <Work>')); }
    finally { control.close(); }
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /<title>alpacawork<\/title>/);
    assert.match(html, /name="apple-mobile-web-app-title" content="North &amp; South &lt;Work&gt;"/);
    assert.match(html, new RegExp(`name="theme-color" media="\\(prefers-color-scheme: dark\\)" content="${colors.dark}"`));
    // The installed app keeps the manifest's colours, so they follow the saved theme, not one visit's choice.
    const settings = createPersonSettings(root);
    await settings.set('theme', 'dark', (await settings.get()).revision);
    const dark = await (await fetch(base + '/manifest.webmanifest')).json() as Record<string, unknown>;
    assert.equal(dark.name, 'North & South <Work>');
    assert.equal(dark.short_name, dark.name);
    assert.equal(dark.theme_color, colors.dark);
    assert.equal(dark.background_color, colors.dark);
    // An old page's per-visit address no longer picks the colour.
    const stale = await (await fetch(base + '/manifest.webmanifest?theme=light')).json() as Record<string, unknown>;
    assert.equal(stale.theme_color, colors.dark);

    const renamed = new ControlStore(root);
    try { renamed.write(db => db.prepare("UPDATE tasks SET title=? WHERE kind='project' AND parent_id IS NULL").run('Team __PWA_LIGHT__')); }
    finally { renamed.close(); }
    const literal = await (await fetch(base + '/')).text();
    assert.match(literal, /<title>alpacawork<\/title>/);
    assert.match(literal, /name="apple-mobile-web-app-title" content="Team __PWA_LIGHT__"/);
  });

  test('subscriptions: key, register, list, refuse unknown endpoints, remove', async () => {
    const app = await server();
    const base = new URL(app.url).origin;
    const key = await (await fetch(base + '/api/notify/key')).json() as { key: string };
    assert.match(key.key, /^[A-Za-z0-9_-]{87}$/);
    assert.equal((await post(base, '/api/notify/subscribe', { subscription: subscription('https://evil.example/x'), label: 'Bad' })).status, 400);
    const one = await post(base, '/api/notify/subscribe', { subscription: subscription(), label: 'Chrome · Android' });
    assert.equal(one.status, 200);
    const { id } = one.json() as { id: string };
    assert.match(id, /^[0-9a-f]{16}$/);
    // The same endpoint again keeps one row and its first registration time.
    assert.equal((await post(base, '/api/notify/subscribe', { subscription: subscription(), label: 'Chrome · Android (2)' })).status, 200);
    await post(base, '/api/notify/subscribe', { subscription: subscription(APNS), label: 'Safari · Mac' });
    const list = await (await fetch(base + '/api/notify/devices')).json() as { devices: { id: string; label: string; endpoint: string }[] };
    assert.deepEqual(list.devices.map(d => [d.label, d.endpoint]), [['Chrome · Android (2)', FCM], ['Safari · Mac', APNS]]);
    assert.deepEqual((await post(base, '/api/notify/unsubscribe', { id })).json(), { removed: true });
    assert.deepEqual((await post(base, '/api/notify/unsubscribe', { id })).json(), { removed: false });
    assert.equal(((await (await fetch(base + '/api/notify/devices')).json()) as { devices: unknown[] }).devices.length, 1);
    const file = JSON.parse(readFileSync(join(root, '.alpacawork', 'push.json'), 'utf8'));
    assert.equal(file.vapid.publicKey, key.key);
  });

});
