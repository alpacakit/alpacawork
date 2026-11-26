/** Real IndexedDB boundary, without introducing a simulated database or another persistence implementation. */
import assert from 'node:assert/strict';
import { taskActionsOf, TASK_POLICY } from '@alpacawork/contract/task-policy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { projectedIndexSchema, controlTaskSchema, taskRowFields, taskProjectedViewSchema, taskViewRowSchema } from '@alpacawork/contract/control';
const task = controlTaskSchema.parse({ id: 'T11', parentId: 'P100', path: 'tasks/T11', kind: 'task', userRequested: false,
  lifecycle: 'active', title: 'Saved task', state: 'doing', baseState: 'doing', hold: false,
  allowedActions: taskActionsOf({ baseState: 'doing', hold: false, userRequested: false }), policyVersion: TASK_POLICY.version, version: 1, hash: 'a'.repeat(64), values: { notes: 'Saved body' }, log: [] });
const source = { generation: 'generation-a', sourcePv: 1 };
function viewRow(task) {
  const { usageBelow, runsBelow, ...own } = taskRowFields(task);
  return taskViewRowSchema.parse({ ...own, projectId: 'P100', ball: null, question: '', startOrder: null,
    notice: { ...own.notice, turnKey: null } });
}
const view = taskProjectedViewSchema.parse({ ...source, task, row: viewRow(task), ancestors: [], requestHeads: [], placements: [], runs: [],
  values: { values: { notes: 'Saved body' }, fields: ['notes'], from: null, context: '## 本文\nSaved body' }, reply: null,
  questions: [], userQuestions: [], userReviews: [], requestedByUser: null, conversations: { anew: 0, compacted: 0, cutTokens: null, changes: [] } });
const viewFor = task => ({ ...view, task, row: viewRow(task), ancestors: [] });
const index = projectedIndexSchema.parse({ ...source, requiredPv: { view: {}, history: {}, page: {}, search: {}, timeline: {} }, restoreId: 'initial', generation: 'generation-a', rev: 1, root: '/fixture', projectShelfVersion: 'b'.repeat(64), projects: [{ id: 'P100', title: 'Project', color: '#39659b', parentId: null, cwd: null, depth: 0, counts: { turn: 0, running: 0 } }],
  tasks: [{ ...taskRowFields(task), projectId: 'P100', rowFacts: { status: null, childrenRunning: 0, runningRuns: 0, warning: null, kind: null },
    notice: { ...taskRowFields(task).notice, turnKey: null }, movedAt: 0, ball: null, question: '', startOrder: null, usage: null }],
  placements: [], runs: [], home: [], profiles: [], attachmentBytes: 50 * 1024 * 1024,
  errors: [], writable: true, staleIds: [], person: { settings: 's1', notices: 'n1', coordinator: null },
  presence: { state: 'away', until: null }, host: null, coordinatorWork: null,
  counts: { children: {}, closed: {}, home: {}, tasks: {}, all: { turn: 0, running: 0 } } });
