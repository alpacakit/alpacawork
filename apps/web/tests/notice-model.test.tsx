import { useConnection } from '../src/data/connection';
import { seedNotices, fixtureReceipt } from './read-fixtures';
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { notify } from "../src/lib/notify";
import { NOTICE_VERSION, taskBaseline, taskEvents } from "../src/data/notice-model";
import { createNoticeStore } from "../src/data/notice-store";
import { queryClient } from "../src/data/query-client";
import { receiveFullIndex, indexKey, resources, startRequiredReadSession } from "../src/data/resources";
import { markRead, markVisibleRead, useReadStore } from "../src/state/read-store";
import { mapWorkspace } from "../src/data/map";

import { baselines, dto, indexOf, logEntry, rowOf, taskFixture, tree, userBall, PROJECT_TASK } from "./fixtures";
import { problemResponse } from "./problem";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(stop => stop()); });
function viewedStore() { const store = createNoticeStore(); cleanups.push(store.subscribe(() => {})); return store; }
function observeRequired() {
  fixtureReceipt(resources.personalSettings('/one').queryKey, { values: {}, revision: null });
  cleanups.push(startRequiredReadSession(queryClient));
}
const doc = dto({ id: "T5", path: "tasks/T5", title: "Task", log: [] });
/** The task's index row, with the document changed as given. */
const row = (changes: Partial<typeof doc> = {}) => rowOf({ ...doc, ...changes });
const task = row();
const reports = Array.from({ length: 10 }, (_, index) => logEntry({ id: `R${index}`, kind: "reported", at: "2026-09-23T10:00:00Z", title: `Report ${index}` }));
beforeEach(() => { vi.restoreAllMocks(); queryClient.clear(); receiveFullIndex(queryClient, indexOf(tree({ root: '/one' }))); useConnection.setState({ state: 'live', offline: false }); useReadStore.setState(useReadStore.getInitialState(), true); });

test("new tasks produce one creation plus the latest report, without other differences", () => {
  const current = row({ state: "done", log: [logEntry({ at: "2026-09-22T10:00:00Z", title: "Task created" }), ...reports] });
  const events = taskEvents([current], {});
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ id: "T5|created", kind: "created", at: "2026-09-22T10:00:00Z" });
  expect(events[1]).toMatchObject({ id: "T5|log|10", kind: "reported", line: "Report 9" });
});

test("body, state and ten reports are distinct facts with stable report IDs", () => {
  const baselines = { T5: taskBaseline(task) };
  const current = { ...doc, state: "done" as const, values: { notes: "Edited" }, log: reports };
  const events = taskEvents([rowOf(current)], baselines);
  expect(events).toHaveLength(3);
  expect(events.find((event) => event.kind === "state")).toMatchObject({ from: "doing", to: "done" });
  expect(events.filter((event) => event.kind === "body")).toHaveLength(1);
  expect(events.filter((event) => event.kind !== "reported").every((event) => event.at === undefined)).toBe(true);
  const replay = taskEvents([rowOf({ ...current, version: 20, state: "waiting" })], baselines);
  expect(replay.filter((event) => event.kind === "reported").map((event) => event.id))
    .toEqual(events.filter((event) => event.kind === "reported").map((event) => event.id));
});

test("unchanged tasks and shortened logs do not invent reports; only reports, responsibility, review and place changes count", () => {
  expect(taskEvents([task], { T5: taskBaseline(task) })).toEqual([]);
  expect(taskEvents([row({ log: reports.slice(0, 2) })], { T5: taskBaseline(row({ log: reports })) })).toEqual([]);
  const noticed = ["reported", "responsible_changed", "review_approved", "review_sent_back", "moved", "archived", "deleted", "restored"] as const;
  const log = [...(["created", "retitled"] as const), ...noticed].map((kind, index) => logEntry({ id: `K${index}`, kind, title: kind }));
  // The latest noticed entry stands for the news; a later retitle is not news.
  const events = taskEvents([row({ log })], { T5: taskBaseline(task) });
  expect(events.map((event) => event.kind === "reported" && event.line)).toEqual(["restored"]);
  expect(events.map((event) => event.id)).toEqual([`T5|log|${noticed.length + 1}`]);
  expect(taskEvents([row({ log: [...log, logEntry({ id: "K99", kind: "retitled" })] })], { T5: taskBaseline(task) })
    .map((event) => event.id)).toEqual([`T5|log|${noticed.length + 1}`]);
  expect(taskEvents([row({ log: log.slice(0, 2) })], { T5: taskBaseline(task) })).toEqual([]);
});

