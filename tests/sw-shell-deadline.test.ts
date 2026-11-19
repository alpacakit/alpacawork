/** Failure/resource checks complement the registered worker's real HTTP browser checks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const template = readFileSync(new URL('../apps/web/public/sw.js', import.meta.url), 'utf8');
const placeholder = '/*__PWA_BUILD__*/{ version: "dev", files: [], precache: [] }';
assert(template.includes(placeholder));
const source = template.replace(placeholder, JSON.stringify({ version: 'test', files: ['/', '/mermaid-frame.html', '/icons/a.png'], precache: ['/', '/icons/a.png'] }));
const versioned = (text: string, version = 'test') => new Response(text, { headers: { 'X-Alpacawork-Build': version } });
function fixture(fetcher: typeof fetch, cached = true, failSave = false) {
  const listeners = new Map<string, (event: any) => void>();
  const stores = new Map<string, Map<string, Response>>([['alpacawork-test', new Map(cached ? [['/', versioned('installed')]] : [])]]);
  const pending: Promise<unknown>[] = [], timers = new Map<number, () => void>(), warnings: unknown[][] = [];
  let cleared = 0, writes = 0, serial = 0;
  class RelativeRequest extends Request { constructor(input: string, init?: RequestInit) { super(new URL(input, 'http://localhost'), init); } }
  runInNewContext(source, {
    self: { location: new URL('http://localhost/sw.js'), addEventListener(type: string, fn: (event: any) => void) { listeners.set(type, fn); },
      skipWaiting() { assert.fail('new builds must wait'); }, clients: { claim() { assert.fail('existing clients must not be claimed'); } } },
    caches: { open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name)!;
      return { match: async (path: string) => entries.get(path)?.clone(),
        put: async (path: string, response: Response) => { writes++; if (failSave) throw new Error('storage full'); entries.set(path, response); } };
    }, delete: async (name: string) => stores.delete(name), keys: async () => [...stores.keys()] },
    fetch: fetcher, URL, Request: RelativeRequest, AbortController, Response,
    console: { warn: (...args: unknown[]) => warnings.push(args) },
    setTimeout(fn: () => void, ms: number) { assert.equal(ms, 5000, 'production deadline'); const id = ++serial; timers.set(id, fn); return id; },
    clearTimeout(id: number) { assert(timers.delete(id)); cleared++; },
  });
  return { stores, warnings,
    async navigate(path = '/?task=T1', mode = 'navigate') {
      let answer: Promise<Response> | undefined;
      listeners.get('fetch')!({ request: { url: 'http://localhost' + path, method: 'GET', mode },
        waitUntil(p: Promise<unknown>) { pending.push(p); }, respondWith(p: Promise<Response>) { answer = p; } });
      return answer;
    },
    async lifecycle(type: string) { let done: Promise<unknown> | undefined; listeners.get(type)!({ waitUntil(p: Promise<unknown>) { done = p; } }); await done; },
    async saved() { await Promise.all(pending); },
    async expire() { await delay(0); assert.equal(timers.size, 1); [...timers.values()][0]!(); },
    resources() { return { timers: timers.size, cleared, writes }; },
  };
}

test('same-build response revalidates, keeps its identity and refreshes the offline copy', async () => {
  const response = new Response('new name', { status: 203, headers: { 'Content-Encoding': 'gzip', ETag: 'new', 'X-Alpacawork-Build': 'test' } });
  const f = fixture(async (_request, init) => { assert.equal(init?.cache, 'no-cache'); return response; });
  assert.equal(await f.navigate(), response); await f.saved();
  assert.equal(await response.text(), 'new name');
  assert.equal(await f.stores.get('alpacawork-test')!.get('/')!.text(), 'new name');
  assert.deepEqual(f.resources(), { timers: 0, cleared: 1, writes: 1 });
});

test('another build or missing identity displays without replacing the installed shell', async () => {
  for (const response of [versioned('new build', 'next'), new Response('unidentified')]) {
    const f = fixture(async () => response); assert.equal(await f.navigate(), response); await f.saved();
    assert.equal(await f.stores.get('alpacawork-test')!.get('/')!.text(), 'installed'); assert.equal(f.resources().writes, 0);
  }
});

test('saving failure is recorded without replacing healthy network HTML', async () => {
  const response = versioned('healthy'), f = fixture(async () => response, true, true);
  assert.equal(await f.navigate(), response); await f.saved();
  assert.equal(await f.stores.get('alpacawork-test')!.get('/')!.text(), 'installed'); assert.equal(f.warnings.length, 1);
});

