import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { httpStatus } from './helpers/http-cli.ts';
/** The PWA's caching: HTTP cache headers on the build files and the Service Worker's own cache. */
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createWebAssets } from '../apps/backend/test-dist/receiver/web-assets.js';
import { runInNewContext } from 'node:vm';
import { startServer } from '../apps/backend/test-dist/receiver/server.js';

async function serve(check: (base: string) => Promise<void>) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-sw-')));
  const root = join(area, 'tasks');
  mkdirSync(root);
  initializeControlFixture(root);
  writeFileSync(join(root, 'config.yaml'),
    stringify({ agents: { "fake": fixtureAgentSetting('codex') } }));
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try { app = await startServer(root); await check(new URL(app.url).origin); }
  finally {
    await app?.close();
    rmSync(area, { recursive: true });
  }
}

/** Observe wire bytes; fetch automatically decodes Content-Encoding. */
function wire(url: string, headers: IncomingHttpHeaders) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = get(url, { headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

test('packaged text gzip preserves decoded bytes and validators follow the selected representation', async () => {
  await serve(async base => {
    const html = await (await fetch(base)).text();
    const script = html.match(/src="(\/assets\/[^" ]+\.js)"/)![1]!;
    const identity = await wire(base + script, { 'accept-encoding': 'identity' });
    const compressed = await wire(base + script, { 'accept-encoding': 'br, gzip' });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(compressed.headers.vary, 'Accept-Encoding');
    for (const header of ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options', 'referrer-policy']) {
      assert.equal(compressed.headers[header], identity.headers[header], header);
    }
    assert.deepEqual(gunzipSync(compressed.body), identity.body);
    assert.ok(compressed.body.length < identity.body.length, 'the actual packaged entry transfers fewer bytes');
    assert.notEqual(compressed.headers.etag, identity.headers.etag, 'strong validators identify wire representations');
    const cached = await wire(base + script, { 'accept-encoding': 'gzip', 'if-none-match': `W/${compressed.headers.etag}` });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    assert.equal(cached.headers.vary, 'Accept-Encoding');
    assert.equal(cached.headers.etag, compressed.headers.etag);
    const identityCached = await wire(base + script, { 'accept-encoding': 'identity', 'if-none-match': identity.headers.etag });
    assert.equal(identityCached.status, 304);
    assert.equal(identityCached.body.length, 0);
    assert.equal(identityCached.headers.etag, identity.headers.etag);
    const other = await wire(base + script, { 'accept-encoding': 'identity', 'if-none-match': compressed.headers.etag });
    assert.equal(other.status, 200);
    assert.deepEqual(other.body, identity.body);
    const reverse = await wire(base + script, { 'accept-encoding': 'gzip', 'if-none-match': identity.headers.etag });
    assert.equal(reverse.status, 200);
    assert.deepEqual(reverse.body, compressed.body);
    for (const encoding of ['', 'br', 'gzip;q=0, *;q=1', 'gzip;q=0.3, identity;q=1']) {
      const refused = await wire(base + script, { 'accept-encoding': encoding });
      assert.equal(refused.headers['content-encoding'], undefined, encoding);
      assert.deepEqual(refused.body, identity.body, encoding);
    }
    const wildcard = await wire(base + script, { 'accept-encoding': '*;q=0.5' });
    assert.equal(wildcard.headers['content-encoding'], 'gzip');
    assert.deepEqual(wildcard.body, compressed.body);
    const image = await wire(base + '/icons/icon-192-2c.png', { 'accept-encoding': 'gzip' });
    assert.equal(image.headers['content-encoding'], undefined, 'already encoded media is unchanged');
    const identityImage = await wire(base + '/icons/icon-192-2c.png', { 'accept-encoding': 'identity' });
    assert.deepEqual(image.body, identityImage.body);
  });
});

type Listener = (event: Record<string, unknown>) => void;
/** Runs the served sw.js against an in-memory Cache Storage and a fetch that can go offline. */
function worker(base: string, source: string) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, Response>>();
  const network: string[] = [];
  const notifications: { title: string; options: any }[] = [];
  const messages: unknown[] = [], opened: string[] = [];
  let hasWindow = true, focused = 0;
  let online = true;
  const key = (request: string | Request) => new URL(typeof request === 'string' ? request : request.url, base).pathname;
  const net = async (request: string | Request | { url: string }, init?: RequestInit) => {
    const url = new URL(typeof request === 'string' ? request : request.url, base);
    if (!online) throw new TypeError('Failed to fetch');
    network.push(url.pathname + url.search);
    return fetch(url, init);
  };
  const open = (name: string) => {
    const store = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, store);
    return {
      async addAll(requests: Request[]) {
        for (const request of requests) {
          const response = await net(request);
          assert.equal(response.status, 200, request.url);
          store.set(key(request), response);
        }
      },
      async put(request: string, response: Response) { store.set(key(request), response); },
      async match(request: string) { return store.get(key(request))?.clone(); },
    };
  };
  const caches = {
    open: async (name: string) => open(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const self = {
    location: new URL('/sw.js', base),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: async () => {},
    registration: { showNotification: async (title: string, options: unknown) => { notifications.push({ title, options }); } },
    clients: { claim: async () => {},
      matchAll: async () => hasWindow ? [{ url: base, focus: async () => { focused++; }, postMessage: (message: unknown) => messages.push(message) }] : [],
      openWindow: async (url: string) => { opened.push(url); } },
  };
  class RelativeRequest extends Request {
    constructor(input: string, init?: RequestInit) { super(new URL(input, base), init); }
  }
  runInNewContext(source, { self, caches, fetch: net, Request: RelativeRequest, URL, Set, JSON,
    AbortController, Response, setTimeout, clearTimeout });
  const dispatch = async (type: string, event: Record<string, unknown> = {}) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => { done = promise; } });
    await done;
  };
  const lifecycle = (type: string) => dispatch(type);
  /** The response the worker gives, or undefined when it leaves the request to the browser. */
  const request = async (path: string, init: { method?: string; mode?: string } = {}) => {
    let answer: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    listeners.get('fetch')!({
      request: { url: new URL(path, base).href, method: init.method ?? 'GET', mode: init.mode ?? 'cors' },
      respondWith: (promise: Promise<Response>) => { answer = promise; },
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    });
    const response = await answer;
    await Promise.all(pending);
    return response;
  };
  return { stores, network, lifecycle, dispatch, request, notifications, messages, opened,
    focused: () => focused, noWindows: () => { hasWindow = false; }, offline: () => { online = false; } };
}