test("a turn is news by the key the row projects, compared as sent: no key is read from the ball", () => {
  const ball = userBall("review", "K-ball", "2026-10-02T01:00:00.000Z", { aboutRunId: "R1" });
  const baseline = { ...taskBaseline(task), turnKey: null };
  const projected = { ...task, ball, notice: { ...task.notice, turnKey: "K-row" } };
  expect(taskBaseline(projected).turnKey).toBe("K-row");
  expect(taskEvents([projected], { T5: baseline })).toMatchObject([{ id: "T5|turn|K-row", kind: "turn", at: "2026-10-02T01:00:00.000Z" }]);
  // The same key read again is no news; a ball the row projects no key for is none either.
  expect(taskEvents([projected], { T5: taskBaseline(projected) })).toEqual([]);
  expect(taskEvents([{ ...projected, notice: { ...task.notice, turnKey: null } }], { T5: baseline })).toEqual([]);
});

test("a question asked of the user is news by its asking record, and its turn by the row's key", () => {
  const asked = logEntry({ id: "Q1", kind: "asked", askedTo: null, at: "2026-10-02T01:00:00.000Z", title: "Which one?",
    description: "Choose one", actor: { kind: "placement", placementId: "P1" } });
  const value = tree({ tasks: [taskFixture({ ...doc, log: [asked],
    ball: userBall("question", "Q1", "2026-10-02T01:00:00.000Z", { questionId: "Q1" }) })] });
  const current = rowOf(value.tasks.find((each) => each.id === doc.id)!, value);
  expect(taskEvents([current], { T5: taskBaseline(task) })).toMatchObject([
    { id: "T5|turn|Q1", kind: "turn" }, { id: "T5|log|0", kind: "reported", line: "Which one?" }]);
  expect(taskEvents([current], { T5: taskBaseline(current) })).toEqual([]);
});

test('first server snapshot creates a checkpoint and two views share reads', async () => {
  let saved: import('../src/data/notice-model').NoticeSaved | null = null;
  let revision = 0;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/notices')) return new Response(JSON.stringify({ state: saved, revision: revision ? String(revision) : null }));
    const input = JSON.parse(String(init?.body));
    if (input.expectedRevision !== (revision ? String(revision) : null))
      return problemResponse('conflict');
    saved = input.state; revision++;
    return new Response(JSON.stringify({ state: saved, revision: String(revision) }));
  });
  observeRequired();
  const first = viewedStore();
  first.getState().receive('/one', [task], null);
  await vi.waitFor(() => expect(first.getState().status).toBe('ready'));
  expect(first.getState().checkpoint?.tasks["T5"]).toEqual(taskBaseline(task));
  const changed = row({ log: reports });
  expect(await first.getState().read(changed)).toBe(true);
  const second = viewedStore();
  second.getState().receive('/one', [changed], String(revision));
  await vi.waitFor(() => expect(second.getState().reads["T5"]).toEqual(taskBaseline(changed)));
  expect(fetcher).toHaveBeenCalled();
  fetcher.mockRestore();
});

test('concurrent reads merge after revision conflict, while stale undo cannot erase another view', async () => {
  let saved: import('../src/data/notice-model').NoticeSaved | null = null;
  let revision = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/notices')) return new Response(JSON.stringify({ state: saved, revision: revision ? String(revision) : null }));
    const input = JSON.parse(String(init?.body));
    if (input.expectedRevision !== (revision ? String(revision) : null))
      return problemResponse('conflict');
    saved = input.state; revision++;
    return new Response(JSON.stringify({ state: saved, revision: String(revision) }));
  });
  observeRequired();
  const a = viewedStore(), b = viewedStore();
  a.getState().receive('/one', [task], null);
  await vi.waitFor(() => expect(a.getState().status).toBe('ready'));
  b.getState().receive('/one', [task], String(revision));
  await vi.waitFor(() => expect(b.getState().status).toBe('ready'));
  expect(await a.getState().confirm([task])).toBe(true);
  expect(await b.getState().read(row({ values: { notes: 'changed' } }))).toBe(true);
  expect((saved as unknown as import('../src/data/notice-model').NoticeSaved).reads["T5"]?.body).toBe(taskBaseline(row({ values: { notes: 'changed' } })).body);
  expect(await a.getState().undoAllRead()).toBe(false);
  expect((saved as unknown as import('../src/data/notice-model').NoticeSaved).reads["T5"]).toBeDefined();
});