test('rejection and 5xx fall back promptly; 403/404 and API routes remain authoritative', async () => {
  let signal: AbortSignal;
  const rejected = fixture(async (_request, init) => { signal = init!.signal!; throw new TypeError('offline'); });
  assert.equal(await (await rejected.navigate())!.text(), 'installed'); assert(signal!.aborted);
  assert.deepEqual(rejected.resources(), { timers: 0, cleared: 1, writes: 0 });
  for (const status of [500, 502, 503, 504, 403, 404]) {
    const response = new Response('failure', { status }), f = fixture(async () => response), actual = await f.navigate();
    if (status >= 500) assert.equal(await actual!.text(), 'installed'); else assert.equal(actual, response);
    assert.equal(await f.navigate('/api/tasks/view?task=T1'), undefined);
    assert.equal(await fixture(async () => response, false).navigate(), response); assert.equal(f.resources().writes, 0);
  }
});

test('a pending body is aborted at the deadline rather than accepted on its headers', async () => {
  let signal: AbortSignal;
  const f = fixture(async (_request, init) => {
    signal = init!.signal!;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<html>'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); } }), { headers: { 'X-Alpacawork-Build': 'test' } });
  });
  const navigation = f.navigate(); await f.expire();
  assert.equal(await (await navigation)!.text(), 'installed'); assert(signal!.aborted);
  assert.deepEqual(f.resources(), { timers: 0, cleared: 1, writes: 0 });
});

test('abort-ignoring late completion or rejection cannot write HTML or leak rejection', async () => {
  for (const rejectLate of [false, true]) {
    let finish: () => void, signal: AbortSignal;
    const f = fixture((_request, init) => { signal = init!.signal!; return new Promise<Response>((resolve, reject) => {
      finish = () => rejectLate ? reject(new Error('late fault')) : resolve(versioned('late matching build')); }); });
    const navigation = f.navigate(); await f.expire();
    assert.equal(await (await navigation)!.text(), 'installed'); assert(signal!.aborted);
    finish!(); await delay(10); await f.saved(); assert.deepEqual(f.resources(), { timers: 0, cleared: 1, writes: 0 });
  }
});

test('without a saved shell slow network remains authoritative; offline is a network error', async () => {
  let finish: (response: Response) => void;
  const f = fixture((_request, init) => { assert.equal(init?.cache, 'no-cache'); return new Promise<Response>(resolve => { finish = resolve; }); }, false);
  const navigation = f.navigate(); let settled = false; void navigation.then(() => { settled = true; });
  await delay(0); assert.equal(settled, false); assert.equal(f.resources().timers, 0);
  const response = versioned('slow actual HTML'); finish!(response); assert.equal(await navigation, response);
  assert.equal((await fixture(async () => { throw new TypeError('offline'); }, false).navigate())!.type, 'error');
});

test('fixed-name resources share the network-first and build-qualified storage policy', async () => {
  const f = fixture(async () => versioned('current frame'));
  assert.equal(await (await f.navigate('/mermaid-frame.html', 'cors'))!.text(), 'current frame'); await f.saved();
  assert.equal(await f.stores.get('alpacawork-test')!.get('/mermaid-frame.html')!.text(), 'current frame');
  const next = fixture(async () => versioned('next frame', 'next'));
  assert.equal(await (await next.navigate('/mermaid-frame.html', 'cors'))!.text(), 'next frame'); await next.saved();
  assert(!next.stores.get('alpacawork-test')!.has('/mermaid-frame.html'));
});

test('install rejects mixed builds and incomplete writes without touching an older cache', async () => {
  for (const failure of ['html', 'icon', 'write']) {
    const f = fixture(async request => versioned('file', new URL((request as Request).url).pathname === (failure === 'html' ? '/' : '/icons/a.png') && failure !== 'write' ? 'next' : 'test'), false, failure === 'write');
    f.stores.set('alpacawork-old', new Map([['/', versioned('older', 'old')]]));
    await assert.rejects(f.lifecycle('install')); assert(!f.stores.has('alpacawork-test'));
    assert.equal(await f.stores.get('alpacawork-old')!.get('/')!.text(), 'older');
  }
});

test('complete install waits and activation deletes only older build caches', async () => {
  const f = fixture(async () => versioned('installed file'), false);
  f.stores.set('alpacawork-old', new Map()); f.stores.set('share-inbox', new Map());
  await f.lifecycle('install'); assert(f.stores.get('alpacawork-test')!.has('/icons/a.png'));
  assert(f.stores.has('alpacawork-old'), 'waiting must keep active resources');
  await f.lifecycle('activate'); assert(!f.stores.has('alpacawork-old')); assert(f.stores.has('share-inbox'));
});