test('hashed build files are kept for good; the screen and other files are revalidated by ETag; the API is never kept', async () => {
  await serve(async base => {
    const page = await fetch(base);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    const tag = page.headers.get('etag');
    const version = page.headers.get('x-alpacawork-build');
    assert.ok(version);
    assert.match(tag ?? '', /^"[-\w]+"$/);
    const html = await page.text();
    const unchanged = await fetch(base, { headers: { 'If-None-Match': `W/${tag}` } });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get('x-alpacawork-build'), version);
    assert.equal(await unchanged.text(), '');
    assert.equal(await httpStatus(base, { headers: { 'If-None-Match': '"other"' } }), 200);

    const script = html.match(/src="(\/assets\/[^" ]+\.js)"/)![1]!;
    const asset = await fetch(base + script);
    assert.equal(asset.headers.get('cache-control'), 'max-age=31536000, immutable');
    await asset.arrayBuffer();
    assert.equal(await httpStatus(base + script, { headers: { 'If-None-Match': asset.headers.get('etag')! } }), 304);
    for (const [path, policy] of [['/sw.js', 'no-cache'], ['/icons/icon-192-2c.png', 'no-cache'], ['/manifest.webmanifest', 'no-cache'], ['/api/workspace/live', 'no-store']]) {
      const response = await fetch(base + path);
      assert.equal(response.headers.get('cache-control'), policy, path);
      if (!path.startsWith('/api/')) assert.equal(response.headers.get('x-alpacawork-build'), version, path);
      await response.arrayBuffer();
    }
  });
});