test('an initializing checkpoint does not admit an opening read during its first revision change', async () => {
  const snapshot = indexOf(tree({ root: '/synthetic', tasks: [{ ...doc, log: reports }] }));
  receiveFullIndex(queryClient, { ...snapshot, person: { ...snapshot.person, notices: null } });
  fixtureReceipt(resources.notices('/synthetic').queryKey, { state: null, revision: null,
    initialBaselines: { T5: taskBaseline(task) } });
  useReadStore.setState({ root: '/synthetic', status: 'ready', serverRevision: null, tasks: [task] });
  const notice = vi.spyOn(notify, 'error'), fetcher = vi.spyOn(globalThis, 'fetch');
  const reading = markRead(task.id);
  // The initial save publishes its new revision before a queued read can run.
  receiveFullIndex(queryClient, { ...snapshot, person: { ...snapshot.person, notices: 'initialized' } });
  await reading;
  expect(notice).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

for (const [caller, language] of [['open', 'en'], ['visible', 'ja']] as const) test(`a refused ${caller} read tells the reader honestly in ${language} even when the checkpoint can be reloaded`, async () => {
  startI18n(); await i18n.changeLanguage(language);
  const state = { version: NOTICE_VERSION, checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task) } }, reads: {} };
  seedNotices(useReadStore, { root: '/synthetic', status: 'ready', revision: 'r1',
    checkpoint: state.checkpoint, reads: {}, tasks: [task] });
  // The task has news since the checkpoint, so reading it needs a save.
  const snapshot = indexOf(tree({ root: '/synthetic', tasks: [{ ...doc, log: reports }] }));
  receiveFullIndex(queryClient, { ...snapshot, person: { ...snapshot.person, notices: 'r1' } });
  const notice = vi.spyOn(notify, 'error');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/notices/save')
    ? problemResponse('unavailable')
    : new Response(JSON.stringify({ state, revision: 'r1' })));
  if (caller === 'open') await markRead(task.id);
  else { markVisibleRead(task.id); await vi.waitFor(() => expect(notice).toHaveBeenCalled()); }
  expect(useReadStore.getState().status).toBe('ready');
  expect(useReadStore.getState().reads).toEqual({});
  expect(notice).toHaveBeenCalledWith(language === 'ja' ? '既読にできませんでした。再読み込みして確認してください。' : 'Could not mark as read. Reload to check.', { id: 'read-failed' });
  await i18n.changeLanguage('en');
});