const catalog = { revision: 'b'.repeat(64), projects: [{ id: 'P200', title: 'Archived project', color: '#39659b', parentId: null, lifecycle: 'archived', hash: 'c'.repeat(64), shelf: { listed: false, shelvedBy: [{ id: 'P200', title: 'Archived project', color: '#39659b', hash: 'c'.repeat(64), lifecycle: 'archived' }], restoreTarget: { id: 'P200', title: 'Archived project', color: '#39659b', hash: 'c'.repeat(64) } } }] };
const notice = { state: { version: 4, checkpoint: { at: '2026-10-01T00:00:00Z', tasks: {} }, reads: {} }, revision: 'n1' };
const evidenceRoot = resolve(process.env.READ_PERSISTENCE_EVIDENCE_DIR ?? `.local/test-runs/native-format13-${Date.now()}`);
mkdirSync(evidenceRoot, { recursive: true });
const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port;
await new Promise(done => socket.close(done));
const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: resolve(import.meta.dirname, '../../..'), detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CHOKIDAR_USEPOLLING: '1', CHOKIDAR_INTERVAL: '1000' } });
const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
const ttl = setTimeout(kill, 14 * 60_000); let output = '', browser, passed = 0, caseContexts = [], caseDirectory;
child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
const base = `http://127.0.0.1:${port}`;
writeFileSync(`${evidenceRoot}/runtime.json`, JSON.stringify({ server: child.pid, parent: process.pid, node: process.execPath, version: process.version, cwd: process.cwd(), base, started: new Date().toISOString(), ttl: 14 * 60_000 }));
const cases = [];
try {
  await expect.poll(async () => { try { return (await fetch(base)).status; } catch { return 0; } }, { timeout: 10000 }).toBe(200);
  browser = await chromium.launch({ headless: true });
  const browserCDP = await browser.newBrowserCDPSession();
  writeFileSync(`${evidenceRoot}/browser-processes.json`, JSON.stringify(await browserCDP.send('SystemInfo.getProcessInfo')));
  await browserCDP.detach();
  async function context() {
    const context = await browser.newContext({ recordVideo: { dir: `${caseDirectory}/videos` } }); await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const http = [], httpEvents = [];
    context.on('request', request => http.push({ event: 'request', url: request.url(), method: request.method(), at: Date.now() }));
    context.on('response', response => httpEvents.push({ event: 'response', url: response.url(), status: response.status(), at: Date.now() }));
    context.on('requestfailed', request => httpEvents.push({ event: 'failed', url: request.url(), error: request.failure(), at: Date.now() }));
    caseContexts.push({ context, http, httpEvents }); return context;
  }
  async function pageIn(context) {
    const page = await context.newPage();
    await page.route('**/__read-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Native FORMAT14 boundary</body></html>' }));
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      const data = path === '/api/person/notices' ? notice : path === '/api/commands/settings/get' ? { values: { theme: 'dark' }, revision: 's1' }
        : path === '/api/task/view' ? view : path === '/api/task/history' ? { ...source, events: [], oldestKey: null, hasOlder: false, tasks: {} }
        : path === '/api/commands/project/shelf' ? catalog : path === '/api/workspace/live' ? index
        : { ...source, rows: [], total: 0, nextAfter: null };
      return route.fulfill({ json: data });
    });
    await page.goto(`${base}/__read-test`);
    await page.evaluate(async () => {
      const modules = await Promise.all(['read-persistence', 'resources', 'read-model', 'read-demand', 'query-client', 'connection', 'read-retention', 'read-json']
        .map(name => import(`/src/data/${name}.ts`)));
      window.s = Object.assign({}, ...modules);
      window.diskRaw = () => new Promise((resolve, reject) => {
        const request = indexedDB.open('alpacawork-read-checkpoint');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { const db = request.result, tx = db.transaction(['control', 'slots']);
          const control = tx.objectStore('control').get('current'), slots = tx.objectStore('slots').getAll();
          tx.oncomplete = () => { db.close(); resolve({ control: control.result, slots: slots.result }); }; tx.onabort = () => reject(tx.error); };
      });
      window.disk = async () => { const raw = await window.diskRaw(); return { ...raw, slots: raw.slots.map(({ payload, ...slot }) => ({ ...slot, query: { ...slot.query, state: { ...slot.query.state, data: payload === undefined ? slot.query.state.data : JSON.parse(payload) } } })) }; };
      window.snapshot = () => { const s = window.s; return { persistence: s.useReadPersistence.getState(), scope: s.readScope(s.queryClient),
        queries: s.queryClient.getQueryCache().getAll().map(q => ({ key: q.queryKey, data: q.state.data, status: q.state.status, fetchStatus: q.state.fetchStatus,
          error: q.state.error && { code: q.state.error.code, message: q.state.error.message, reason: q.state.error.reason },
          proof: s.getReadProof(q), source: s.readAcquisition(q)?.source, serial: s.readSerial(q), refusal: s.readRefusalSequence(q),
          pendingRefusal: s.hasPendingReadRefusal(q), assessment: s.assessRead(s.queryClient, q) })) }; };
    });
    return page;
  }
  async function boot(page) {
    return page.evaluate(async () => { const s = window.s, started = performance.now(); await s.restoreReadPersistence(s.queryClient);
      const subscribe = listener => s.onReadEvent(s.queryClient, listener);
      window.stopWriter = s.startReadPersistence(s.queryClient, subscribe);
      s.observeReadRefusals(s.queryClient); return performance.now() - started; });
  }
  const flush = page => page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const disk = page => page.evaluate(() => window.disk());
  const taskSlot = checkpoint => checkpoint.slots.find(slot => slot.key[0] === 'task' && slot.key[2] === 'T11');
  async function seed(page, source = index) {
    const before = (await disk(page)).control.revision;
    await page.evaluate(async index => { const s = window.s, c = s.queryClient; s.receiveFullIndex(c, index); s.useConnection.setState({ state: 'live', offline: false });
      await Promise.all([c.fetchQuery(s.resources.taskView(index.root, 'T11')), c.fetchQuery(s.resources.personalSettings(index.root)), c.fetchQuery(s.resources.notices(index.root)),
        c.fetchQuery(s.resources.history(index.root, 'T11')), c.fetchInfiniteQuery(s.resources.finished(index.root, null))]);
      window.dispatchEvent(new Event('pagehide')); }, source);
    await expect.poll(async () => (await disk(page)).control.revision).toBeGreaterThan(before);
    await expect.poll(() => page.evaluate(() => window.s.useReadPersistence.getState().status)).toBe('saved');
  }
  async function force(page, kind, id) {
    return page.evaluate(async ({ kind, id }) => { const s = window.s, index = s.readIndex(s.queryClient);
      const options = kind === 'task' ? s.resources.taskView(index.root, id ?? 'T11') : kind === 'history' ? s.resources.history(index.root, id ?? 'T11')
        : kind === 'settings' ? s.resources.personalSettings(index.root) : s.resources.notices(index.root);
      try { await s.queryClient.fetchQuery({ ...options, staleTime: 0 }); return 'success'; } catch (error) { return error.code ?? error.name; }
    }, { kind, id });
  }
  async function check(name, action) {
    if (process.argv[2] && !new RegExp(process.argv[2]).test(name)) return;
    caseDirectory = `${evidenceRoot}/${String(cases.length + 1).padStart(2, '0')}`; mkdirSync(caseDirectory); caseContexts = [];
    const result = { name, startedAt: new Date().toISOString(), node: process.version, fixture: { index, view, notice } };
    try { await action(); passed++; result.status = 'passed'; console.log(`PASS ${name}`); }
    catch (error) { result.status = 'failed'; result.error = error.stack; throw error; }
    finally {
      result.observations = [];
      for (const [n, { context, http, httpEvents }] of caseContexts.entries()) {
        const pages = [];
        for (const [p, page] of context.pages().entries()) {
          try { pages.push({ memory: await page.evaluate(() => window.snapshot()), disk: await disk(page) });
            await page.screenshot({ path: `${caseDirectory}/context-${n}-page-${p}.png` }); } catch (error) { pages.push({ error: String(error) }); }
          try { await page.evaluate(() => window.stopWriter?.()); } catch {}
        }
        result.observations.push({ pages, http, httpEvents });
        try { await context.tracing.stop({ path: `${caseDirectory}/context-${n}.zip` }); } finally { await context.close(); }
      }
      result.finishedAt = new Date().toISOString(); cases.push(result); writeFileSync(`${caseDirectory}/result.json`, JSON.stringify(result, null, 2));
    }
  }
  await check('project shelf catalog uses native checkpoint codec and byte budget without counting projects as Task details', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    await a.evaluate(async () => { const s = window.s; await s.queryClient.fetchQuery(s.resources.projectShelf('/fixture')); window.dispatchEvent(new Event('pagehide')); });
    await expect.poll(async () => (await disk(a)).slots.some(slot => slot.key[0] === 'project-shelf')).toBe(true);
    const original = await disk(a), held = original.slots.find(slot => slot.key[0] === 'project-shelf');
    assert.deepEqual(held.query.state.data, catalog); assert.equal(original.control.format, 14);
    assert.deepEqual(await a.evaluate(() => window.s.representedReadIds(['project-shelf', '/fixture'], window.s.queryClient.getQueryData(['project-shelf', '/fixture']))), []);
    await a.close(); const b = await pageIn(ctx); await boot(b);
    const state = await b.evaluate(() => { const s = window.s, q = s.readQuery(s.queryClient, ['project-shelf', '/fixture']); return { data: q.state.data, acquisition: s.readAcquisition(q).source, assessment: s.assessRead(s.queryClient, q) }; });
    assert.deepEqual(state.data, catalog); assert.equal(state.acquisition, 'checkpoint'); assert.equal(state.assessment.project, false);
  });
  await check('shelf change removes warmed Task facts before native checkpoint and after restart', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    await a.evaluate(() => { const s = window.s, index = s.readIndex(s.queryClient); s.receiveFullIndex(s.queryClient,
      { ...index, rev: index.rev + 1, projectShelfVersion: 'c'.repeat(64), projects: [], tasks: [], home: [] }); window.dispatchEvent(new Event('pagehide')); });
    await expect.poll(async () => (await disk(a)).slots.some(slot => slot.key[0] === 'task')).toBe(false);
    assert.deepEqual(await a.evaluate(() => window.s.displayReadFacts(window.s.queryClient)?.tasks ?? []), []);
    await a.close(); const b = await pageIn(ctx); await boot(b);
    assert.deepEqual(await b.evaluate(() => window.s.displayReadFacts(window.s.queryClient)?.tasks ?? []), []);
  });
  await check('actual GET and index-publication restore without GET or write authority and preserve acquisition time', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    const first = await disk(a); assert.equal(first.control.format, 14); assert.equal(taskSlot(first).query.queryType, undefined);
    assert.equal(first.slots.find(slot => slot.key[0] === 'task-history').query.queryType, undefined);
    const acquiredAt = taskSlot(first).acquiredAt; await a.close(); const b = await pageIn(ctx); const coldRestoreMs = await boot(b);
    const actual = await b.evaluate(() => { const s = window.s, q = s.readQuery(s.queryClient, ['task', '/fixture', 'T11']);
      return { body: q.state.data.task.values.notes, acquiredAt: s.getReadProof(q).acquiredAt, source: s.readAcquisition(q).source, live: !!s.liveRead(s.queryClient), write: s.canSendWrites() }; });
    assert.deepEqual(actual, { body: 'Saved body', acquiredAt, source: 'checkpoint', live: false, write: false });
    const warm = await b.evaluate(async () => { const s = window.s, client = new s.queryClient.constructor(), start = performance.now();
      await s.restoreReadPersistence(client); const elapsed = performance.now() - start, body = client.getQueryData(['task', '/fixture', 'T11'])?.task.values?.notes;
      const stop = s.startReadPersistence(client, listener => s.onReadEvent(client, listener)); stop(); client.clear(); return { elapsed, body }; });
    assert.equal(warm.body, view.task.values.notes); assert(coldRestoreMs < 500 && warm.elapsed < 500);
    writeFileSync(`${caseDirectory}/restore-observation.json`, JSON.stringify({ coldRestoreMs, warmRestoreMs: warm.elapsed, fixture: 'small synthetic native contract; not paired performance measurement' }));
    assert(caseContexts[0].http.every(row => row.method === 'GET'));
  });
  await check('read-only cold restore validates raw rows without changing durable records or their order', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    await a.evaluate(() => window.stopWriter());
    await a.evaluate(async () => {
      const raw = await window.diskRaw(), source = raw.slots.find(slot => slot.key[0] === 'task');
      const request = indexedDB.open('alpacawork-read-checkpoint', 3);
      await new Promise((resolve, reject) => { request.onerror = () => reject(request.error); request.onsuccess = () => {
        const db = request.result, tx = db.transaction('slots', 'readwrite'), store = tx.objectStore('slots');
        store.put({ ...source, hash: 'invalid-json', payload: '{broken' });
        store.put({ ...source, hash: 'invalid-metadata', extra: true });
        store.put({ ...source, hash: 'invalid-qualification', qualification: { ...source.qualification, proof: { ...source.qualification.proof, generation: 'foreign' } } });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      }; });
    });
    const before = await a.evaluate(() => window.diskRaw()); await a.close();
    const b = await pageIn(ctx);
    await b.evaluate(() => window.s.restoreReadPersistence(window.s.queryClient)); // No writer or follow-up save.
    const after = await b.evaluate(() => window.diskRaw());
    assert.deepEqual(after, before, 'reading disposable getAll snapshots must preserve all durable raw records in order');
    const restored = await b.evaluate(() => { const s = window.s, data = s.queryClient.getQueryData(['task', '/fixture', 'T11']);
      return { body: data?.task.values?.notes, source: s.readAcquisition(s.readQuery(s.queryClient, ['task', '/fixture', 'T11']))?.source,
        queries: s.queryClient.getQueryCache().getAll().map(query => query.queryHash) }; });
    assert.equal(restored.body, task.values.notes); assert.equal(restored.source, 'checkpoint');
    for (const hash of ['invalid-json', 'invalid-metadata', 'invalid-qualification']) assert(!restored.queries.includes(hash));
    writeFileSync(`${caseDirectory}/snapshot-isolation.json`, JSON.stringify({ before, after, restored }, null, 2));
  });
  await check('retired row output-age cache is discarded and the task is fetched with current row facts', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    await a.evaluate(async () => {
      window.stopWriter();
      const raw = await window.diskRaw(), source = raw.slots.find(slot => slot.key[0] === 'task');
      const data = JSON.parse(source.payload);
      data.resolved = { row: { rowFacts: { status: { kind: 'running', since: null, lastOutput: Date.now() } } }, ancestors: [] };
      const request = indexedDB.open('alpacawork-read-checkpoint', 3);
      await new Promise((resolve, reject) => { request.onerror = () => reject(request.error); request.onsuccess = () => {
        const db = request.result, tx = db.transaction('slots', 'readwrite');
        tx.objectStore('slots').put({ ...source, payload: JSON.stringify(data) });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      }; });
    });
    await a.close(); const b = await pageIn(ctx); await boot(b);
    assert.equal(await b.evaluate(() => window.s.queryClient.getQueryData(['task', '/fixture', 'T11'])), undefined);
    assert.equal(await force(b, 'task'), 'success');
    assert.deepEqual(await b.evaluate(() => { const data = window.s.queryClient.getQueryData(['task', '/fixture', 'T11']);
      return { body: data.task.values?.notes, hasRowFacts: Object.hasOwn(data.row, 'rowFacts') }; }), { body: task.values.notes, hasRowFacts: false });
  });
  for (const status of [403, 200]) await check(`F-A delayed basis 750ms retains unseen T11 with settings ${status}`, async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); const first = await disk(a); await a.close();
    const b = await pageIn(ctx);
    await b.evaluate(() => { const original = indexedDB.open.bind(indexedDB); indexedDB.open = (...args) => {
      const request = original(...args); let success;
      const proxy = new Proxy(request, { get(target, key) { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; },
        set(target, key, value) { if (key === 'onsuccess') { success = value; return true; } return Reflect.set(target, key, value, target); } });
      request.onsuccess = event => setTimeout(() => { indexedDB.open = original; success?.call(proxy, event); }, 750); return proxy;
    }; });
    const elapsed = await boot(b); assert(elapsed < 720 && elapsed >= 480, `restore duration ${elapsed}`);
    assert.equal(await b.evaluate(() => window.s.readIndex(window.s.queryClient)), undefined);
    if (status === 403) await b.route('**/api/commands/settings/get', route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Settings refused', retry: 'fix' } } }));
    await b.evaluate(async index => { const s = window.s, c = s.queryClient; s.receiveFullIndex(c, { ...index, rev: 3 });
      await Promise.allSettled([c.fetchQuery(s.resources.personalSettings(index.root)), c.fetchQuery(s.resources.notices(index.root))]); window.dispatchEvent(new Event('pagehide')); }, index);
    await expect.poll(async () => (await disk(b)).control.revision).toBeGreaterThan(first.control.revision);
    await b.waitForTimeout(300); const next = await disk(b);
    assert(taskSlot(next), 'held T11 slot must survive the later checkpoint');
    assert.equal(taskSlot(next).query.state.data.task.values?.notes, view.task.values?.notes); assert.equal(taskSlot(next).acquiredAt, taskSlot(first).acquiredAt);
    assert.equal(next.slots.some(slot => slot.key[0] === 'person-settings'), status === 200);
    await b.close(); const c = await pageIn(ctx); await boot(c);
    assert.equal(await c.evaluate(() => window.s.queryClient.getQueryData(['task', '/fixture', 'T11'])?.task.values?.notes), view.task.values?.notes);
    assert.equal(await c.evaluate(() => window.s.useReadPersistence.getState().status), status === 200 ? 'saved' : 'partial');
  });
  await check('ordinary settings and notices 503 preserve values and original times in an existing checkpoint', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); const before = await disk(a);
    for (const path of ['settings/get', 'person/notices']) await a.route(`**/api/${path}`, route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Temporarily unavailable', retry: 'later' } } }));
    assert.equal(await force(a, 'settings'), 'unavailable'); assert.equal(await force(a, 'notices'), 'unavailable'); await flush(a);
    await expect.poll(async () => (await disk(a)).control.revision).toBeGreaterThan(before.control.revision);
    const next = await disk(a);
    for (const kind of ['person-settings', 'person-notices']) {
      const first = before.slots.find(slot => slot.key[0] === kind), last = next.slots.find(slot => slot.key[0] === kind);
      assert.deepEqual(last.query.state.data, first.query.state.data); assert.equal(last.acquiredAt, first.acquiredAt); assert.equal(last.query.state.error, null);
    }
    assert(taskSlot(next), 'held T11 slot must survive the later checkpoint');
    assert.equal(taskSlot(next).query.state.data.task.values?.notes, view.task.values?.notes);
  });
  await check('first checkpoint waits for missing required reads but a refused required read permits only partial', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a);
    await a.route('**/api/commands/settings/get', route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'First missing', retry: 'later' } } }));
    await a.evaluate(async index => { const s = window.s, c = s.queryClient; s.receiveFullIndex(c, index);
      await Promise.allSettled([c.fetchQuery(s.resources.taskView(index.root, 'T11')), c.fetchQuery(s.resources.notices(index.root)), c.fetchQuery(s.resources.personalSettings(index.root))]); }, index);
    await flush(a); await a.waitForTimeout(350); assert.equal((await disk(a)).slots.length, 0);
    await a.route('**/api/commands/settings/get', route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Explicit refusal', retry: 'fix' } } }));
    assert.equal(await force(a, 'settings'), 'forbidden'); await flush(a);
    await expect.poll(() => a.evaluate(() => window.s.useReadPersistence.getState().status)).toBe('partial');
    assert(taskSlot(await disk(a))); assert.equal((await disk(a)).slots.some(slot => slot.key[0] === 'person-settings'), false);
  });
  await check('normal multi-tab saves preserve epoch and retain slots absent from this tab memory', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); const first = await disk(a);
    const b = await pageIn(ctx); await boot(b);
    await b.route('**/api/task/view?task=T12', route => route.fulfill({ json: viewFor({ ...task, id: 'T12', title: 'Other tab task' }) }));
    assert.equal(await force(b, 'task', 'T12'), 'success'); await flush(b);
    await expect.poll(async () => (await disk(b)).slots.some(slot => slot.key[2] === 'T12')).toBe(true);
    await flush(a); await a.waitForTimeout(350);
    const after = await disk(a); assert.equal(after.control.epoch, first.control.epoch); assert(after.slots.some(slot => slot.key[2] === 'T12'));
    assert.equal(taskSlot(after).acquiredAt, taskSlot(first).acquiredAt);
  });
  await check('held absence in the same epoch permits a lawful active inherited slot to be republished at its original time', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); const first = await disk(a);
    await a.evaluate(async () => { const request = indexedDB.open('alpacawork-read-checkpoint', 3); await new Promise((done, reject) => { request.onsuccess = () => {
      const db = request.result, tx = db.transaction('slots', 'readwrite'); tx.objectStore('slots').delete(JSON.stringify(['task', '/fixture', 'T11']));
      tx.oncomplete = () => { db.close(); done(); }; tx.onabort = () => reject(tx.error); }; }); });
    await flush(a); await expect.poll(async () => !!taskSlot(await disk(a))).toBe(true);
    const next = await disk(a); assert.equal(next.control.epoch, first.control.epoch); assert.equal(taskSlot(next).acquiredAt, taskSlot(first).acquiredAt);
  });
  await check('a different held slot wins over an inherited old tab and a new actual equal GET creates its own acquisition', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); const first = await disk(a);
    const b = await pageIn(ctx); await boot(b); assert.equal(await force(b, 'task'), 'success'); await flush(b);
    await expect.poll(async () => taskSlot(await disk(b)).acquisitionId !== taskSlot(first).acquisitionId).toBe(true);
    const fresh = taskSlot(await disk(b)); await flush(a); await a.waitForTimeout(350);
    const last = taskSlot(await disk(a)); assert.equal(last.slotId, fresh.slotId); assert.equal(last.acquiredAt, fresh.acquiredAt);
  });
  await check('CAS refusal commit terminates an older writer without adopting its new epoch or reviving a slot', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    const b = await pageIn(ctx); await boot(b);
    await a.route('**/api/task/view?task=T11', route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Revoked task', retry: 'fix' } } }));
    assert.equal(await force(a, 'task'), 'forbidden');
    await expect.poll(async () => !!taskSlot(await disk(a))).toBe(false);
    await flush(b); await expect.poll(() => b.evaluate(() => window.s.useReadPersistence.getState().status)).toBe('superseded');
    await b.evaluate(index => window.s.receiveFullIndex(window.s.queryClient, { ...index, rev: 3 }), index); await flush(b); await b.waitForTimeout(350);
    assert.equal(taskSlot(await disk(b)), undefined); assert.equal(await b.evaluate(() => window.s.useReadPersistence.getState().status), 'superseded');
    assert.equal(await b.evaluate(() => window.s.readScope(window.s.queryClient).anchored), false);
  });
  await check('a later local refusal during an earlier self commit follows the committed epoch and preserves the later pin', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    await a.route('**/api/task/view?task=T12', route => route.fulfill({ json: viewFor({ ...task, id: 'T12' }) }));
    await force(a, 'task', 'T12'); await flush(a); await expect.poll(async () => (await disk(a)).slots.some(slot => slot.key[2] === 'T12')).toBe(true);
    await a.evaluate(() => { const s = window.s, original = IDBDatabase.prototype.transaction; window.commitInterleaving = [];
      IDBDatabase.prototype.transaction = function(...args) {
        const tx = original.apply(this, args);
        if (args[1] === 'readwrite') {
          let complete;
          Object.defineProperty(tx, 'oncomplete', { set(fn) { complete = fn; }, get() { return complete; } });
          tx.addEventListener('complete', event => {
            if (!window.injectedRefusal) { window.injectedRefusal = true; const q = s.readQuery(s.queryClient, ['task', '/fixture', 'T12']);
              s.applyReadEvidence(s.queryClient, { kind: 'refused', query: q });
              window.commitInterleaving.push({ phase: 'later-refusal-before-owner-complete', serial: s.readRefusalSequence(q), pin: s.hasPendingReadRefusal(q) }); }
            complete?.call(tx, event);
          });
        }
        return tx;
      };
      const q = s.readQuery(s.queryClient, ['task', '/fixture', 'T11']); s.applyReadEvidence(s.queryClient, { kind: 'refused', query: q });
    });
    await expect.poll(async () => (await disk(a)).slots.filter(slot => slot.key[0] === 'task' || slot.key[0] === 'task-history').length).toBe(0);
    const state = await a.evaluate(() => ({ status: window.s.useReadPersistence.getState().status, interleaving: window.commitInterleaving,
      pins: window.s.queryClient.getQueryCache().getAll().filter(q => window.s.hasPendingReadRefusal(q)).length }));
    assert.equal(state.interleaving[0].pin, true); assert.equal(state.pins, 0); assert.notEqual(state.status, 'superseded');
    writeFileSync(`${caseDirectory}/interleaving.json`, JSON.stringify(state));
  });
  await check('1024 pending refusal sources stay pinned and source 1025 terminates before cutting and releases special pins', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    const result = await a.evaluate(() => { const s = window.s, c = s.queryClient;
      for (let n = 0; n < 1024; n++) { const q = c.getQueryCache().build(c, { queryKey: ['task', '/fixture', `Refusal-${n}`] }); s.applyReadEvidence(c, { kind: 'refused', query: q }); }
      const before = { status: s.useReadPersistence.getState().status, pins: c.getQueryCache().getAll().filter(q => s.hasPendingReadRefusal(q)).length, anchored: s.readScope(c).anchored };
      const extra = c.getQueryCache().build(c, { queryKey: ['task', '/fixture', 'Refusal-1025'] }); s.applyReadEvidence(c, { kind: 'refused', query: extra });
      return { before, after: { status: s.useReadPersistence.getState().status, error: s.useReadPersistence.getState().error,
        pins: c.getQueryCache().getAll().filter(q => s.hasPendingReadRefusal(q)).length, anchored: s.readScope(c).anchored } };
    });
    assert.equal(result.before.pins, 1024); assert.notEqual(result.before.status, 'unavailable'); assert.equal(result.before.anchored, true);
    assert.equal(result.after.pins, 0); assert.equal(result.after.status, 'unavailable'); assert.equal(result.after.anchored, false);
    writeFileSync(`${caseDirectory}/boundary.json`, JSON.stringify(result));
    const before = (await disk(a)).control.revision; await a.evaluate(index => window.s.receiveFullIndex(window.s.queryClient, { ...index, rev: 4 }), index); await flush(a); await a.waitForTimeout(350);
    assert.equal((await disk(a)).control.revision, before); assert.equal(await a.evaluate(() => window.s.useReadPersistence.getState().status), 'unavailable');
  });
  await check('pending refusal metadata accounts for the entire UTF8 JSON at 8MiB and rejects the next source', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    const result = await a.evaluate(() => { const s = window.s, c = s.queryClient, serial = s.readIssuedSequence() + 1;
      const size = rows => new TextEncoder().encode(JSON.stringify(rows)).byteLength;
      const base = { queryKey: ['task', '/fixture', ''], refusalSerial: serial, committedRefusalSerial: 0 };
      const id = 'x'.repeat(s.READ_MAX_PENDING_REFUSAL_BYTES - size([base]));
      const q = c.getQueryCache().build(c, { queryKey: ['task', '/fixture', id] }); s.applyReadEvidence(c, { kind: 'refused', query: q });
      const before = { status: s.useReadPersistence.getState().status, pin: s.hasPendingReadRefusal(q), bytes: size([{ ...base, queryKey: q.queryKey, refusalSerial: s.readRefusalSequence(q) }]) };
      const extra = c.getQueryCache().build(c, { queryKey: ['task', '/fixture', 'one-more'] }); s.applyReadEvidence(c, { kind: 'refused', query: extra });
      return { before, after: { status: s.useReadPersistence.getState().status, pin: s.hasPendingReadRefusal(q), anchored: s.readScope(c).anchored } };
    });
    assert.equal(result.before.bytes, 8 * 1024 * 1024); assert.equal(result.before.pin, true); assert.notEqual(result.before.status, 'unavailable');
    assert.equal(result.after.status, 'unavailable'); assert.equal(result.after.pin, false); assert.equal(result.after.anchored, false);
    writeFileSync(`${caseDirectory}/metadata-byte-boundary.json`, JSON.stringify(result));
  });
  await check('manual index data cannot create a checkpoint; actual index publication can', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a);
    await a.evaluate(async index => { const s = window.s, c = s.queryClient; c.setQueryData(['index'], index); s.recordReadProof(s.readQuery(c, ['index']), s.captureReadProof(index, ['index']));
      await Promise.all([c.fetchQuery(s.resources.personalSettings(index.root)), c.fetchQuery(s.resources.notices(index.root)), c.fetchQuery(s.resources.taskView(index.root, 'T11'))]); window.dispatchEvent(new Event('pagehide')); }, index);
    await a.waitForTimeout(350); assert.equal((await disk(a)).slots.length, 0);
    await a.evaluate(index => { window.s.receiveFullIndex(window.s.queryClient, index); window.dispatchEvent(new Event('pagehide')); }, index);
    await expect.poll(async () => !!taskSlot(await disk(a))).toBe(true);
  });
  await check('GET before delayed basis for an initially absent key cannot be saved until a later actual GET', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); await a.close(); const b = await pageIn(ctx);
    await b.route('**/api/task/view?task=T12', route => route.fulfill({ json: viewFor({ ...task, id: 'T12' }) }));
    await b.evaluate(() => { const original = indexedDB.open.bind(indexedDB); indexedDB.open = (...args) => {
      const request = original(...args); let success; const proxy = new Proxy(request, {
        get(target, key) { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; },
        set(target, key, value) { if (key === 'onsuccess') { success = value; return true; } return Reflect.set(target, key, value, target); } });
      request.onsuccess = event => setTimeout(() => { indexedDB.open = original; success?.call(proxy, event); }, 750); return proxy;
    }; });
    await boot(b);
    await b.evaluate(async index => { const s = window.s, c = s.queryClient; s.receiveFullIndex(c, { ...index, rev: 2 });
      await Promise.all([c.fetchQuery(s.resources.taskView(index.root, 'T12')), c.fetchQuery(s.resources.personalSettings(index.root)), c.fetchQuery(s.resources.notices(index.root))]); }, index);
    await b.waitForTimeout(600); await flush(b); await b.waitForTimeout(300);
    assert.equal((await disk(b)).slots.some(slot => slot.key[2] === 'T12'), false);
    assert.equal(await force(b, 'task', 'T12'), 'success'); await flush(b);
    await expect.poll(async () => (await disk(b)).slots.some(slot => slot.key[2] === 'T12')).toBe(true);
  });
  // A paused clock has no idle time: these checks fix the saves' due times, so a save takes the path of a browser
  // without requestIdleCallback.
  const withoutIdle = page => page.evaluate(() => { window.requestIdleCallback = undefined; window.cancelIdleCallback = undefined; });
  for (const immediate of [false, true]) await check(`native busy reservation waits on its absolute normal due time, immediate=${immediate}`, async () => {
    const ctx = await context(), a = await pageIn(ctx); await a.clock.install(); await a.clock.pauseAt(new Date()); await withoutIdle(a); await boot(a); await seed(a);
    await a.evaluate(index => {
      const transaction = IDBDatabase.prototype.transaction; window.writeStarts = [];
      IDBDatabase.prototype.transaction = function(...args) {
        const tx = transaction.apply(this, args);
        if (args[1] === 'readwrite') {
          window.writeStarts.push(performance.now());
          if (window.writeStarts.length === 1) Object.defineProperty(tx, 'oncomplete', { set(fn) { tx.addEventListener('complete', event => { window.releaseBusy = () => fn.call(tx, event); }); } });
        }
        return tx;
      };
      window.s.receiveFullIndex(window.s.queryClient, { ...index, rev: 2 });
    }, index);
    await a.clock.runFor(250); await expect.poll(() => a.evaluate(() => !!window.releaseBusy)).toBe(true);
    await a.evaluate(index => window.s.receiveFullIndex(window.s.queryClient, { ...index, rev: 3 }), index);
    if (immediate) await flush(a);
    await a.clock.runFor(100); await a.evaluate(() => window.releaseBusy());
    if (immediate) await expect.poll(() => a.evaluate(() => window.writeStarts.length)).toBe(2);
    else {
      await a.waitForTimeout(30); assert.equal(await a.evaluate(() => window.writeStarts.length), 1);
      await a.clock.runFor(149); assert.equal(await a.evaluate(() => window.writeStarts.length), 1);
      await a.clock.runFor(1); await expect.poll(() => a.evaluate(() => window.writeStarts.length)).toBe(2);
    }
    await expect.poll(async () => (await disk(a)).slots.find(slot => slot.key[0] === 'index').query.state.data.rev).toBe(3);
    await a.clock.runFor(1000); assert.equal(await a.evaluate(() => window.writeStarts.length), 2);
    writeFileSync(`${caseDirectory}/reservation.json`, JSON.stringify(await a.evaluate(() => window.writeStarts)));
  });
  await check('native expired normal reservation survives a busy transaction and stop suppresses its outstanding continuation', async () => {
    const ctx = await context(), a = await pageIn(ctx); await a.clock.install(); await a.clock.pauseAt(new Date()); await withoutIdle(a); await boot(a); await seed(a);
    await a.evaluate(index => { const transaction = IDBDatabase.prototype.transaction; window.writeStarts = [];
      IDBDatabase.prototype.transaction = function(...args) {
        const tx = transaction.apply(this, args);
        if (args[1] === 'readwrite') {
          window.writeStarts.push(performance.now());
          Object.defineProperty(tx, 'oncomplete', { set(fn) { tx.addEventListener('complete', event => { window.releaseBusy = () => fn.call(tx, event); window.completedWrites = (window.completedWrites ?? 0) + 1; }); } });
        }
        return tx;
      };
      window.s.receiveFullIndex(window.s.queryClient, { ...index, rev: 2 });
    }, index);
    await a.clock.runFor(250); await expect.poll(() => a.evaluate(() => window.completedWrites)).toBe(1);
    await a.evaluate(index => window.s.receiveFullIndex(window.s.queryClient, { ...index, rev: 3 }), index);
    await a.clock.runFor(300); assert.equal(await a.evaluate(() => window.writeStarts.length), 1);
    await a.evaluate(() => window.releaseBusy()); await expect.poll(() => a.evaluate(() => window.completedWrites)).toBe(2);
    await a.evaluate(index => { window.s.receiveFullIndex(window.s.queryClient, { ...index, rev: 4 }); window.stopWriter(); window.releaseBusy(); }, index);
    const state = await a.evaluate(() => window.s.useReadPersistence.getState());
    await a.clock.runFor(2000); assert.equal(await a.evaluate(() => window.writeStarts.length), 2);
    assert.deepEqual(await a.evaluate(() => window.s.useReadPersistence.getState()), state);
  });
  await check('native restore completed after versionchange cannot hydrate or revive its writer', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); await a.evaluate(() => window.stopWriter());
    const b = await pageIn(ctx);
    await b.evaluate(() => { const transaction = IDBDatabase.prototype.transaction; window.restoreWrites = 0;
      IDBDatabase.prototype.transaction = function(...args) {
        const tx = transaction.apply(this, args);
        if (args[1] === 'readwrite') { window.restoreWrites++;
          Object.defineProperty(tx, 'oncomplete', { set(fn) { tx.addEventListener('complete', event => { window.releaseRestore = () => fn.call(tx, event); }); } }); }
        return tx;
      };
      window.restoring = window.s.restoreReadPersistence(window.s.queryClient);
    });
    await expect.poll(() => b.evaluate(() => !!window.releaseRestore)).toBe(true);
    await a.evaluate(() => new Promise((done, reject) => { const request = indexedDB.open('alpacawork-read-checkpoint', 4); request.onerror = () => reject(request.error); request.onsuccess = () => { request.result.close(); done(); }; }));
    await b.evaluate(async () => { window.releaseRestore(); await window.restoring; });
    assert.equal(await b.evaluate(() => window.s.readIndex(window.s.queryClient)), undefined);
    assert.equal(await b.evaluate(() => window.s.useReadPersistence.getState().status), 'unavailable');
    assert.equal(await b.evaluate(() => window.restoreWrites), 1);
  });
  await check('native synchronous schema crossing the absolute restore deadline never hydrates before its timer runs', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); await a.evaluate(() => window.stopWriter());
    const b = await pageIn(ctx);
    await b.evaluate(() => { const schema = window.s.readCodec(['index']), parse = schema.safeParse;
      schema.safeParse = function(...args) { const result = parse.apply(this, args), until = performance.now() + 520;
        while (performance.now() < until) {} schema.safeParse = parse; return result; };
    });
    const elapsed = await boot(b); assert(elapsed >= 500);
    assert.equal(await b.evaluate(() => window.s.readIndex(window.s.queryClient)), undefined);
    assert.equal(await b.evaluate(() => window.s.useReadPersistence.getState().restore), 'skipped');
    assert.notEqual(await b.evaluate(() => window.s.useReadPersistence.getState().status), 'unavailable');
    writeFileSync(`${caseDirectory}/deadline.json`, JSON.stringify({ injectedSchemaStallMs: 520, restoreMs: elapsed }));
  });
  await check('FORMAT1 upgrade destroys the old store without reading it, closes its holder and old reopen gets VersionError', async () => {
    const ctx = await context(), a = await pageIn(ctx);
    await a.evaluate(async () => { window.oldReads = 0; const get = IDBObjectStore.prototype.get; IDBObjectStore.prototype.get = function(...args) { if (this.name === 'checkpoint') window.oldReads++; return get.apply(this, args); };
      await new Promise((done, reject) => { const request = indexedDB.open('alpacawork-read-checkpoint', 1); request.onupgradeneeded = () => request.result.createObjectStore('checkpoint');
        request.onsuccess = () => { const db = request.result; window.oldDb = db; db.onversionchange = () => { window.oldClosed = true; db.close(); };
          const tx = db.transaction('checkpoint', 'readwrite'); tx.objectStore('checkpoint').put({ token: 'legacy', bundle: { format: 9, secret: 'must not read' } }, 'current'); tx.oncomplete = () => done(); }; request.onerror = () => reject(request.error); }); });
    await boot(a);
    const actual = await a.evaluate(async () => ({ reads: window.oldReads, closed: window.oldClosed,
      stores: await new Promise(done => { const r = indexedDB.open('alpacawork-read-checkpoint', 3); r.onsuccess = () => { const db = r.result; const stores = [...db.objectStoreNames]; db.close(); done(stores); }; }),
      oldReopen: await new Promise(done => { const r = indexedDB.open('alpacawork-read-checkpoint', 1); r.onerror = () => done(r.error.name); r.onsuccess = () => { r.result.close(); done('unexpected'); }; }) }));
    assert.deepEqual(actual, { reads: 0, closed: true, stores: ['control', 'slots'], oldReopen: 'VersionError' });
    assert.equal((await disk(a)).slots.length, 0); await seed(a);
  });
  await check('blocked upgrade has a finite open deadline and never hydrates when its old holder is eventually released', async () => {
    const ctx = await context(), a = await pageIn(ctx);
    await a.evaluate(async () => { await new Promise(done => { const r = indexedDB.open('alpacawork-read-checkpoint', 1); r.onupgradeneeded = () => r.result.createObjectStore('checkpoint'); r.onsuccess = () => { window.blockedHolder = r.result; done(); }; }); });
    const elapsed = await boot(a); assert(elapsed >= 480 && elapsed < 720);
    await a.waitForTimeout(650); assert.equal(await a.evaluate(() => window.s.useReadPersistence.getState().status), 'unavailable');
    await a.evaluate(() => window.blockedHolder.close()); await a.waitForTimeout(150);
    assert.equal(await a.evaluate(() => window.s.readIndex(window.s.queryClient)), undefined);
    assert.equal(await a.evaluate(() => window.s.useReadPersistence.getState().status), 'unavailable');
  });
  await check('native abort rolls back control and dirty slots atomically before a bounded transient retry', async () => {
    const ctx = await context(), a = await pageIn(ctx); await a.clock.install(); await a.clock.pauseAt(new Date()); await withoutIdle(a); await boot(a); await seed(a); const before = await disk(a);
    const changed = viewFor({ ...task, values: { notes: 'atomic replacement' } });
    await a.route('**/api/task/view?task=T11', route => route.fulfill({ json: changed }));
    await a.evaluate(() => { const original = IDBObjectStore.prototype.put; window.injectAbort = true; window.abortCount = 0;
      IDBObjectStore.prototype.put = function(...args) { const result = original.apply(this, args);
        if (this.name === 'control' && window.injectAbort) { window.injectAbort = false; window.abortCount++; this.transaction.abort(); } return result; }; });
    await force(a, 'task'); await flush(a);
    await expect.poll(() => a.evaluate(() => window.s.useReadPersistence.getState().status)).toBe('unavailable');
    assert.deepEqual(await disk(a), before); assert.equal(await a.evaluate(() => window.abortCount), 1);
    await a.clock.runFor(250);
    await expect.poll(() => a.evaluate(() => window.s.useReadPersistence.getState().status)).toBe('saved');
    assert.equal(taskSlot(await disk(a)).query.state.data.task.values?.notes, changed.task.values?.notes);
  });
  await check('QuotaExceededError injected at the native write boundary preserves disk and memory with no automatic retry', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); const before = await disk(a);
    await a.evaluate(() => { const put = IDBObjectStore.prototype.put; window.quotaWrites = 0;
      IDBObjectStore.prototype.put = function(...args) { window.quotaWrites++; throw new DOMException('Injected quota at native put', 'QuotaExceededError'); };
    });
    await a.route('**/api/task/view?task=T11', route => route.fulfill({ json: viewFor({ ...task, values: { notes: 'unsaved quota words' } }) }));
    await force(a, 'task'); await flush(a);
    await expect.poll(() => a.evaluate(() => window.s.useReadPersistence.getState().status)).toBe('unavailable');
    assert.deepEqual(await disk(a), before);
    assert.equal(await a.evaluate(() => window.s.queryClient.getQueryData(['task', '/fixture', 'T11']).task.values?.notes), 'unsaved quota words');
    assert.match(await a.evaluate(() => window.s.useReadPersistence.getState().error), /quota|Quota/i);
    const writes = await a.evaluate(() => window.quotaWrites); await a.waitForTimeout(1300);
    assert.equal(await a.evaluate(() => window.quotaWrites), writes); assert.deepEqual(await disk(a), before);
  });
  await check('oversized new index preserves the old checkpoint while a small refusal still commits and releases its pin', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); const before = await disk(a);
    await a.evaluate(index => { const s = window.s; s.receiveFullIndex(s.queryClient, { ...index, rev: 2, errors: [{ code: 'fault', path: 'root', message: 'x'.repeat(9 * 1024 * 1024) }] }); window.dispatchEvent(new Event('pagehide')); }, index);
    await expect.poll(() => a.evaluate(() => window.s.useReadPersistence.getState().status)).toBe('over-budget');
    assert.equal((await disk(a)).control.epoch, before.control.epoch); assert.equal(taskSlot(await disk(a)).acquiredAt, taskSlot(before).acquiredAt);
    await a.route('**/api/commands/settings/get', route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Revoked despite huge index', retry: 'fix' } } }));
    await force(a, 'settings'); await expect.poll(async () => (await disk(a)).control.epoch !== before.control.epoch).toBe(true);
    assert.equal((await disk(a)).slots.some(slot => slot.key[0] === 'person-settings'), false);
    assert.equal(taskSlot(await disk(a)).query.state.data.task.values?.notes, view.task.values?.notes);
    assert.equal(await a.evaluate(() => window.s.queryClient.getQueryCache().getAll().filter(q => window.s.hasPendingReadRefusal(q)).length), 0);
  });
  await check('pre-commit direct removal is a terminal pin fault and is distinct from a successful refusal followed by GC', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    const result = await a.evaluate(() => { const s = window.s, c = s.queryClient, q = s.readQuery(c, ['task', '/fixture', 'T11']);
      s.applyReadEvidence(c, { kind: 'refused', query: q }); const pinned = s.hasPendingReadRefusal(q);
      c.removeQueries({ queryKey: q.queryKey, exact: true });
      return { pinned, status: s.useReadPersistence.getState().status, error: s.useReadPersistence.getState().error, anchored: s.readScope(c).anchored }; });
    assert.equal(result.pinned, true); assert.equal(result.status, 'unavailable'); assert.equal(result.anchored, false); assert.match(result.error, /before storage commit/);
    const checkpoint = await disk(a); await a.evaluate(index => window.s.receiveFullIndex(window.s.queryClient, { ...index, rev: 9 }), index); await flush(a); await a.waitForTimeout(350);
    assert.deepEqual(await disk(a), checkpoint);
  });
  await check('committed refusal is released to actual retention, whose loss cuts the scope without any direct remove call', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    await a.route('**/api/task/view?*', route => { const id = new URL(route.request().url()).searchParams.get('task');
      return route.fulfill({ json: viewFor({ ...task, id }) }); });
    await force(a, 'task', 'T12'); await flush(a); await expect.poll(async () => (await disk(a)).slots.some(slot => slot.key[2] === 'T12')).toBe(true);
    await a.evaluate(() => { const s = window.s; s.applyReadEvidence(s.queryClient, { kind: 'refused', query: s.readQuery(s.queryClient, ['task', '/fixture', 'T12']) }); });
    await expect.poll(async () => (await disk(a)).slots.some(slot => slot.key[2] === 'T12')).toBe(false);
    await expect.poll(() => a.evaluate(() => window.s.hasPendingReadRefusal(window.s.readQuery(window.s.queryClient, ['task', '/fixture', 'T12'])))).toBe(false);
    const acquisitions = await a.evaluate(async () => { const s = window.s, c = s.queryClient; return (await Promise.allSettled(Array.from({ length: 102 }, (_, n) => c.fetchQuery(s.resources.taskView('/fixture', `T${1000+n}`))))).map(result => result.status); });
    assert(acquisitions.filter(status => status === 'fulfilled').length >= 99);
    writeFileSync(`${caseDirectory}/retention-acquisitions.json`, JSON.stringify(acquisitions));
    await expect.poll(() => a.evaluate(() => !!window.s.readQuery(window.s.queryClient, ['task', '/fixture', 'T12']))).toBe(false);
    assert.equal(await a.evaluate(() => window.s.readScope(window.s.queryClient).anchored), false);
    assert.notEqual(await a.evaluate(() => window.s.useReadPersistence.getState().status), 'unavailable');
  });
  for (const delta of [1, 0, -1]) await check(`7-day usedAt boundary delta=${delta} uses the common selector without refreshing acquisition time`, async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); await a.evaluate(() => window.stopWriter());
    const fixed = Date.now();
    await a.evaluate(async ({ fixed, delta }) => { const r = indexedDB.open('alpacawork-read-checkpoint', 3); await new Promise(done => { r.onsuccess = () => {
      const db = r.result, tx = db.transaction('slots', 'readwrite'), store = tx.objectStore('slots'), read = store.getAll();
      read.onsuccess = () => { for (const slot of read.result) if (slot.key[0] === 'task' || slot.key[0] === 'task-history') { slot.usedAt = fixed - 7 * 86400000 + delta; store.put(slot); } };
      tx.oncomplete = () => { db.close(); done(); }; }; }); }, { fixed, delta });
    await a.close(); const b = await pageIn(ctx); await b.clock.setFixedTime(new Date(fixed));
    await boot(b); assert.equal(!!await b.evaluate(() => window.s.queryClient.getQueryData(['task', '/fixture', 'T11'])), delta > 0);
  });

  for (const delta of [1, 0, -1]) await check(`14-day real index reception envelope delta=${delta}`, async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); await a.evaluate(() => window.stopWriter()); const fixed = Date.now();
    await a.evaluate(async ({ fixed, delta }) => { const r = indexedDB.open('alpacawork-read-checkpoint', 3); await new Promise(done => { r.onsuccess = () => {
      const db = r.result, tx = db.transaction(['control', 'slots'], 'readwrite'), control = tx.objectStore('control'), slots = tx.objectStore('slots');
      const c = control.get('current'), rows = slots.getAll(); c.onsuccess = () => { c.result.indexReceivedAt = fixed - 14 * 86400000 + delta; control.put(c.result, 'current'); };
      rows.onsuccess = () => { for (const slot of rows.result) if (slot.key[0] === 'index') { slot.acquiredAt = fixed - 14 * 86400000 + delta; slot.qualification.proof.acquiredAt = slot.acquiredAt; slots.put(slot); } };
      tx.oncomplete = () => { db.close(); done(); }; }; }); }, { fixed, delta });
    await a.close(); const b = await pageIn(ctx); await b.clock.setFixedTime(new Date(fixed)); await boot(b);
    assert.equal(!!await b.evaluate(() => window.s.readIndex(window.s.queryClient)), delta > 0);
  });
  await check('100 represented Task boundary holds all 100 and the 101st uses the same retention selector', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    await a.route('**/api/task/view?*', route => { const id = new URL(route.request().url()).searchParams.get('task'); return route.fulfill({ json: viewFor({ ...task, id }) }); });
    await a.evaluate(async () => { const s = window.s; await Promise.all(Array.from({ length: 99 }, (_, n) => s.queryClient.fetchQuery(s.resources.taskView('/fixture', `T${2000+n}`)))); });
    const count = saved => new Set(saved.slots.flatMap(slot => slot.key[0] === 'task' || slot.key[0] === 'task-history' ? [slot.key[2]] : [])).size;
    await flush(a); await expect.poll(async () => count(await disk(a))).toBe(100);
    await force(a, 'task', 'T2100'); await flush(a); await a.waitForTimeout(350); assert.equal(count(await disk(a)), 100);
  });

  for (const delta of [-1, 0, 1]) await check(`serialized whole checkpoint UTF8 8MiB delta=${delta}`, async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); await a.evaluate(() => window.stopWriter());
    const raw = await disk(a), taskRow = taskSlot(raw); taskRow.query.state.data.task.values.notes = '';
    const bytes = value => new TextEncoder().encode(JSON.stringify({ control: value.control, slots: [...value.slots].sort((a, b) => a.hash.localeCompare(b.hash)) })).byteLength;
    const extra = 8 * 1024 * 1024 + delta - bytes(raw); taskRow.query.state.data.task.values.notes = '界'.repeat(Math.floor(extra / 3)) + 'x'.repeat(extra % 3);
    assert.equal(bytes(raw), 8 * 1024 * 1024 + delta);
    await a.evaluate(async raw => { const r = indexedDB.open('alpacawork-read-checkpoint', 3); await new Promise(done => { r.onsuccess = () => {
      const db = r.result, tx = db.transaction(['control', 'slots'], 'readwrite'); tx.objectStore('control').put(raw.control, 'current'); tx.objectStore('slots').clear(); for (const slot of raw.slots) { const { data, ...state } = slot.query.state; tx.objectStore('slots').put({ ...slot, payload: window.s.readPayload(data).text, query: { ...slot.query, state } }); }
      tx.oncomplete = () => { db.close(); done(); }; }; }); }, raw);
    await a.close(); const b = await pageIn(ctx); await boot(b); assert.equal(!!await b.evaluate(() => window.s.queryClient.getQueryData(['task', '/fixture', 'T11'])), delta <= 0);
    writeFileSync(`${caseDirectory}/byte-boundary.json`, JSON.stringify({ bytes: bytes(raw), delta, expectedRestored: delta <= 0 }));
  });
  await check('pending refusal remains pinned under actual retention while native write is unavailable', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    await a.route('**/api/task/view?*', route => { const id = new URL(route.request().url()).searchParams.get('task'); return route.fulfill({ json: viewFor({ ...task, id }) }); });
    await force(a, 'task', 'T12'); await flush(a); await expect.poll(async () => (await disk(a)).slots.some(slot => slot.key[2] === 'T12')).toBe(true);
    await a.evaluate(() => { IDBObjectStore.prototype.put = function() { throw new DOMException('Native write fault until test ends', 'QuotaExceededError'); };
      const s = window.s; s.applyReadEvidence(s.queryClient, { kind: 'refused', query: s.readQuery(s.queryClient, ['task', '/fixture', 'T12']) }); });
    await expect.poll(() => a.evaluate(() => window.s.useReadPersistence.getState().status)).toBe('unavailable');
    const reads = await a.evaluate(async () => { const s = window.s; return (await Promise.allSettled(Array.from({ length: 102 }, (_, n) => s.queryClient.fetchQuery(s.resources.taskView('/fixture', `T${3000+n}`))))).map(result => result.status); });
    const result = await a.evaluate(() => { const s = window.s, q = s.readQuery(s.queryClient, ['task', '/fixture', 'T12']); return { present: !!q, pending: !!q && s.hasPendingReadRefusal(q), refused: !!q && s.readRefused(q), anchored: s.readScope(s.queryClient).anchored, status: s.useReadPersistence.getState().status }; });
    writeFileSync(`${caseDirectory}/uncommitted-retention.json`, JSON.stringify({ result, reads }));
    assert.equal(result.present, true, 'the uncommitted refusal source must remain in QueryCache'); assert.equal(result.pending, true); assert.equal(result.refused, true);
    assert(reads.filter(status => status === 'fulfilled').length >= 99);
  });
  const delayOpen = page => page.evaluate(() => { const original = indexedDB.open.bind(indexedDB); indexedDB.open = (...args) => {
      const request = original(...args); let success; const proxy = new Proxy(request, {
        get(target, key) { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; },
        set(target, key, value) { if (key === 'onsuccess') { success = value; return true; } return Reflect.set(target, key, value, target); } });
      request.onsuccess = event => setTimeout(() => { indexedDB.open = original; window.basisOpenedAt = performance.now(); success?.call(proxy, event); }, 750); return proxy;
    }; });
  async function observe(page, id) {
    return page.evaluate(async id => { const s = window.s, src = await (await fetch('/src/data/query-client.ts')).text();
      const url = src.match(/from\s+"(\/node_modules\/\.vite\/deps\/@tanstack_react-query\.js[^"]*)"/)[1];
      const { QueryObserver } = await import(url); const observer = new QueryObserver(s.queryClient, s.resources.taskView('/fixture', id));
      window.observed = window.observed ?? []; window.observed.push(observer.subscribe(() => {})); window.observeStartedAt = performance.now(); }, id);
  }
  await check('non-checkpoint Query activity never rewrites the active native payload; managed GET still commits', async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a);
    const large = viewFor({ ...task, values: { notes: 'Persistent bytes '.repeat(131072) } });
    await a.route('**/api/task/view?task=T11', route => route.fulfill({ json: large }));
    await force(a, 'task', 'T11'); await observe(a, 'T11'); await flush(a);
    await expect.poll(async () => taskSlot(await disk(a)).query.state.data.task.values?.notes.length).toBe(large.task.values?.notes.length);
    await a.waitForTimeout(750);
    const before = await disk(a), cdp = await ctx.newCDPSession(a);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await a.evaluate(() => {
      window.nativePuts = [];
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        const at = performance.now(), result = put.call(this, value, ...args), elapsedMs = performance.now() - at;
        window.nativePuts.push({ store: this.name, kind: value.key?.[0], payloadBytes: typeof value.payload === 'string' ? new TextEncoder().encode(value.payload).byteLength : 0, elapsedMs });
        return result;
      };
    });
    for (let round = 0; round < 6; round++) {
      await a.evaluate(async round => {
        const s = window.s, c = s.queryClient, src = await (await fetch('/src/data/query-client.ts')).text();
        const url = src.match(/from\s+"(\/node_modules\/\.vite\/deps\/@tanstack_react-query\.js[^"]*)"/)[1], { QueryObserver } = await import(url);
        const key = [round % 2 ? 'task-file-text' : 'host-status', '/fixture', 'T11', 'report.md', round];
        await c.fetchQuery({ queryKey: key, queryFn: async () => ({ round }), staleTime: 0 });
        await c.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
        try { await c.fetchQuery({ queryKey: key, queryFn: async () => { throw new Error('Unstored read failed'); }, retry: false }); } catch {}
        const observer = new QueryObserver(c, { queryKey: key, enabled: false }), stop = observer.subscribe(() => {});
        stop(); observer.destroy(); c.removeQueries({ queryKey: key, exact: true });
      }, round);
      await a.waitForTimeout(750);
    }
    const unrelated = await a.evaluate(() => window.nativePuts), after = await disk(a);
    const metrics = { rounds: 6, throttle: 4, device: 'isolated desktop Chromium; not Pixel', payloadChars: large.task.values?.notes.length,
      puts: unrelated.length, payloadPuts: unrelated.filter(row => row.store === 'slots').length,
      payloadBytes: unrelated.reduce((n, row) => n + row.payloadBytes, 0), putSelfMs: unrelated.reduce((n, row) => n + row.elapsedMs, 0),
      beforeRevision: before.control.revision, afterRevision: after.control.revision, rows: unrelated };
    writeFileSync(`${caseDirectory}/unrelated-query-writes.json`, JSON.stringify(metrics, null, 2));
    assert.equal(metrics.puts, 0, 'unstored Query activity cannot justify rewriting the active checkpoint');
    assert.deepEqual(after, before, 'unrelated activity must leave the entire checkpoint unchanged');
    const acquisition = taskSlot(after).acquisitionId;
    await force(a, 'task', 'T11');
    await expect.poll(async () => taskSlot(await disk(a)).acquisitionId).not.toBe(acquisition);
    const updated = await disk(a);
    await a.evaluate(() => window.observed.splice(0).forEach(stop => stop()));
    await expect.poll(async () => (await disk(a)).control.revision).toBeGreaterThan(updated.control.revision);
    const left = taskSlot(await disk(a));
    assert.equal(left.acquisitionId, taskSlot(updated).acquisitionId, 'leaving does not create a GET');
    const revision = (await disk(a)).control.revision;
    await a.evaluate(() => { const s = window.s, index = s.readIndex(s.queryClient); s.receiveFullIndex(s.queryClient, { ...index, rev: index.rev + 1 }); });
    await expect.poll(async () => (await disk(a)).control.revision).toBeGreaterThan(revision);
    await cdp.detach();
  });
  const t12Gets = ctx => caseContexts.find(c => c.context === ctx).http.filter(row => row.event === 'request' && row.method === 'GET' && row.url.includes('/api/task/view') && row.url.includes('T12')).length;
  for (const present of [false, true]) for (const delayed of [false, true]) await check(`basis ${present ? 'index-present' : 'index-absent'} viewed T12 GET ${delayed ? 'in flight at' : 'completed before'} the delayed basis is saved without user action`, async () => {
    const ctx = await context(), a = await pageIn(ctx); await boot(a); await seed(a); await a.close(); const b = await pageIn(ctx);
    await b.route('**/api/task/view?task=T12', async route => { if (delayed) await new Promise(done => setTimeout(done, 600)); return route.fulfill({ json: viewFor({ ...task, id: 'T12', path: 'tasks/T12', values: { notes: 'Viewed T12 body' } }) }); });
    await delayOpen(b); await boot(b);
    await b.evaluate(async ({ index, present }) => { const s = window.s, c = s.queryClient; s.receiveFullIndex(c, { ...index, rev: 2, tasks: present ? [...index.tasks, { ...index.tasks[0], id: 'T12', path: 'tasks/T12' }] : index.tasks });
      await Promise.all([c.fetchQuery(s.resources.personalSettings(index.root)), c.fetchQuery(s.resources.notices(index.root))]); }, { index, present });
    await observe(b, 'T12');
    await b.waitForTimeout(2500); await flush(b); await b.waitForTimeout(600); await flush(b); await b.waitForTimeout(600);
    const state = await b.evaluate(() => { const s = window.s, q = s.readQuery(s.queryClient, ['task', '/fixture', 'T12']);
      return { basisOpenedAt: window.basisOpenedAt, observeStartedAt: window.observeStartedAt, active: q.isActive(), pendingDemand: s.readDemandPending(q), acceptedIssued: s.readAcceptedSequence(q), issuedNow: s.readIssuedSequence(), proof: s.getReadProof(q), fetchStatus: q.fetchStatus ?? q.state.fetchStatus,
        body: q.state.data?.task?.values?.notes, source: s.readAcquisition(q)?.source, persistence: s.useReadPersistence.getState() }; });
    const saved = (await disk(b)).slots.some(slot => slot.key[0] === 'task' && slot.key[2] === 'T12');
    const result = { present, delayed, saved, gets: t12Gets(ctx), state };
    writeFileSync(`${caseDirectory}/probe.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    assert.equal(state.body, 'Viewed T12 body'); assert.equal(state.active, true);
    assert.equal(saved, true, `viewed T12 must be saved (gets=${result.gets}, status=${state.persistence.status}, unsaved=${state.persistence.unsavedTasks})`);
  });
  await check('real Check caller cannot accept after committed refusal retirement cuts scope', async () => {
    const a=await pageIn(await context());await boot(a);await seed(a);
    const snapshot={root:'/fixture',generation:index.generation,revision:'c'.repeat(64),conversation:{id:'C1',nextLaunch:null,busy:false,turns:[],earlier:null,resets:[],context:null,autoReset:{tokens:200000,percent:50}}};
    await a.route('**/api/coordinator',route=>route.fulfill({json:snapshot}));
    await a.evaluate(async snapshot=>{const s=window.s, c=s.queryClient;const refresh=await import('/@react-refresh');window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;window.coordinator=await import('/src/features/coordinator/coordinator.ts');s.receiveFullIndex(c,{...s.readIndex(c),rev:s.readIndex(c).rev+1,person:{...s.readIndex(c).person,coordinator:{id:'C1',revision:snapshot.revision}}});window.coordinator.useConversation.setState({root:'/fixture'});await window.coordinator.useConversation.getState().refresh();},snapshot);
    const previous=(await disk(a)).control.epoch;
    await a.evaluate(()=>{const s=window.s,c=s.queryClient;const q=c.getQueryCache().build(c,s.resources.taskView('/fixture','T12'));s.applyReadEvidence(c,{kind:'refused',query:q});});
    await flush(a);await expect.poll(async()=>(await disk(a)).control.epoch).not.toBe(previous);
    const outcome=await a.evaluate(async()=>{
      const s=window.s,c=s.queryClient,q=s.readQuery(c,['coordinator','/fixture']),order=[];
      const stop=c.getQueryCache().subscribe(e=>{if(e.query===q&&e.type==='updated'&&e.action.type==='success'&&!e.action.manual){order.push('GET-success');queueMicrotask(()=>{c.removeQueries({queryKey:['task','/fixture','T12'],exact:true});order.push('refusal-retired');});}});
      let result,snapshot;try{snapshot=await window.coordinator.readConversationSnapshot();result='accepted';}catch(error){result='rejected';}stop();
      return {result,snapshot,order,pending:s.readDemandPending(q),scope:s.readScope(c),assessment:s.assessRead(c,q),source:s.readAcquisition(q)?.source};
    });
    const posts = caseContexts.flatMap(({ http }) => http).filter(row => row.event === 'request' && row.method === 'POST');
    writeFileSync(caseDirectory+'/coordinator-scope-window.json',JSON.stringify({ ...outcome, posts },null,2));
    assert.deepEqual(posts, [], 'the rejected real Check caller must emit no POST, including acknowledgement');
    assert.equal(outcome.scope.anchored,false,'real retirement must cut the read scope');
    assert.equal(outcome.result,'rejected','real Check snapshot caller must not certify a GET from the cut scope');
    assert.equal(outcome.pending,true,'cut cannot complete the outstanding read demand');
  });

  await check('native JSON text parser proves only its own deep frozen finite tree without object trust flags', async () => {
    const a = await pageIn(await context()); await boot(a);
    const actual = await a.evaluate(() => {
      const s = window.s, input = '{"__proto__":{"zero":-0},"list":[-0,"text -0 \\ud800 界😀",{"zero":-0}]}', data = s.parseReadJson(input);
      const nodes = [], visit = value => { if (!value || typeof value !== 'object') return;
        nodes.push({ frozen: Object.isFrozen(value), proven: s.isReadDataImmutable(value), plain: Object.getPrototypeOf(value) === (Array.isArray(value) ? Array.prototype : Object.prototype) });
        Object.values(value).forEach(visit); }; visit(data);
      const payload = s.readPayload(data), roundTrip = JSON.parse(payload.text);
      let coerced = false, rejected = false;
      try { s.parseReadJson({ toString() { coerced = true; return '{}'; } }); } catch (error) { rejected = error instanceof TypeError; }
      return { nodes, signed: [data.__proto__.zero, data.list[0], data.list[2].zero, roundTrip.__proto__.zero, roundTrip.list[2].zero].every(n => Object.is(n, -0)),
        text: roundTrip.list[1], ownProto: Object.hasOwn(data, '__proto__'), bytes: payload.bytes,
        oracle: new TextEncoder().encode(JSON.stringify(data)).byteLength,
        nonfiniteRejected: ['1e400', '[1e400]', '{"zero":-1e400}'].every(text => s.parseReadJson(text) === undefined), coerced, rejected };
    });
    assert(actual.nodes.length >= 4); assert(actual.nodes.every(node => node.frozen && node.proven && node.plain), 'native parse must establish the shared deep freeze proof');
    assert.equal(actual.signed, true); assert.equal(actual.text, 'text -0 \ud800 界😀'); assert.equal(actual.ownProto, true);
    assert.equal(actual.bytes, actual.oracle); assert.equal(actual.nonfiniteRejected, true); assert.equal(actual.coerced, false); assert.equal(actual.rejected, true);
    writeFileSync(`${caseDirectory}/native-parser.json`, JSON.stringify(actual, null, 2));
  });

  for (const signed of [false, true]) await check(`pure payload memo is collectible with a live Query and regenerates through native save/restore: ${signed ? 'signed zero' : 'ordinary'}`, async () => {
    const ctx = await context(), a = await pageIn(ctx);
    await boot(a);
    await seed(a, { ...index, rev: signed ? -0 : index.rev,
      projects: [{ ...index.projects[0], title: 'Memo -0 界😀 "quoted"' }] });
    const first = await a.evaluate(() => {
      const s = window.s, data = s.queryClient.getQueryData(['index']), payload = s.readPayload(data);
      window.memoDataWeak = new WeakRef(data);
      window.memoPayloadWeak = new WeakRef(payload);
      return { text: payload.text, bytes: payload.bytes, logical: new TextEncoder().encode(JSON.stringify(data)).byteLength,
        reused: s.readPayload(data) === payload, signed: Object.is(JSON.parse(payload.text).rev, -0) };
    });
    assert.equal(first.reused, true, 'a live result is reusable within its job');
    assert.equal(first.bytes, first.logical);
    assert.equal(first.signed, signed);
    // page.evaluate has returned: no local result remains in that browser job.
    const cdp = await ctx.newCDPSession(a);
    await cdp.send('HeapProfiler.collectGarbage');
    const collected = await a.evaluate(() => ({ payload: !!window.memoPayloadWeak.deref(),
      data: window.memoDataWeak.deref() === window.s.queryClient.getQueryData(['index']) }));
    assert.equal(collected.data, true, 'GC must preserve the Query data owner');
    assert.equal(collected.payload, false, 'live Query data must not strongly retain regenerable payload text');
    const sizeOnly = await a.evaluate(() => {
      const s = window.s, data = s.queryClient.getQueryData(['index']), stringify = JSON.stringify;
      let fullSerializations = 0;
      JSON.stringify = function(value, ...args) { if (value === data) fullSerializations++; return stringify.call(this, value, ...args); };
      let bytes;
      try { bytes = s.readDataSize(data, data => ({ data })); } finally { JSON.stringify = stringify; }
      return { fullSerializations, bytes };
    });
    assert.equal(sizeOnly.fullSerializations, 0, 'bytes-only work must not resurrect payload text after native GC');
    assert.equal(sizeOnly.bytes, first.logical + 9);
    const regenerated = await a.evaluate(() => {
      const s = window.s, data = s.queryClient.getQueryData(['index']), stringify = JSON.stringify;
      let fullSerializations = 0;
      JSON.stringify = function(value, ...args) { if (value === data) fullSerializations++; return stringify.call(this, value, ...args); };
      let payload;
      try { payload = s.readPayload(data); } finally { JSON.stringify = stringify; }
      window.regeneratedPayloadWeak = new WeakRef(payload);
      return { text: payload.text, bytes: payload.bytes, fullSerializations, immutable: s.isReadDataImmutable(data),
        matches: s.readPayloadMatches(data, payload.text), signed: Object.is(JSON.parse(payload.text).rev, -0) };
    });
    assert.equal(regenerated.fullSerializations, signed ? 0 : 1, 'GC permits recomputation through the original encoder');
    assert.equal(regenerated.text, first.text); assert.equal(regenerated.bytes, first.logical);
    assert.equal(regenerated.immutable, true); assert.equal(regenerated.matches, true); assert.equal(regenerated.signed, signed);
    await cdp.send('HeapProfiler.collectGarbage');
    assert.equal(await a.evaluate(() => !!window.regeneratedPayloadWeak.deref()), false, 'recomputed results have the same weak lifetime');
    const budgeted = await a.evaluate(() => {
      const s = window.s;
      window.budgetData = s.parseReadJson(JSON.stringify(s.queryClient.getQueryData(['index'])));
      const data = window.budgetData, stringify = JSON.stringify;
      let fullSerializations = 0;
      JSON.stringify = function(value, ...args) { if (value === data) fullSerializations++; return stringify.call(this, value, ...args); };
      try {
        const bytes = s.readDataSize(data, data => ({ data })), payload = s.readPayload(data);
        window.budgetPayloadWeak = new WeakRef(payload);
        return { bytes, payloadBytes: payload.bytes, fullSerializations };
      } finally { JSON.stringify = stringify; }
    });
    assert.equal(budgeted.fullSerializations, 1, 'a fresh ordinary sizing encode must serve the same-job save');
    assert.equal(budgeted.bytes, budgeted.payloadBytes + 9);
    await cdp.send('HeapProfiler.collectGarbage');
    assert.equal(await a.evaluate(() => !!window.budgetData && !window.budgetPayloadWeak.deref()), true,
      'budgeting must not make payload text survive native GC with its data still live');
    // Publish a new GET after collection and let the normal reservation save,
    // comparing the unchanged index raw text as well.
    const before = await a.evaluate(() => window.diskRaw());
    await force(a, 'task', 'T11');
    await expect.poll(async () => (await disk(a)).control.revision).toBeGreaterThan(before.control.revision);
    const saved = await a.evaluate(() => window.diskRaw());
    assert.equal(saved.slots.find(slot => slot.key[0] === 'index').payload, first.text);
    assert.equal(await a.evaluate(() => window.s.queryClient.getQueryData(['index']) === window.memoDataWeak.deref()), true);
    await cdp.detach(); await a.close();
    const b = await pageIn(ctx);
    await b.route('**/api/**', route => route.abort());
    const restoredMs = await boot(b);
    const restored = await b.evaluate(() => { const s = window.s, data = s.queryClient.getQueryData(['index']), payload = s.readPayload(data);
      return { text: payload.text, bytes: payload.bytes, signed: Object.is(data.rev, -0),
        source: s.readAcquisition(s.readQuery(s.queryClient, ['index'])).source,
        task: s.queryClient.getQueryData(['task', '/fixture', 'T11']).task.values?.notes }; });
    assert.equal(restored.text, first.text); assert.equal(restored.bytes, first.logical); assert.equal(restored.signed, signed);
    assert.equal(restored.source, 'checkpoint'); assert.equal(restored.task, task.values.notes);
    writeFileSync(`${caseDirectory}/payload-lifetime.json`, JSON.stringify({ signed, first, collected, sizeOnly, regenerated, budgeted, restored, restoredMs }, null, 2));
  });

  for (const mode of ['unconsumed', 'consumed', 'query-clear']) await check(`one-use normalized output lifetime: ${mode}`, async () => {
    const a = await pageIn(await context()), cdp = await a.context().newCDPSession(a);
    // The common evidence collector reads both stores when the case closes.
    await a.evaluate(() => window.s.restoreReadPersistence(window.s.queryClient));
    await a.evaluate(({ index, mode }) => {
      const s = window.s, raw = structuredClone(index), schema = s.readCodec(['index']);
      window.rawWeak = new WeakRef(raw);
      const parse = schema.safeParse;
      schema.safeParse = function(...args) {
        const result = parse.apply(this, args);
        if (result.success) window.normalizedWeak = new WeakRef(result.data);
        return result;
      };
      try {
        if (mode === 'query-clear') {
          const client = window.ownerClient = new s.queryClient.constructor({ defaultOptions: { queries: { gcTime: Infinity } } });
          client.setQueryData(['index'], raw);
          const query = s.readQuery(client, ['index']);
          s.recordReadProof(query, s.captureReadProof(raw, ['index']));
          if (s.evaluateRead(raw, s.readEntry(query)).state !== 'current') throw Error('Expected actual Query structure proof');
        } else {
          window.ownerRaw = raw;
          if (s.evaluateRead(raw, { key: ['index'], data: raw, proof: s.captureReadProof(raw, ['index']) }).state !== 'current') throw Error('Expected raw structure proof');
          if (mode === 'consumed') s.readNormalized(['index'], raw);
        }
      } finally { schema.safeParse = parse; }
    }, { index, mode });
    const collect = () => cdp.send('HeapProfiler.collectGarbage');
    await collect();
    const retained = await a.evaluate(() => ({ raw: !!window.rawWeak.deref(), normalized: !!window.normalizedWeak.deref() }));
    assert.equal(retained.raw, true);
    assert.equal(retained.normalized, mode !== 'consumed', 'only unpublished output has a strong owner');
    if (mode === 'consumed') {
      await a.evaluate(() => {
        const s = window.s, schema = s.readCodec(['index']), parse = schema.safeParse;
        schema.safeParse = function(...args) { const result = parse.apply(this, args); if (result.success) window.freshWeak = new WeakRef(result.data); return result; };
        try { s.readNormalized(['index'], window.ownerRaw); } finally { schema.safeParse = parse; }
      });
      await collect();
      assert.equal(await a.evaluate(() => !!window.freshWeak.deref()), false, 'fresh fallback output is never stored in the proof');
    }
    await a.evaluate(mode => { if (mode === 'query-clear') window.ownerClient.clear(); else delete window.ownerRaw; }, mode);
    await collect();
    const released = await a.evaluate(() => ({ raw: !!window.rawWeak.deref(), normalized: !!window.normalizedWeak.deref() }));
    assert.deepEqual(released, { raw: false, normalized: false }, 'shape proofs cannot keep raw data alive after its owner releases it');
    writeFileSync(`${caseDirectory}/lifetime.json`, JSON.stringify({ mode, retained, released }));
    await cdp.detach();
  });

} finally {
  writeFileSync(`${evidenceRoot}/summary.json`, JSON.stringify({ passed, cases: cases.map(({ name, status }) => ({ name, status })), ended: new Date().toISOString() }, null, 2));
  writeFileSync(`${evidenceRoot}/server.log`, output); await browser?.close(); clearTimeout(ttl); kill();
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  writeFileSync(`${evidenceRoot}/stopped.json`, JSON.stringify({ server: child.pid, exit: child.exitCode, signal: child.signalCode, ended: new Date().toISOString() }));
  console.log(`Real IndexedDB: ${passed} checks passed; ${evidenceRoot}`);
}