test('offline build identity changes with the shell, worker policy and startup graph', () => {
  const folder = mkdtempSync(join(tmpdir(), 'alpacawork-build-identity-'));
  const packaged = fileURLToPath(new URL('../apps/backend/public/', import.meta.url));
  try {
    for (const name of ['index.html', 'manifest.webmanifest', 'pwa-colors.json', 'sw.js', 'mermaid-frame.html']) copyFileSync(join(packaged, name), join(folder, name));
    mkdirSync(join(folder, 'assets'));
    writeFileSync(join(folder, 'assets', 'entry.js'), 'export {};');
    writeFileSync(join(folder, 'assets', 'optional.js'), 'export const optional = true;');
    writeFileSync(join(folder, 'asset-manifest.json'), JSON.stringify({ 'index.html': { file: 'assets/entry.js', isEntry: true } }));
    const identity = () => {
      let body = '', headers: Record<string, string> = {};
      const response = { writeHead(_status: number, values: Record<string, string>) { headers = values; }, end(bytes: Buffer) { body = bytes.toString(); } } as unknown as ServerResponse;
      assert(createWebAssets(folder, folder)('/sw.js', {}, response));
      const build = JSON.parse(/const BUILD = (.*);/.exec(body)![1]!);
      assert.equal(headers['X-Alpacawork-Build'], build.version);
      return build.version;
    };
    const original = identity();
    for (const [name, change] of [
      ['index.html', (text: string) => text + '\n<!-- changed HTML -->'],
      ['sw.js', (text: string) => text + '\n// changed worker policy'],
      ['pwa-colors.json', () => JSON.stringify({ light: '#010203', dark: '#040506' })],
      ['manifest.webmanifest', (text: string) => JSON.stringify({ ...JSON.parse(text), name: 'Changed manifest' })],
      ['asset-manifest.json', () => JSON.stringify({ 'index.html': { file: 'assets/entry.js', isEntry: true, imports: ['_optional.js'] }, '_optional.js': { file: 'assets/optional.js' } })],
    ] as const) {
      const path = join(folder, name), bytes = readFileSync(path);
      writeFileSync(path, change(bytes.toString()));
      assert.notEqual(identity(), original, name);
      writeFileSync(path, bytes);
      assert.equal(identity(), original, 'restoring bytes restores the deterministic identity');
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('an incomplete Vite startup graph is rejected before a worker can replace the offline build', () => {
  const folder = mkdtempSync(join(tmpdir(), 'alpacawork-startup-integrity-'));
  const packaged = fileURLToPath(new URL('../apps/backend/public/', import.meta.url));
  try {
    for (const name of ['index.html', 'manifest.webmanifest', 'pwa-colors.json', 'sw.js']) copyFileSync(join(packaged, name), join(folder, name));
    mkdirSync(join(folder, 'assets'));
    const required = ['entry.js', 'imported.js', 'entry.css', 'image.svg'];
    for (const file of required) writeFileSync(join(folder, 'assets', file), 'synthetic startup asset');
    const graph = { 'index.html': { file: 'assets/entry.js', isEntry: true, imports: ['_imported.js'], css: ['assets/entry.css'], assets: ['assets/image.svg'] },
      '_imported.js': { file: 'assets/imported.js' } };
    const metadata = join(folder, 'asset-manifest.json');
    writeFileSync(metadata, JSON.stringify(graph));
    const candidate = () => createWebAssets(folder, folder);
    assert.doesNotThrow(candidate, 'complete graph can be published');
    for (const file of required) {
      const path = join(folder, 'assets', file), bytes = readFileSync(path);
      rmSync(path);
      assert.throws(candidate, /Missing Vite startup asset/, file);
      writeFileSync(path, bytes);
    }
    for (const incomplete of [
      { '_imported.js': graph['_imported.js'] },
      { ...graph, 'index.html': { ...graph['index.html'], isEntry: false } },
      { 'index.html': graph['index.html'] },
    ]) {
      writeFileSync(metadata, JSON.stringify(incomplete));
      assert.throws(candidate, /Missing Vite (HTML|build) entry/);
    }
    writeFileSync(metadata, JSON.stringify(graph));
    assert.doesNotThrow(candidate, 'restored complete graph can still be published');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the Service Worker keeps this build, drops earlier builds, and leaves the API and the feed to the network', async () => {
  await serve(async base => {
    const html = await (await fetch(base)).text();
    const script = html.match(/src="(\/assets\/[^" ]+\.js)"/)![1]!;
    const source = await (await fetch(base + '/sw.js')).text();
    assert.ok(!source.includes('__PWA_BUILD__'), 'serve writes the build into sw.js');
    const sw = worker(base, source);
    sw.stores.set('alpacawork-earlier', new Map());
    sw.stores.set('someone-else', new Map());
    sw.stores.set('share-inbox', new Map());

    await sw.lifecycle('install');
    const [name] = [...sw.stores.keys()].filter(key => key.startsWith('alpacawork-') && key !== 'alpacawork-earlier');
    assert.ok(name);
    const kept = sw.stores.get(name)!;
    for (const path of ['/', script, '/icons/icon-192-2c.png', '/icons/badge-96-2c.png']) assert.ok(kept.has(path), path);
    assert.ok(![...kept.keys()].some(path => path.startsWith('/api/')));
    await sw.lifecycle('activate');
    assert.deepEqual([...sw.stores.keys()].sort(), [name, 'share-inbox', 'someone-else']);

    // Optional renderers are build files, but installation never fetches them. They become available
    // offline after their first use, without turning a diagram-free visit into a Mermaid download.
    const build = JSON.parse(/const BUILD = (.*);/.exec(source)![1]!) as { files: string[]; precache: string[] };
    assert.ok(build.files.includes('/mermaid-frame.html'));
    assert.ok(!build.precache.includes('/mermaid-frame.html'), 'optional HTML is not fetched at install');
    assert.ok(!kept.has('/mermaid-frame.html'));
    const frame = await sw.request('/mermaid-frame.html');
    assert.equal(frame?.status, 200);
    assert.ok(kept.has('/mermaid-frame.html'), 'the renderer is kept after first use');
    const frameScript = (await frame!.text()).match(/src="(\/assets\/[^" ]+\.js)"/)![1]!;
    assert.ok(!build.precache.includes(frameScript), 'the renderer entry graph stays lazy');
    const lazy = build.files.find(path => path.startsWith('/assets/') && !build.precache.includes(path));
    assert.ok(lazy, 'the build contains dynamically imported chunks');
    assert.ok(!kept.has(lazy));
    const loaded = await sw.request(lazy);
    assert.equal(loaded?.status, 200);
    assert.ok(kept.has(lazy));
    // Build files come from the cache without the network.
    sw.network.length = 0;
    const asset = await sw.request(script);
    assert.equal(asset?.status, 200);
    assert.deepEqual(sw.network, []);
    // The API, the SSE feed, task files, the manifest, writes and other origins are not touched.
    for (const path of ['/api/workspace/live', '/api/events', '/api/tasks/T1/file?path=a.png', '/manifest.webmanifest', 'https://example.com/'])
      assert.equal(await sw.request(path), undefined, path);
    assert.equal(await sw.request('/', { method: 'POST', mode: 'navigate' }), undefined);

    // The screen comes from the network while serve answers, and from the cache when it does not.
    const screen = await sw.request('/?task=T1', { mode: 'navigate' });
    assert.equal(screen?.status, 200);
    assert.deepEqual(sw.network, ['/?task=T1']);
    sw.offline();
    assert.equal((await sw.request(lazy))?.status, 200, "a used lazy chunk works offline");
    const offlineFrame = await sw.request('/mermaid-frame.html');
    assert.equal(offlineFrame?.status, 200);
    assert.match(offlineFrame!.headers.get('content-security-policy')!, /img-src 'none'/);
    const offline = await sw.request('/?task=T2', { mode: 'navigate' });
    assert.equal(offline?.status, 200);
    assert.match(await offline!.text(), new RegExp(script.replace(/[.]/g, '\\.')));
  });
});

test('the served worker still shows Push and routes notification taps to an existing or new window', async () => {
  await serve(async base => {
    const sw = worker(base, await (await fetch(base + '/sw.js')).text());
    await sw.dispatch('push', { data: { json: () => ({ title: 'Task', body: 'Ready', url: '/?task=T1', tag: 'task' }) } });
    assert.equal(sw.notifications[0]!.title, 'Task');
    assert.equal(sw.notifications[0]!.options.data.url, '/?task=T1');
    assert.equal(sw.notifications[0]!.options.renotify, true);
    let closed = 0;
    await sw.dispatch('notificationclick', { notification: { close: () => { closed++; }, data: { url: '/?task=T1&settings=push' } } });
    assert.equal(closed, 1); assert.equal(sw.focused(), 1);
    assert.equal(JSON.stringify(sw.messages), JSON.stringify([{ type: 'open-task', task: 'T1', settings: 'push', search: '?task=T1&settings=push' }]));
    const automationUrl = '/?face=settings&automation=A12';
    await sw.dispatch('notificationclick', { notification: { close: () => { closed++; }, data: { url: automationUrl } } });
    assert.equal(JSON.stringify(sw.messages.at(-1)), JSON.stringify({
      type: 'open-task', task: null, settings: null, search: automationUrl.slice(1),
    }));
    assert.equal(closed, 2); assert.equal(sw.focused(), 2);
    sw.noWindows();
    await sw.dispatch('notificationclick', { notification: { close: () => { closed++; }, data: { url: '/?task=T2' } } });
    await sw.dispatch('notificationclick', { notification: { close: () => { closed++; }, data: { url: automationUrl } } });
    assert.deepEqual(sw.opened, [base + '/?task=T2', base + automationUrl]); assert.equal(closed, 4);
  });
});

test('the installed app is a share target for files of any kind; a share that reaches serve without the worker opens the screen', async () => {
  await serve(async base => {
    const manifest = await (await fetch(base + '/manifest.webmanifest')).json() as { share_target: unknown };
    assert.deepEqual(manifest.share_target, { action: '/share', method: 'POST', enctype: 'multipart/form-data',
      params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: ['*/*'] }] } });
    const form = new FormData();
    form.append('text', 'x');
    form.append('files', new Blob([new Uint8Array(8)], { type: 'image/png' }), 'a.png');
    for (const headers of [{}, { Origin: 'null' }]) {
      const answer = await fetch(base + '/share', { method: 'POST', body: form, headers, redirect: 'manual' });
      assert.equal(answer.status, 303);
      assert.equal(answer.headers.get('location'), '/');
    }
  });
});