test('opening a task that is already read saves nothing; a changed one saves once', async () => {
  const state = { version: NOTICE_VERSION, checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task) } }, reads: {} };
  seedNotices(useReadStore, { root: '/synthetic', status: 'ready', revision: 'r1', checkpoint: state.checkpoint, reads: {}, tasks: [task] });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    new Response(JSON.stringify({ state: JSON.parse(String(init?.body)).state, revision: 'r2' })));
  expect(await useReadStore.getState().read(task)).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  const changed = row({ log: reports });
  expect(await useReadStore.getState().read(changed)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await useReadStore.getState().read(changed)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

for (const action of ['read', 'readMany'] as const) {
  for (const source of [action === 'read' ? 'checkpoint' : 'reads'] as const) {
    test(`${action} saves turn-only news from ${source} once, then revisits and turn removal save nothing`, async () => {
      const current = { ...task, notice: { ...task.notice, turnKey: 'RET-current' } };
      const baseline = { ...taskBaseline(current), turnKey: null };
      const store = createNoticeStore();
      seedNotices(store, { root: '/synthetic', status: 'ready', revision: 'r1', tasks: [current],
        checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: { [task.id]: baseline } },
        reads: source === 'reads' ? { [task.id]: baseline } : {} });
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
        new Response(JSON.stringify({ state: JSON.parse(String(init?.body)).state, revision: 'r2' })));
      const read = (value: typeof task) => action === 'read' ? store.getState().read(value) : store.getState().readMany([value]);
      expect(taskEvents([current], { [task.id]: baseline }).map(event => event.kind)).toEqual(['turn']);
      expect(await read(current)).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(store.getState().reads[task.id]?.turnKey).toBe('RET-current');
      expect(taskEvents([current], store.getState().reads)).toEqual([]);
      expect(await read(current)).toBe(true);
      const removed = { ...current, notice: { ...current.notice, turnKey: null } };
      expect(taskEvents([removed], store.getState().reads)).toEqual([]);
      expect(await read(removed)).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  }

  test(`${action} uses the same news as the display for body, state, reports and unnotified log growth`, async () => {
    const store = createNoticeStore();
    seedNotices(store, { root: '/synthetic', status: 'ready', revision: 'r1', tasks: [task],
      checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: { [task.id]: taskBaseline(task) } } });
    let revision = 1;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      new Response(JSON.stringify({ state: JSON.parse(String(init?.body)).state, revision: `r${++revision}` })));
    const changes = [row({ values: { notes: 'changed' } }), row({ values: { notes: 'changed' }, state: 'waiting' }),
      row({ values: { notes: 'changed' }, state: 'waiting', log: reports })];
    for (const [index, current] of changes.entries()) {
      const before = { ...store.getState().checkpoint?.tasks, ...store.getState().reads };
      expect(taskEvents([current], before).map(event => event.kind)).toEqual([['body'], ['state'], ['reported']][index]);
      expect(await (action === 'read' ? store.getState().read(current) : store.getState().readMany([current]))).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(index + 1);
      expect(taskEvents([current], store.getState().reads)).toEqual([]);
    }
    const quiet = row({ values: { notes: 'changed' }, state: 'waiting', log: [...reports, logEntry({ kind: 'retitled' })] });
    expect(taskEvents([quiet], store.getState().reads)).toEqual([]);
    expect(await (action === 'read' ? store.getState().read(quiet) : store.getState().readMany([quiet]))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test(`${action} recovers a turn-only save conflict without erasing another task's read`, async () => {
    const current = { ...task, notice: { ...task.notice, turnKey: 'RET-current' } };
    let saved = { version: NOTICE_VERSION, checkpoint: { at: '2026-10-02T00:00:00.000Z',
      tasks: { [task.id]: taskBaseline(task) } }, reads: {} as Record<string, ReturnType<typeof taskBaseline>> };
    const store = createNoticeStore();
    seedNotices(store, { root: '/synthetic', status: 'ready', revision: 'r1', checkpoint: saved.checkpoint, tasks: [current] });
    const other = { ...task, id: 'T6' };
    saved = { ...saved, reads: { [other.id]: taskBaseline(other) } };
    let revision = 'r2';
    const attempts: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/notices')) return new Response(JSON.stringify({ state: saved, revision }));
      const input = JSON.parse(String(init?.body));
      attempts.push(input.expectedRevision);
      if (input.expectedRevision !== revision) return problemResponse('conflict');
      saved = input.state; revision = 'r3';
      return new Response(JSON.stringify({ state: saved, revision }));
    });
    expect(await (action === 'read' ? store.getState().read(current) : store.getState().readMany([current, other]))).toBe(true);
    expect(attempts).toEqual(['r1', 'r2']);
    expect(saved.reads[other.id]).toEqual(taskBaseline(other));
    expect(saved.reads[task.id]).toEqual(taskBaseline(current));
    expect(taskEvents([current, other], saved.reads)).toEqual([]);
  });
}

test('a reload that finds the same revision leaves the store untouched', async () => {
  const state = { version: NOTICE_VERSION, checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task) } }, reads: {} };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ state, revision: 'r1' })));
  observeRequired();
  const store = viewedStore();
  store.getState().receive('/one', [task], 'r1');
  await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
  const before = store.getState();
  await store.getState().reload();
  store.getState().receive('/one', [task], 'r1');
  // Query proof/fetch-status notifications are observable; identical notice values retain their identity.
  expect(store.getState().checkpoint).toBe(before.checkpoint);
  expect(store.getState().reads).toBe(before.reads);
  expect(store.getState().checkpoint).toEqual(state.checkpoint);
  expect(store.getState().reads).toEqual(state.reads);
});

