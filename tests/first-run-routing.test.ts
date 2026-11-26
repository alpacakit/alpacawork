import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';

function isolatedArea(t: import('node:test').TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'first-run-navigation-')), home = join(base, 'home'), bin = join(base, 'bin');
  mkdirSync(home); mkdirSync(bin);
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: bin });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}
const read = (url: string, path: string, host?: string, extra: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((done, reject) => {
    const req = request(new URL(path, url), { headers: { ...(host ? { Host: host } : {}), ...extra } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', bytes => body += bytes);
      res.once('end', () => done({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.once('error', reject); req.end();
  });
const change = async (url: string, value: unknown) => (await fetch(new URL('/api/first-run', url), {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-alpacawork-op-id': crypto.randomUUID() }, body: JSON.stringify({ change: value }) })).json();

test('a new workspace opens on its setup until it is finished, on local and public hosts, keeping the address query; one made before setup never does', async t => {
  const base = isolatedArea(t);
  for (const enrolled of [true, false]) {
    const root = join(base, enrolled ? 'new' : 'existing');
    await initializeWorkspace(root, [], { firstRun: enrolled });
    const app = await startServer(root, 0, { publicHost: 'synthetic.ts.net' });
    try {
      const query = '?agent=1&task=T1&name=a%2Fb';
      for (const host of [undefined, 'synthetic.ts.net']) {
        const entry = await read(app.url, '/' + query, host);
        assert.equal(entry.status, enrolled ? 302 : 200);
        if (enrolled) {
          assert.equal(entry.headers.location, '/welcome' + query);
          assert.equal(entry.headers['cache-control'], 'no-store');
        }
        const welcome = await read(app.url, '/welcome' + query, host);
        assert.equal(welcome.status, enrolled ? 200 : 302);
        if (enrolled) assert.match(welcome.headers['content-type']!, /text\/html/);
        else assert.equal(welcome.headers.location, '/' + query);
      }
      if (!enrolled) {
        // A workspace without setup is never given one by a write.
        assert.deepEqual(await change(app.url, { kind: 'finish' }), { state: null });
        assert.equal(existsSync(join(root, '.alpacawork/first-run.json')), false);
        continue;
      }
      // The step reached is where a reload reopens; finished, it stays finished.
      assert.equal((await change(app.url, { kind: 'step', step: 'project' })).state.step, 'project');
      assert.equal((await (await fetch(new URL('/api/first-run', app.url))).json()).state.step, 'project');
      assert.ok((await change(app.url, { kind: 'finish' })).state.finishedAt);
      assert.equal((await change(app.url, { kind: 'step', step: 'agents' })).state.step, 'project');
      for (const host of [undefined, 'synthetic.ts.net']) {
        const main = await read(app.url, '/', host);
        assert.equal(main.status, 200);
        // A page kept from before (its validator) cannot keep the finished person on the setup.
        const finished = await read(app.url, '/welcome' + query, host, { 'If-None-Match': main.headers.etag! });
        assert.equal(finished.status, 302);
        assert.equal(finished.headers.location, '/' + query);
        assert.equal(finished.headers['cache-control'], 'no-store');
      }
      assert.equal((await read(app.url, '/', 'foreign.test')).status, 403);
    } finally { await app.close(); }
  }
});

test('an unreadable setup record opens the setup, which says so, without changing the file; repaired, it continues', async t => {
  const root = join(isolatedArea(t), 'new');
  await initializeWorkspace(root);
  const state = join(root, '.alpacawork/first-run.json'), original = readFileSync(state, 'utf8');
  const app = await startServer(root, 0);
  try {
    writeFileSync(state, '{broken');
    // Not skipped silently: the page goes to the setup, whose read of the record says it failed.
    assert.equal((await fetch(new URL('/?agent=1', app.url), { redirect: 'manual' })).headers.get('location'), '/welcome?agent=1');
    const welcome = await fetch(new URL('/welcome', app.url), { redirect: 'manual' });
    assert.equal(welcome.status, 200);
    assert.match(await welcome.text(), /<html/);
    assert.equal((await fetch(new URL('/api/first-run', app.url))).ok, false, 'the screen is told the record cannot be read');
    assert.equal(readFileSync(state, 'utf8'), '{broken');
    writeFileSync(state, original);
    assert.equal((await fetch(new URL('/welcome', app.url), { redirect: 'manual' })).status, 200);
  } finally { await app.close(); }
});

test('the skills list responds while GitHub waits, and the latest endpoint returns unknown versions at its deadline', { timeout: 10_000 }, async t => {
  const root = join(isolatedArea(t), 'existing');
  await initializeWorkspace(root, [], { firstRun: false });
  const fetchLocal = globalThis.fetch;
  const deadline = new AbortController();
  let resolveStarted!: () => void;
  const started = { promise: new Promise<void>(resolve => { resolveStarted = resolve; }), resolve: () => resolveStarted() };
  const calls: { url: URL; signal: AbortSignal | null | undefined }[] = [];
  t.mock.method(globalThis, 'fetch', (url: URL, options?: RequestInit) => {
    const signal = options?.signal;
    calls.push({ url, signal });
    if (calls.length === 2) started.resolve();
    return new Promise<Response>((_resolve, reject) => {
      deadline.signal.addEventListener('abort', () => reject(deadline.signal.reason), { once: true });
    });
  });

  const app = await startServer(root, 0);
  try {
    const timeouts: number[] = [];
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      timeouts.push(milliseconds);
      return deadline.signal;
    });
    const get = (path: string) => fetchLocal(new URL(path, app.url), { signal: t.signal });
    const latest = get('/api/skills/latest');
    try {
      await Promise.race([started.promise, latest.then(() => assert.fail('Latest returned before GitHub requests were pending'))]);
      const listed = await get('/api/skills');
      assert.equal(listed.status, 200);
      const status = await listed.json();
      assert.equal(status.skills.find((skill: { name: string }) => skill.name === 'doyourjob').installed, false);
      assert.deepEqual(calls.map(call => call.url.searchParams.get('path')).sort(), ['skills/askmeclearly', 'skills/doyourjob']);
      assert.ok(calls.every(call => call.signal === deadline.signal));
      assert.ok(timeouts.length > 0 && timeouts.every(milliseconds => milliseconds > 0 && milliseconds <= 5000));

      deadline.abort(new DOMException('GitHub request timed out', 'TimeoutError'));
      const response = await latest;
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { skills: [
        { name: 'askmeclearly', latestAt: null }, { name: 'doyourjob', latestAt: null },
      ] });
    } finally {
      deadline.abort();
      await latest.catch(() => {});
    }
  } finally { await app.close(); }
});