test('a build missing asset-manifest.json still serves sw.js and precaches every known build file', () => {
  const folder = mkdtempSync(join(tmpdir(), 'alpacawork-sw-no-manifest-'));
  const packaged = fileURLToPath(new URL('../apps/backend/public/', import.meta.url));
  try {
    for (const name of ['index.html', 'manifest.webmanifest', 'pwa-colors.json', 'sw.js', 'mermaid-frame.html']) copyFileSync(join(packaged, name), join(folder, name));
    mkdirSync(join(folder, 'assets'));
    writeFileSync(join(folder, 'assets', 'entry.js'), 'export {};');
    writeFileSync(join(folder, 'assets', 'optional.js'), 'export {};');
    const sent: { status: number; body: Buffer } = { status: 0, body: Buffer.alloc(0) };
    const response = { writeHead(status: number) { sent.status = status; }, end(bytes: Buffer) { sent.body = bytes; } } as unknown as ServerResponse;
    const serve = createWebAssets(folder, folder);
    assert.equal(serve('/sw.js', {}, response), true);
    assert.equal(sent.status, 200);
    const build = JSON.parse(/const BUILD = (.*);/.exec(sent.body.toString())![1]!) as { files: string[]; precache: string[] };
    assert.deepEqual(build.files, ['/', '/assets/entry.js', '/assets/optional.js', '/mermaid-frame.html']);
    assert.deepEqual(build.precache, build.files);
    // Corrupt metadata is a fault, not the deliberately supported missing-metadata case.
    writeFileSync(join(folder, 'asset-manifest.json'), '{broken');
    assert.throws(() => createWebAssets(folder, folder), SyntaxError);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});


test('the optional Mermaid document alone has a resource-free rendering CSP, including on 304', async () => {
  await serve(async base => {
    const response = await fetch(base + '/mermaid-frame.html');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /^text\/html/);
    const csp = response.headers.get('content-security-policy')!;
    for (const directive of ['default-src', 'img-src', 'media-src', 'font-src', 'connect-src', 'frame-src', 'object-src', 'worker-src', 'base-uri', 'form-action'])
      assert.ok(csp.split(';').some(part => part.trim() === `${directive} 'none'`), directive);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'unsafe-inline'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.ok(!csp.includes('unsafe-eval'));
    assert.ok(!csp.includes("img-src 'self'"));
    const unchanged = await fetch(base + '/mermaid-frame.html', { headers: { 'If-None-Match': response.headers.get('etag')! } });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get('content-security-policy'), csp);
    assert.notEqual((await fetch(base)).headers.get('content-security-policy'), csp);
  });
});