test('a new server notice revision fetches once; repeated metadata does not poll', async () => {
  const state = { version: NOTICE_VERSION, checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task) } }, reads: {} };
  let revision = 'r1';
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ state, revision })));
  observeRequired();
  const store = viewedStore();
  store.getState().receive('/one', [task], revision);
  await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
  expect(fetcher).toHaveBeenCalledTimes(1);
  store.getState().receive('/one', [task], revision);
  expect(fetcher).toHaveBeenCalledTimes(1);
  revision = 'r2';
  receiveFullIndex(queryClient, { ...queryClient.getQueryData<import('@alpacawork/contract/control').ProjectedIndexDTO>(indexKey)!, person: { settings: null, notices: revision, coordinator: { id: 'conversation-1', revision: '0'.repeat(64) } } });
  store.getState().receive('/one', [task], revision);
  await vi.waitFor(() => expect(store.getState().revision).toBe('r2'));
  expect(fetcher).toHaveBeenCalledTimes(2);
  store.getState().receive('/one', [task], revision);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("retained unreadable tasks do not invent current notices", () => {
  const mapped = mapWorkspace({ ...indexOf(tree({ tasks: [dto({ state: "waiting" })] })), staleIds: ["T1"],
    errors: [{ code: "invalid_yaml", path: "tasks/T1", message: "Invalid" }] }, baselines());
  expect(mapped.tasks.map(task => task.id)).toEqual(["T1", PROJECT_TASK]);
  expect(mapped.tasks[0]?.change).toBeNull();
  expect(mapped.readIds.has("T1")).toBe(true);
  expect(mapped.events).toEqual([]);
});

test("a retitle is no notice: the read baseline is unchanged", () => {
  const before = dto({ log: [logEntry({ at: "2026-09-24T09:00:00Z" })] });
  const baseline = baselines([before]);
  const retitled = { ...before, title: "After", log: [...before.log, logEntry({ id: "L2", kind: "retitled", at: "2026-09-24T10:30:00Z", title: 'Title changed from "Task one" to "After"' })] };
  const mapped = mapWorkspace(indexOf(tree({ tasks: [retitled] })), baseline);
  expect(mapped.tasks[0]?.change).toBeNull();
  expect(mapped.readIds.has("T1")).toBe(true);
});

for (const caller of ['open', 'visible'] as const) test(`${caller}: a committed read overtaken by a newer revision is not a failure`, async () => {
  const state = { version: NOTICE_VERSION, checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task) } }, reads: {} };
  seedNotices(useReadStore, { root: '/synthetic', status: 'ready', revision: 'r1', checkpoint: state.checkpoint, tasks: [task] });
  const snapshot = indexOf(tree({ root: '/synthetic', tasks: [{ ...doc, log: reports }] }));
  receiveFullIndex(queryClient, { ...snapshot, person: { ...snapshot.person, notices: 'r1' } });
  const notice = vi.spyOn(notify, 'error');
  let saved = { state, revision: 'r1' };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/notices')) return new Response(JSON.stringify(saved));
    const receipt = { state: JSON.parse(String(init?.body)).state, revision: 'r2' };
    saved = { state: { ...receipt.state, reads: { ...receipt.state.reads, T6: taskBaseline(task) } }, revision: 'r3' };
    // A newer authoritative read is already visible when the older POST response arrives.
    receiveFullIndex(queryClient, { ...snapshot, rev: snapshot.rev + 1, person: { ...snapshot.person, notices: 'r3' } });
    fixtureReceipt(resources.notices('/synthetic').queryKey, saved);
    return new Response(JSON.stringify(receipt));
  });
  if (caller === 'open') await markRead(task.id);
  else { markVisibleRead(task.id); await vi.waitFor(() => expect(useReadStore.getState().reads.T5).toBeDefined()); }
  expect(taskEvents(snapshot.tasks.filter(each => each.id === task.id), { ...useReadStore.getState().checkpoint?.tasks, ...useReadStore.getState().reads })).toEqual([]);
  expect(notice).not.toHaveBeenCalled();
  expect(useReadStore.getState().status).toBe('ready');
});

