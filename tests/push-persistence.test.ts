/** Push persistence through the same observation, device and delivery boundaries serve uses. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { defaultSettings, type Ball } from '@alpacawork/contract';
import { holdingKeys, PushStore, type Derived, type PushFileWriter, type PushSender } from '@alpacawork/backend/test-dist/receiver/push.js';

type Task = Parameters<typeof holdingKeys>[0][number];
const at = '2026-10-14T00:00:00Z', now = Date.parse(at);
const settings = defaultSettings();
const off = { ...settings, 'push.review': false };
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/device', keys: { p256dh: 'key', auth: 'auth' } };
const task = (id: string, state: Task['state'] = 'waiting', parentId = 'P1'): Task => ({
  id, kind: 'task', parentId, title: id, state, lifecycle: 'active', userRequested: true,
  log: [{ id: `L${id}`, kind: 'reported', at, title: null, description: null, actor: { kind: 'human' }, fromState: null, toState: state }],
});
const ball = (key: string): Ball => ({ holder: 'user', reason: 'review', key, at, questionId: null, aboutRunId: 'R1', count: null, code: null, failure: null });
const changed = (id: string, key: string) => new Map([[id, holdingKeys([task(id)], { [id]: ball(key) })]]);
const removed = (id: string) => new Map([[id, new Map()]]);
const hostEvent: Derived = { key: 'host:1', payload: { title: 'Host', body: 'Tight', url: '/', tag: 'host:1' }, urgency: 'high', occurredAt: at };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Snapshot = { seen: string[]; subscriptions: { id: string }[]; events: { key: string; pending: boolean; deliveries: Record<string, { sent_at?: string }> }[] };
async function fixture(t: TestContext, sender?: PushSender) {
  const root = await mkdtemp(join(tmpdir(), 'push-persistence-'));
  await mkdir(join(root, '.alpacawork'));
  const path = join(root, '.alpacawork/push.json');
  const started: Snapshot[] = [];
  const logs: string[] = [];
  let active = 0, maxActive = 0, fail = false;
  let gate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const writer: PushFileWriter = async (file, contents) => {
    active++; maxActive = Math.max(maxActive, active);
    started.push(JSON.parse(contents) as Snapshot);
    const current = gate; gate = undefined;
    try {
      if (current) { current.entered.resolve(); await current.release.promise; }
      if (fail) { fail = false; throw new Error('Disk unavailable'); }
      await writeFile(file, contents);
    } finally { active--; }
  };
  const store = await PushStore.open(root, { subject: 'https://localhost', sender, writer, log: line => logs.push(line) });
  t.after(async () => { try { await store.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  return {
    root, store, started, logs, read: async () => JSON.parse(await readFile(path, 'utf8')) as Snapshot,
    maxActive: () => maxActive,
    failNext: () => { fail = true; },
    blockNext: () => {
      const current = { entered: deferred(), release: deferred() }; gate = current;
      return current;
    },
  };
}

test('seen-only changes share the first one-second deadline and persist just the current keys', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.store.observeChanged(new Map(), off, now);
  for (let index = 0; index < 100; index++) await f.store.observeChanged(changed('T2', `K${index}`), off, now);
  assert.equal(f.started.length, 1, 'holding changes do not save a complete file');
  t.mock.timers.tick(999);
  assert.equal(f.started.length, 1);
  const save = f.blockNext();
  t.mock.timers.tick(1);
  await save.entered.promise;
  save.release.resolve();
  await f.store.close();
  assert.equal(f.started.length, 2);
  assert.deepEqual((await f.read()).seen.sort(), ['T2:K99', 'tasks:initialized']);
  t.mock.timers.tick(10_000);
  assert.equal(f.started.length, 2, 'closing leaves no save timer');
});

test('changes received during a save are serialized into a later save and close flushes them', async t => {
  const f = await fixture(t);
  await f.store.observeChanged(new Map(), off, now);
  const save = f.blockNext();
  const registered = f.store.subscribe(subscription, 'Phone');
  await save.entered.promise;
  const changedDuringSave = f.store.observeChanged(changed('T2', 'K1'), off, now);
  let observed = false;
  void changedDuringSave.then(() => { observed = true; });
  await Promise.resolve();
  assert.equal(observed, false);
  save.release.resolve();
  await registered; await changedDuringSave;
  await f.store.close();
  assert.deepEqual((await f.read()).seen.sort(), ['T2:K1', 'tasks:initialized']);
  assert.equal(f.maxActive(), 1);
  assert.equal(f.started.length, 3);
});

test('device registration, removal and events resolve only after their save; sends wait for events and delivery saves', async t => {
  const delivered = deferred();
  let f: Awaited<ReturnType<typeof fixture>>;
  let sends = 0;
  f = await fixture(t, async () => {
    sends++;
    assert.equal((await f.read()).events[0]?.key, hostEvent.key);
    delivered.resolve();
    return { status: 201 };
  });
  let save = f.blockNext(), done = false;
  const registration = f.store.subscribe(subscription, 'Phone').then(value => { done = true; return value; });
  await save.entered.promise;
  assert.equal(done, false); assert.deepEqual(f.store.devices(), []);
  save.release.resolve(); const device = await registration;
  save = f.blockNext();
  const recording = f.store.record(hostEvent, now);
  await save.entered.promise;
  f.store.holdHost(hostEvent.key);
  const pass = f.store.tick(now);
  await Promise.resolve(); assert.equal(sends, 0);
  save.release.resolve(); await recording; await delivered.promise;
  await pass;
  assert.equal((await f.read()).events[0]?.deliveries[device.id]?.sent_at, at.replace('Z', '.000Z'));
  save = f.blockNext(); done = false;
  const removing = f.store.unsubscribe(device.id).then(value => { done = true; return value; });
  await save.entered.promise;
  assert.equal(done, false); assert.equal(f.store.devices().length, 1);
  save.release.resolve(); assert.deepEqual(await removing, { removed: true });
  assert.deepEqual((await f.read()).subscriptions, []);
  assert.equal(f.maxActive(), 1);
});

test('a failed event save is retryable and never marks its new key seen or sends it', async t => {
  let sends = 0;
  const f = await fixture(t, async () => { sends++; return { status: 201 }; });
  await f.store.subscribe(subscription, 'Phone');
  await f.store.observeChanged(new Map(), settings, now);
  f.failNext();
  await assert.rejects(f.store.observeChanged(changed('T2', 'K1'), settings, now), /Disk unavailable/);
  await f.store.tick(now);
  assert.equal(sends, 0);
  assert.deepEqual((await f.read()).events, []);
  assert.deepEqual((await f.store.observeChanged(changed('T2', 'K1'), settings, now)).map(event => event.key), ['T2:K1']);
  await f.store.tick(now);
  assert.equal(sends, 1);
});

test('incremental removal forgets only that task and parent lookup determines completion from the complete table', async t => {
  const f = await fixture(t);
  await f.store.observeChanged(new Map(), off, now);
  await f.store.observeChanged(changed('T2', 'K1'), off, now);
  await f.store.observeChanged(changed('T3', 'K2'), off, now);
  await f.store.observeChanged(removed('T2'), off, now);
  assert.deepEqual((await f.store.observeChanged(changed('T2', 'K1'), settings, now)).map(event => event.key), ['T2:K1']);
  assert.deepEqual(await f.store.observeChanged(changed('T3', 'K2'), settings, now), [], 'unchanged tasks stay seen');
  await f.store.observeChanged(removed('T2'), settings, now);
  await f.store.close();
  assert.deepEqual((await f.read()).seen.sort(), ['T3:K2', 'tasks:initialized']);
  const parent = task('T1', 'doing'), child = task('T4', 'done', 'T1');
  assert.deepEqual([...holdingKeys([child], {}, id => id === parent.id ? parent : undefined)], []);
  assert.deepEqual([...holdingKeys([child], {}, () => ({ kind: 'task', lifecycle: 'archived' })).keys()], ['T4:LT4']);
});


test('a failed delayed save stays dirty, reports the fault and is flushed on close', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.store.observeChanged(changed('T2', 'K1'), off, now);
  const save = f.blockNext(); f.failNext();
  t.mock.timers.tick(1000);
  await save.entered.promise;
  save.release.resolve();
  await f.store.close();
  assert.match(f.logs.join('\n'), /Push seen save failed:.*Disk unavailable/);
  assert.deepEqual((await f.read()).seen.sort(), ['T2:K1', 'tasks:initialized']);
  assert.equal(f.started.length, 3);
  t.mock.timers.tick(10_000);
  assert.equal(f.started.length, 3);
});
