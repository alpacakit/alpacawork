// The alpacawork screen's Service Worker. It receives Web Push, opens
// the screen on tap, and keeps the screen's build files so the app opens without downloading
// them again. serve writes this build's files and version into BUILD; the dev server leaves
// the empty list, so nothing is cached there.
const BUILD = /*__PWA_BUILD__*/{ version: "dev", files: [], precache: [] };
const CACHE = "alpacawork-" + BUILD.version;
const FILES = new Set(BUILD.files);
const NETWORK_DEADLINE_MS = 5000;

// A redirect is a routing decision, and no-store is authoritative even for Cache.put().
function canKeep(response) {
  return !response.redirected && !(response.status >= 300 && response.status < 400)
    && !/\bno-store\b/i.test(response.headers.get("Cache-Control") ?? "");
}

// The startup graph is fetched before takeover. Lazy chunks are cached only when used; a diagram-free
// visit never downloads Mermaid. A complete new worker waits until old clients close.
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      const responses = await Promise.all(BUILD.precache.map(async (file) => {
        const response = await fetch(new Request(file, { cache: "no-cache" }));
        if (!canKeep(response)) return null;
        if (!response.ok || response.headers.get("X-Alpacawork-Build") !== BUILD.version)
          throw new Error(`Cannot install ${BUILD.version}: ${file} is unavailable or belongs to another build`);
        return [file, response];
      }));
      for (const entry of responses) if (entry) await cache.put(entry[0], entry[1]);
    } catch (error) {
      await caches.delete(CACHE).catch((cleanup) => console.warn("Cannot remove incomplete build cache", cleanup));
      throw error;
    }
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("alpacawork-") && name !== CACHE) await caches.delete(name);
  })());
});

// Mutable build URLs always revalidate online. Only a response from this worker's own
// build may refresh its offline copy; another build can be displayed without corrupting it.
async function networkFirst(event, pathname) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(pathname);
  const kept = cached && canKeep(cached) ? cached : undefined;
  const controller = new AbortController();
  let timer;
  const network = async () => {
    const response = await fetch(event.request, { cache: "no-cache", signal: controller.signal });
    if (kept && response.status >= 500 && response.status < 600) { controller.abort(); return kept; }
    if (!response.ok) return response;
    // The deadline covers the whole body, not merely the arrival of headers. Keep the
    // original response so its URL, encoding, validators and CSP remain authoritative.
    await response.clone().arrayBuffer();
    if (!controller.signal.aborted && canKeep(response) && response.headers.get("X-Alpacawork-Build") === BUILD.version) {
      const copy = response.clone();
      event.waitUntil((async () => {
        try { await cache.put(pathname, copy); }
        catch (error) { console.warn("Cannot refresh offline build file", pathname, error); }
      })());
    }
    return response;
  };
  try {
    return kept ? await Promise.race([network(), new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(kept); }, NETWORK_DEADLINE_MS);
    })]) : await network();
  } catch {
    controller.abort();
    return kept ?? Response.error();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Hashed files remain cache-first. Mutable URLs share the same network-first rule.
// API calls, the SSE feed, task files and the manifest are never touched.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method === "POST" && url.origin === self.location.origin && url.pathname === "/share") {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (FILES.has(url.pathname) && !url.pathname.startsWith("/assets/") && (url.pathname !== "/" || request.mode === "navigate")) {
    event.respondWith(networkFirst(event, url.pathname));
  } else if (url.pathname !== "/" && FILES.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const kept = await cache.match(url.pathname);
      if (kept) return kept;
      const response = await fetch(request);
      if (response.ok && canKeep(response)) await cache.put(url.pathname, response.clone());
      return response;
    })());
  }
});

// Shared from another app (manifest share_target): the files and words wait in their own cache, which a new build
// leaves alone, until the screen opening next puts them into the coordinator's input and empties it
// (features/coordinator/shared.ts). Only the latest share waits; the list is written last, so a half-kept share is
// never taken. A file the device cannot keep (its storage full), or one larger than any attachment limit allows (500 MiB,
// LIMIT_MAXIMUM.attachment_mib in contract/server-settings.ts), is listed without its bytes, so the others still come and
// the input says which one did not and why. The worker cannot read the workspace's limit; the input applies it.
const SHARE_INBOX = "share-inbox";
const SHARE_MAX_BYTES = 500 * 1024 * 1024;
async function receiveShare(request) {
  return self.navigator.locks ? self.navigator.locks.request(SHARE_INBOX, () => storeShare(request)) : storeShare(request);
}
async function storeShare(request) {
  try {
    const form = await request.formData();
    const words = (name) => { const value = form.get(name); return typeof value === "string" ? value : ""; };
    const files = form.getAll("files").filter((file) => typeof file !== "string" && file.size > 0);
    await caches.delete(SHARE_INBOX);
    const inbox = await caches.open(SHARE_INBOX);
    await Promise.all(files.map((file, index) => file.size <= SHARE_MAX_BYTES && inbox.put(`/share/${index}`, new Response(file))
      .catch((error) => console.warn("A shared file could not be kept", error))));
    await inbox.put("/share/list", Response.json({ id: crypto.randomUUID(), at: Date.now(), title: words("title"), text: words("text"), url: words("url"),
      files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })) }));
  } catch (error) {
    console.warn("A share could not be kept", error);
  }
  return Response.redirect(new URL("/", self.location.origin).href, 303);
}

self.addEventListener("push", (event) => {
  let payload = null;
  try { payload = event.data ? event.data.json() : null; } catch { payload = null; }
  const title = payload && typeof payload.title === "string" && payload.title ? payload.title : "alpacawork";
  const body = payload && typeof payload.body === "string" ? payload.body : "";
  const url = payload && typeof payload.url === "string" && /^\/(\?[^\s#]*)?$/.test(payload.url) ? payload.url : "/";
  const tag = payload && typeof payload.tag === "string" && payload.tag ? payload.tag : undefined;
  event.waitUntil(self.registration.showNotification(title, {
    body, tag, data: { url }, icon: "/icons/icon-192-2c.png", badge: "/icons/badge-96-2c.png", renotify: !!tag,
  }));
});

// Tap: an open window moves to the destination; otherwise the destination opens in a new window.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data && event.notification.data.url ? event.notification.data.url : "/", self.location.origin);
  const task = url.searchParams.get("task");
  const settings = url.searchParams.get("settings");
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find((item) => new URL(item.url).origin === self.location.origin);
    if (client) {
      await client.focus();
      client.postMessage({ type: "open-task", task, settings, search: url.search });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