test('a lost read response is confirmed by its effect even with another task read added', async () => {
  const store = createNoticeStore();
  const checkpoint = { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task) } };
  seedNotices(store, { root: '/synthetic', status: 'ready', revision: 'r1', checkpoint, tasks: [task] });
  const changed = row({ log: reports });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/save')) throw new TypeError('response lost');
    return new Response(JSON.stringify({ state: { version: NOTICE_VERSION, checkpoint,
      reads: { T5: taskBaseline(changed), T6: taskBaseline(task) } }, revision: 'r3' }));
  });
  expect(await store.getState().read(changed)).toBe(true);
});

for (const caller of ['open', 'visible'] as const) test(`${caller}: a queued read cancelled by a scope change is silent`, async () => {
  seedNotices(useReadStore, { root: '/synthetic', status: 'ready', revision: 'r1', tasks: [task] });
  const snapshot = indexOf(tree({ root: '/synthetic', tasks: [{ ...doc, log: reports }] }));
  receiveFullIndex(queryClient, { ...snapshot, person: { ...snapshot.person, notices: 'r1' } });
  const notice = vi.spyOn(notify, 'error'), fetcher = vi.spyOn(globalThis, 'fetch');
  if (caller === 'open') {
    const reading = markRead(task.id);
    receiveFullIndex(queryClient, indexOf(tree({ root: '/elsewhere' })));
    await reading;
  } else {
    markVisibleRead(task.id);
    receiveFullIndex(queryClient, indexOf(tree({ root: '/elsewhere' })));
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect(notice).not.toHaveBeenCalled();
});

test('a write and verification lost in transit stays unconfirmed, without a false failure toast', async () => {
  seedNotices(useReadStore, { root: '/synthetic', status: 'ready', revision: 'r1', tasks: [task] });
  const snapshot = indexOf(tree({ root: '/synthetic', tasks: [{ ...doc, log: reports }] }));
  receiveFullIndex(queryClient, { ...snapshot, person: { ...snapshot.person, notices: 'r1' } });
  const notice = vi.spyOn(notify, 'error');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connection lost'));
  await markRead(task.id);
  expect(await useReadStore.getState().read(snapshot.tasks.find(each => each.id === task.id)!)).toBe('unconfirmed');
  expect(notice).not.toHaveBeenCalled();
});

for (const recovery of ['read', 'scope'] as const) test(`a real read failure toast is retired after ${recovery} recovery`, async () => {
  const { useToasts } = await import('../src/lib/notify');
  const state = { version: NOTICE_VERSION, checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task) } }, reads: {} };
  seedNotices(useReadStore, { root: '/synthetic', status: 'ready', revision: 'r1', checkpoint: state.checkpoint, tasks: [task] });
  const snapshot = indexOf(tree({ root: '/synthetic', tasks: [{ ...doc, log: reports }] }));
  receiveFullIndex(queryClient, { ...snapshot, person: { ...snapshot.person, notices: 'r1' } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('/save')
    ? problemResponse('unavailable') : new Response(JSON.stringify({ state, revision: 'r1' })));
  await markRead(task.id);
  expect(useToasts.getState().toasts.some(toast => toast.id === 'read-failed')).toBe(true);
  if (recovery === 'scope') receiveFullIndex(queryClient, indexOf(tree({ root: '/elsewhere' })));
  else {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Response(JSON.stringify({ state: JSON.parse(String(init?.body)).state, revision: 'r2' })));
    await markRead(task.id);
  }
  await vi.waitFor(() => expect(useToasts.getState().toasts.some(toast => toast.id === 'read-failed')).toBe(false));
});


test('a managed notices GET cancelled after its checkpoint is retained is silent and leaves it ready', async () => {
  const store = viewedStore();
  seedNotices(store, { root: '/one', status: 'ready', revision: 'r1', tasks: [task] });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let started!: () => void;
  const fetched = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { started(); return new Promise<Response>(() => {}); });
  const loading = store.getState().reload();
  await fetched;
  await queryClient.cancelQueries({ queryKey: resources.notices('/one').queryKey, exact: true });
  await loading;
  expect(store.getState().status).toBe('ready');
  expect(store.getState().revision).toBe('r1');
  expect(errors).not.toHaveBeenCalled();
});

test('explicit reads project immediately through old receipts and roll back only their failed action', async () => {
  const first = row({ values: { notes: 'first change' } }), second = { ...row({ values: { notes: 'second change' } }), id: 'T6' };
  const store = viewedStore();
  const checkpoint = { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task), T6: taskBaseline(task) } };
  seedNotices(store, { root: '/synthetic', status: 'ready', revision: 'r1', checkpoint, reads: {}, tasks: [first, second] });
  const original = { version: NOTICE_VERSION, checkpoint, reads: {} };
  let release!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  let posts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      posts++;
      if (posts === 1) return held;
      return new Response(JSON.stringify({ state: JSON.parse(String(init.body)).state, revision: 'r3' }));
    }
    return new Response(JSON.stringify({ state: original, revision: 'r1' }));
  });
  const read = (value: typeof task) => store.getState().read(value);
  const a = read(first), b = read(second);
  const events = () => taskEvents([first, second], { ...store.getState().checkpoint?.tasks, ...store.getState().reads });
  // No microtask, save, or response has happened at this assertion.
  expect(events()).toEqual([]);
  await vi.waitFor(() => expect(posts).toBe(1));
  fixtureReceipt(resources.notices('/synthetic').queryKey, { state: original, revision: 'r1' });
  expect(events()).toEqual([]);
  // A confirmed missing effect retires A, while B remains projected until its own save.
  release(problemResponse('forbidden'));
  expect(await a).toBe(false);
  expect(events().map(event => event.task.id)).toEqual(['T5']);
  expect(await b).toBe(true);
  expect(store.getState().reads.T6).toEqual(taskBaseline(second));
  expect(store.getState().reads.T5).toBeUndefined();
});

test('pending reads stay projected during other-device conflict recovery and do not acknowledge later news or another generation', async () => {
  const first = row({ values: { notes: 'opened change' } }), other = { ...task, id: 'T6' };
  const store = viewedStore();
  const checkpoint = { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task) } };
  seedNotices(store, { root: '/synthetic', status: 'ready', revision: 'r1', checkpoint, reads: {}, tasks: [first] });
  let release!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  let posts = 0;
  const remote = { version: NOTICE_VERSION, checkpoint, reads: { T6: taskBaseline(other) } };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      if (++posts === 1) return problemResponse('conflict');
      return held;
    }
    return new Response(JSON.stringify({ state: remote, revision: 'r2' }));
  });
  const reading = store.getState().read(first);
  await vi.waitFor(() => expect(posts).toBe(2));
  expect(taskEvents([first], { ...store.getState().checkpoint?.tasks, ...store.getState().reads })).toEqual([]);
  expect(store.getState().reads.T6).toEqual(taskBaseline(other));
  const newer = row({ values: { notes: 'arrived after opening' } });
  expect(taskEvents([newer], { ...store.getState().checkpoint?.tasks, ...store.getState().reads }).map(event => event.kind)).toEqual(['body']);
  const index = queryClient.getQueryData<import('@alpacawork/contract/control').ProjectedIndexDTO>(indexKey)!;
  receiveFullIndex(queryClient, { ...index, generation: 'another-generation' });
  expect(store.getState().reads.T5).toBeUndefined();
  release(new Response(JSON.stringify({ state: { ...remote, reads: { ...remote.reads, T5: taskBaseline(first) } }, revision: 'r3' })));
  expect(await reading).toBe('cancelled');
  expect(store.getState().reads.T5).toBeUndefined();
});

for (const action of ['read', 'readMany'] as const) test(`${action} never regresses a newer read from another device, including a mixed batch`, async () => {
  const oldDoc = { ...doc, version: 2, values: { notes: 'opened' } }, newDoc = { ...doc, version: 3, values: { notes: 'later news' } };
  const old = rowOf(oldDoc), latest = rowOf(newDoc), other = { ...row({ values: { notes: 'other unread' } }), id: 'T6' };
  receiveFullIndex(queryClient, indexOf(tree({ root: '/synthetic', tasks: [oldDoc] })));
  const checkpoint = { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task), T6: taskBaseline(task) } };
  const store = viewedStore();
  seedNotices(store, { root: '/synthetic', status: 'ready', revision: 'r1', checkpoint, reads: {}, tasks: [old] });
  let release!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  let posts = 0;
  const remote = { version: NOTICE_VERSION, checkpoint, reads: { T5: taskBaseline(latest) } };
  let written = remote;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      if (++posts === 1) return held;
      written = JSON.parse(String(init.body)).state;
      return new Response(JSON.stringify({ state: written, revision: 'r3' }));
    }
    return new Response(JSON.stringify({ state: remote, revision: 'r2' }));
  });
  const reading = action === 'read' ? store.getState().read(old) : store.getState().readMany([old, other]);
  await vi.waitFor(() => expect(posts).toBe(1));
  const index = indexOf(tree({ root: '/synthetic', tasks: [newDoc] }));
  receiveFullIndex(queryClient, { ...index, person: { ...index.person, notices: 'r2' } });
  fixtureReceipt(resources.notices('/synthetic').queryKey, { state: remote, revision: 'r2' });
  expect(store.getState().reads.T5).toEqual(taskBaseline(latest));
  expect(taskEvents([latest], { ...store.getState().checkpoint?.tasks, ...store.getState().reads })).toEqual([]);
  release(problemResponse('conflict'));
  expect(await reading).toBe(true);
  expect(written.reads.T5).toEqual(taskBaseline(latest));
  expect(posts).toBe(action === 'read' ? 1 : 2);
  if (action === 'readMany') expect((written.reads as Record<string, unknown>).T6).toEqual(taskBaseline(other));
});

test('retained visible read marks share one owner and an explicit read clears them before its first microtask', async () => {
  const current = row({ values: { notes: 'visible news' } });
  const store = viewedStore();
  seedNotices(store, { root: '/synthetic', status: 'ready', revision: 'r1', tasks: [current],
    checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task) } }, reads: {} });
  receiveFullIndex(queryClient, { ...indexOf(tree({ root: '/synthetic', tasks: [{ ...doc, values: { notes: 'visible news' } }] })),
    person: { ...queryClient.getQueryData<import('@alpacawork/contract/control').ProjectedIndexDTO>(indexKey)!.person, notices: 'r1' } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    new Response(JSON.stringify({ state: JSON.parse(String(init?.body)).state, revision: 'r2' })));
  store.getState().hold(['T5']);
  expect([...store.getState().held]).toEqual(['T5']);
  await store.getState().readMany([current]);
  expect([...store.getState().held]).toEqual(['T5']);
  expect(taskEvents([current], { ...store.getState().checkpoint?.tasks, ...store.getState().reads })).toEqual([]);
  const reading = store.getState().read(current);
  expect([...store.getState().held]).toEqual([]);
  // A delayed visibility delivery cannot restore the same mark while the read is pending or already saved.
  store.getState().hold(['T5']);
  expect([...store.getState().held]).toEqual([]);
  expect(await reading).toBe(true);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

test('held marks cannot cross a generation or a root and do not acknowledge newer news', () => {
  const currentDoc = { ...doc, values: { notes: 'visible news' } }, current = rowOf(currentDoc);
  const store = viewedStore();
  receiveFullIndex(queryClient, indexOf(tree({ root: '/synthetic', tasks: [currentDoc] })));
  seedNotices(store, { root: '/synthetic', status: 'ready', revision: 'r1', tasks: [current],
    checkpoint: { at: '2026-10-02T00:00:00.000Z', tasks: { T5: taskBaseline(task) } }, reads: {} });
  store.getState().hold(['T5']);
  expect([...store.getState().held]).toEqual(['T5']);
  store.getState().release(['T5']);
  expect(taskEvents([row({ values: { notes: 'later news' } })], { ...store.getState().checkpoint?.tasks, ...store.getState().reads })).toHaveLength(1);
  store.getState().hold(['T5']);
  const index = queryClient.getQueryData<import('@alpacawork/contract/control').ProjectedIndexDTO>(indexKey)!;
  receiveFullIndex(queryClient, { ...index, generation: 'new-generation' });
  expect([...store.getState().held]).toEqual([]);
  store.getState().bind('/another');
  expect([...store.getState().held]).toEqual([]);
});
