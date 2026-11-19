// Measure what the screen fetches and how long the user waits, against a running serve on a
// measurement root. Started by run.mjs; it can also be run alone against a serve you started.
// Usage: node e2e/perf/measure.mjs --origin <url> --root <root> --serve-pid <pid> --out <file>
//          [--heavy T42] [--word sol] [--updates 5] [--interval 4000] [--first-row-timeout 120000]
//          [--render-counts] (React commit hook; omitting it keeps CPU measurements clean)
//
// Writes go to the measurement root only, with this worktree's CLI (as an agent's report would):
// one title change per update, so serve sees it through its file watch like any agent write.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: args } = parseArgs({ options: {
  origin: { type: "string" }, root: { type: "string" }, "serve-pid": { type: "string" }, out: { type: "string" },
  heavy: { type: "string", default: "T42" }, word: { type: "string", default: "sol" },
  "update-id": { type: "string" },
  updates: { type: "string", default: "5" }, interval: { type: "string", default: "4000" },
  "first-row-timeout": { type: "string", default: "120000" },
  "render-counts": { type: "boolean", default: false },
} });
for (const key of ["origin", "root", "serve-pid", "out"]) if (!args[key]) throw new Error(`--${key} is required`);
const origin = args.origin, servePid = Number(args["serve-pid"]);
const backend = fileURLToPath(new URL("../../apps/backend/dist/backend.js", import.meta.url));
const out = { origin, phases: {} };

/** CPU seconds serve has used so far (user + system), from ps. */
function serveCpu() {
  const ps = spawnSync("/bin/ps", ["-o", "cputime=", "-p", String(servePid)], { encoding: "utf8" });
  const parts = ps.stdout.trim().split(/[:.]/).map(Number); // [h:]mm:ss.cc
  if (ps.status !== 0 || parts.some(Number.isNaN)) throw new Error(`ps failed for serve ${servePid}`);
  const [cc, ss, mm, hh = 0] = parts.reverse();
  return hh * 3600 + mm * 60 + ss + cc / 100;
}
function cli(...rest) {
  const done = spawnSync(process.execPath, [backend, "--workspace", args.root, ...rest], { encoding: "utf8" });
  if (done.status !== 0) throw new Error(`CLI ${rest.join(" ")} failed: ${done.stderr}`);
  return JSON.parse(done.stdout);
}
const median = (xs) => { const s = xs.filter((x) => x !== null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

const browser = await chromium.launch({ args: ["--disable-background-networking", "--disable-component-update"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "Asia/Tokyo" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  const reqs = new Map();
  cdp.on("Network.requestWillBeSent", (e) => reqs.set(e.requestId, { url: e.request.url, start: e.timestamp }));
  cdp.on("Network.responseReceived", (e) => { const r = reqs.get(e.requestId); if (r) r.status = e.response.status; });
  cdp.on("Network.loadingFinished", (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.bytes = e.encodedDataLength; } });
  const mark = () => new Set(reqs.keys());
  const since = (before) => [...reqs.entries()].filter(([id]) => !before.has(id)).map(([, r]) => ({
    path: r.url.replace(origin, "").slice(0, 1000), status: r.status ?? null, bytes: r.bytes ?? null,
    ms: r.end ? Math.round((r.end - r.start) * 1000) : null }));
  /** Renderer main-thread busy time (CDP TaskDuration), in ms. */
  const busy = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value * 1000;
  const heap = async () => {
    const m = (await cdp.send("Performance.getMetrics")).metrics;
    return { jsHeapMB: +(m.find((x) => x.name === "JSHeapUsedSize").value / 1048576).toFixed(1), nodes: m.find((x) => x.name === "Nodes").value };
  };

  await page.addInitScript((renderCounts) => {
    // Count React commits and component work without changing the application build.
    // The hook must exist before React loads. These counts are separate from CDP timings:
    // walking fibers itself costs time, so use an uninstrumented run for CPU comparisons.
    if (renderCounts) {
      const renders = window.__renders = { phase: "initial", phases: {} };
      const componentTags = new Set([0, 1, 11, 14, 15]);
      const phase = () => (renders.phases[renders.phase] ||= { commits: 0, renders: 0, mounts: 0, reactMs: 0, byName: {} });
      const walk = (fiber) => {
        if (componentTags.has(fiber.tag) && (!fiber.alternate || (fiber.flags & 1))) {
          const type = fiber.type?.type ?? fiber.type?.render ?? fiber.type;
          const name = type?.displayName ?? type?.name ?? "Anonymous";
          const entry = phase().byName[name] ||= { renders: 0, mounts: 0, selfMs: 0 };
          let childMs = 0;
          for (let child = fiber.child; child; child = child.sibling) childMs += child.actualDuration || 0;
          entry.selfMs += Math.max(0, (fiber.actualDuration || 0) - childMs);
          if (fiber.alternate) { entry.renders++; phase().renders++; }
          else { entry.mounts++; phase().mounts++; }
        }
        if (fiber.alternate && fiber.alternate.child === fiber.child) return;
        for (let child = fiber.child; child; child = child.sibling) walk(child);
      };
      let rendererId = 0;
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        renderers: new Map(), supportsFiber: true, isDisabled: false, checkDCE() {},
        inject(renderer) { this.renderers.set(++rendererId, renderer); return rendererId; },
        onCommitFiberRoot(_id, root) { phase().commits++; phase().reactMs += root.current.actualDuration || 0; walk(root.current); },
        onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
      };
    }
    // SSE bytes as the page reads them (CDP does not report the later chunks of a streamed fetch).
    window.__sse = [];
    const original = window.fetch;
    window.fetch = async (...input) => {
      const response = await original(...input);
      if (!String(input[0]).endsWith("/api/events") || !response.body) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream({ async pull(controller) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        window.__sse.push({ at: performance.now(), n: value.length,
          hit: !!window.__marker && new TextDecoder().decode(value).includes(window.__marker) });
        controller.enqueue(value);
      }, cancel(reason) { return reader.cancel(reason); } });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    window.__long = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push({ at: e.startTime, d: e.duration }); })
      .observe({ type: "longtask", buffered: true });
  }, args["render-counts"]);
  const longBetween = (from, to = Infinity) => page.evaluate(([from, to]) => {
    const l = window.__long.filter((e) => e.at >= from && e.at <= to);
    return { count: l.length, totalMs: Math.round(l.reduce((s, e) => s + e.d, 0)), maxMs: Math.round(Math.max(0, ...l.map((e) => e.d))) };
  }, [from, to]);
  const now = () => page.evaluate(() => performance.now());
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const renderPhase = async (name) => {
    if (args["render-counts"]) await page.evaluate((name) => { window.__renders.phase = name; }, name);
  };
  const rendered = async (name) => args["render-counts"] ? page.evaluate((name) => window.__renders.phases[name] ??
    { commits: 0, renders: 0, mounts: 0, byName: {} }, name) : null;
  // The reader's report feed appears when its task view has loaded.
  const contentShown = () => page.locator('[data-reader-content] [data-report-feed]').waitFor({ timeout: 60_000 });

  // 1. Initial display: navigation -> first task row visible.
  {
    const before = mark(), wall = Date.now();
    await page.goto(origin, { waitUntil: "commit", timeout: Number(args["first-row-timeout"]) });
    try { await page.locator("li[data-row]").first().waitFor({ state: "visible", timeout: Number(args["first-row-timeout"]) }); }
    catch { out.phases.initial = { failed: `no task row within ${args["first-row-timeout"]} ms`, requests: since(before) }; throw new Error("stop"); }
    const firstRowMs = Date.now() - wall;
    await settle();
    const nav = await page.evaluate(() => {
      const big = window.__sse.filter((c) => c.n > 64);
      return { snapshotFirstByteMs: big.length ? Math.round(big[0].at) : null, snapshotLastByteMs: big.length ? Math.round(big.at(-1).at) : null,
        snapshotBytes: big.reduce((s, c) => s + c.n, 0) };
    });
    out.phases.initial = { firstRowMs, ...nav, rows: await page.locator("li[data-row]").count(),
      requests: since(before), long: await longBetween(0), ...(await heap()),
      ...(args["render-counts"] ? { react: await rendered("initial") } : {}) };
  }
  const updateId = args["update-id"] ?? await page.locator("li[data-row]").first().getAttribute("data-row");
  out.updateId = updateId;
  {
    const before = mark(), t0 = await now(), wall = Date.now();
    await renderPhase("scroll");
    const tree = page.locator('[data-time-tree]');
    const range = await tree.evaluate((element) => element.scrollHeight - element.clientHeight);
    await tree.evaluate((element) => { element.scrollTop = Math.min(400, element.scrollHeight - element.clientHeight); });
    await settle();
    await tree.evaluate((element) => { element.scrollTop = 0; });
    await settle();
    out.phases.scroll = { range, ms: Date.now() - wall, requests: since(before), long: await longBetween(t0),
      ...(args["render-counts"] ? { react: await rendered("scroll") } : {}) };
  }
  await page.waitForTimeout(1500);

  // 2. Open a task from its row, then the heaviest task the way links and back/forward do.
  {
    const before = mark(), t0 = await now(), wall = Date.now();
    await renderPhase("openTask");
    await page.locator(`li[data-row="${updateId}"] [data-read]`).click();
    await page.getByRole("complementary").locator("[data-reader-task-id]").filter({ hasText: updateId }).waitFor({ timeout: 60_000 });
    const headingMs = Date.now() - wall;
    await contentShown();
    await settle();
    out.phases.openTask = { id: updateId, ms: headingMs, contentMs: Date.now() - wall, requests: since(before), long: await longBetween(t0),
      ...(args["render-counts"] ? { react: await rendered("openTask") } : {}) };
  }
  await page.waitForTimeout(800);
  {
    const before = mark(), t0 = await now(), wall = Date.now();
    await renderPhase("openHeavy");
    await page.evaluate((id) => { history.pushState(null, "", `?task=${id}`); dispatchEvent(new PopStateEvent("popstate")); }, args.heavy);
    await page.getByRole("complementary").locator("[data-reader-task-id]").filter({ hasText: args.heavy }).waitFor({ timeout: 60_000 });
    const headingMs = Date.now() - wall;
    await contentShown();
    await settle();
    out.phases.openHeavy = { id: args.heavy, ms: headingMs, contentMs: Date.now() - wall, requests: since(before), long: await longBetween(t0),
      ...(args["render-counts"] ? { react: await rendered("openHeavy") } : {}) };
  }
  await page.waitForTimeout(800);

  // 3. The report feed is the History surface; opening a report reveals its body.
  {
    const before = mark(), t0 = await now(), wall = Date.now();
    await renderPhase("history");
    const report = page.locator('[data-report-key]').last();
    if (await report.count()) await report.locator('button').first().click();
    await settle();
    const shownMs = Date.now() - wall;
    for (let i = 0; i < 200 && [...reqs.entries()].some(([id, r]) => !before.has(id) && !r.end && !r.url.endsWith("/api/events")); i++)
      await page.waitForTimeout(50);
    out.phases.tabHistory = { shownMs, readsDoneMs: Date.now() - wall, requests: since(before), long: await longBetween(t0),
      ...(args["render-counts"] ? { react: await rendered("history") } : {}) };
  }
  {
    const trigger = page.locator('[data-reader-path] span > button, [data-task-reference]').first();
    if (await trigger.count()) {
      const before = mark(), t0 = await now(), wall = Date.now();
      await renderPhase('hover');
      try {
        await trigger.hover({ timeout: 2000 });
        await page.locator('[data-badge-card]').first().waitFor({ timeout: 5_000 });
        await settle();
        out.phases.hover = { ms: Date.now() - wall, requests: since(before), long: await longBetween(t0),
          ...(args['render-counts'] ? { react: await rendered('hover') } : {}) };
        await page.mouse.move(5, 5);
      } catch {
        out.phases.hover = { unavailable: 'Reference is covered or has no hover card' };
      }
    } else out.phases.hover = { unavailable: 'No back link on the selected task' };
  }
  // The updates below watch the first row after returning from the heavy task.
  await page.evaluate((id) => { history.pushState(null, "", `?task=${id}`); dispatchEvent(new PopStateEvent("popstate")); }, updateId);
  await page.locator(`li[data-row="${updateId}"]`).waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(500);

  // Draft typing stays in the browser; no request is submitted.
  {
    const input = page.locator('[data-composer-dock] textarea').first();
    if (await input.count()) {
      const before = mark(), t0 = await now(), wall = Date.now();
      await renderPhase("input");
      await input.fill('performance measurement draft');
      await settle();
      out.phases.input = { ms: Date.now() - wall, requests: since(before), long: await longBetween(t0),
        ...(args["render-counts"] ? { react: await rendered("input") } : {}) };
      await input.fill('');
    } else out.phases.input = { unavailable: 'No input on the selected task' };
  }

  // 4. Idle with the screen open: serve and renderer CPU while nothing changes.
  const updates = Number(args.updates), interval = Number(args.interval);
  {
    const windowMs = updates * interval;
    await renderPhase("idle");
    const cpu0 = serveCpu(), busy0 = await busy(), n0 = await page.evaluate(() => window.__sse.length);
    await page.waitForTimeout(windowMs);
    const frames = await page.evaluate((n0) => window.__sse.slice(n0).filter((c) => c.n > 1024).length, n0);
    out.phases.idle = { windowMs, serveCpuPct: +((serveCpu() - cpu0) * 100000 / windowMs).toFixed(1),
      rendererBusyPct: +(((await busy()) - busy0) * 100 / windowMs).toFixed(1), largeChunks: frames,
      ...(args["render-counts"] ? { react: await rendered("idle") } : {}) };
  }

  // 5. Updates while the screen is open: one external title write each, as an agent's report would land.
  {
    let { task } = cli("task", "get", "--task", updateId);
    const title = task.title.slice(0, 80);
    const rows = [];
    const cpu0 = serveCpu(), busy0 = await busy(), started = Date.now();
    for (let i = 0; i < updates; i++) {
      await renderPhase(`update-${i}`);
      const before = mark();
      const marker = `perf-${i}-${Date.now()}`;
      await page.evaluate(([id, marker]) => {
        const watch = window.__watch = { domAt: null, paintAt: null };
        const row = () => document.querySelector(`li[data-row="${CSS.escape(id)}"]`);
        const observer = new MutationObserver(() => {
          if (watch.domAt !== null || !row()?.textContent.includes(marker)) return;
          watch.domAt = performance.now();
          observer.disconnect();
          requestAnimationFrame(() => setTimeout(() => { watch.paintAt = performance.now(); }, 0));
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      }, [updateId, marker]);
      const n0 = await page.evaluate(() => window.__sse.length), b0 = await busy();
      ({ task } = cli("task", "update", "--task", updateId, "--title", `${title} ${marker}`, "--expected-task-hash", task.hash));
      const writtenAt = await now();
      try { await page.waitForFunction(() => window.__watch.paintAt !== null, null, { timeout: 180_000, polling: 10 }); }
      catch (error) {
        out.phases.updates = { failed: String(error), written: task.title, watch: await page.evaluate(([id, n0]) => ({ ...window.__watch,
          chunks: window.__sse.slice(n0).map((c) => c.n), rows: [...document.querySelectorAll(`li[data-row="${CSS.escape(id)}"]`)].map((e) => e.textContent) }), [updateId, n0]) };
        throw new Error("stop");
      }
      const seen = await page.evaluate(([n0]) => {
        const watch = window.__watch;
        const big = window.__sse.slice(n0).filter((c) => c.n > 64 && c.at <= watch.domAt);
        return { ...watch, firstByte: big[0]?.at ?? null, lastByte: big.at(-1)?.at ?? null, bytes: big.reduce((s, c) => s + c.n, 0) };
      }, [n0]);
      await page.waitForTimeout(300);
      const round = (x) => x === null ? null : Math.round(x);
      rows.push({
        writtenToFirstByteMs: round(seen.firstByte - writtenAt), downloadMs: round(seen.lastByte - seen.firstByte),
        lastByteToDomMs: round(seen.domAt - seen.lastByte), lastByteToPaintMs: round(seen.paintAt - seen.lastByte),
        writtenToPaintMs: round(seen.paintAt - writtenAt), bytes: seen.bytes,
        requests: since(before),
        long: await longBetween(seen.firstByte ?? writtenAt, seen.paintAt), mainThreadMs: Math.round((await busy()) - b0),
        ...(args["render-counts"] ? { react: await rendered(`update-${i}`) } : {}),
      });
      await page.waitForTimeout(Math.max(0, started + (i + 1) * interval - Date.now()));
    }
    const windowMs = Date.now() - started;
    const pick = (key) => rows.map((row) => row[key]);
    out.phases.updates = { count: updates, intervalMs: interval, windowMs,
      serveCpuPct: +((serveCpu() - cpu0) * 100000 / windowMs).toFixed(1),
      serveCpuMsPerUpdate: Math.round((serveCpu() - cpu0) * 1000 / updates),
      rendererBusyPct: +(((await busy()) - busy0) * 100 / windowMs).toFixed(1),
      median: Object.fromEntries(["writtenToFirstByteMs", "downloadMs", "lastByteToDomMs", "lastByteToPaintMs", "writtenToPaintMs", "bytes", "mainThreadMs"]
        .map((key) => [key, median(pick(key))])),
      longMedianTotalMs: median(rows.map((row) => row.long.totalMs)), longMaxMs: Math.max(...rows.map((row) => row.long.maxMs)),
      rows };
  }
  // 6. Search: type the word one key at a time, until the result count shows.
  {
    const box = page.locator('input[type="search"]');
    const before = mark();
    const t0 = await now(), wall = Date.now();
    await renderPhase("search");
    await box.click();
    await box.pressSequentially(args.word, { delay: 0 });
    await page.getByText(/\d+ tasks?/).first().waitFor({ timeout: 30_000 });
    await settle();
    out.phases.search = { ms: Date.now() - wall, rows: await page.getByText(/\d+ tasks?/).first().innerText(),
      requests: since(before), long: await longBetween(t0),
      ...(args["render-counts"] ? { react: await rendered("search") } : {}) };
  }
  {
    const before = mark(), t0 = await now(), wall = Date.now();
    await renderPhase('searchScroll');
    const range = await page.locator('[data-result-list]').evaluate((element) => {
      const scroller = element.parentElement;
      const range = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = Math.min(range, 700);
      return range;
    });
    await settle();
    out.phases.searchScroll = { range, ms: Date.now() - wall, requests: since(before), long: await longBetween(t0),
      ...(args['render-counts'] ? { react: await rendered('searchScroll') } : {}) };
    await page.locator('[data-result-list]').evaluate((element) => { element.parentElement.scrollTop = 0; });
  }

  // 7. A live update unrelated to the search must leave its current matches on screen.
  {
    const before = mark(), t0 = await now(), wall = Date.now();
    await renderPhase("searchLive");
    const prior = await page.locator('[data-result]').count();
    await page.evaluate(() => {
      window.__searchRows = [document.querySelectorAll('[data-result]').length];
      window.__searchObserver = new MutationObserver(() =>
        window.__searchRows.push(document.querySelectorAll('[data-result]').length));
      window.__searchObserver.observe(document.querySelector('[data-result-list]'), { childList: true, subtree: true });
    });
    let { task } = cli("task", "get", "--task", updateId);
    const marker = `search-perf-${Date.now()}`;
    await page.evaluate((marker) => { window.__marker = marker; }, marker);
    ({ task } = cli("task", "update", "--task", updateId, "--title", `${task.title} ${marker}`, "--expected-task-hash", task.hash));
    await page.waitForFunction(() => window.__sse.some((event) => event.hit), null, { timeout: 30_000 });
    await page.waitForTimeout(1200);
    const counts = await page.evaluate(() => { window.__searchObserver.disconnect(); return window.__searchRows; });
    out.phases.searchLive = { ms: Date.now() - wall, prior, minRows: Math.min(...counts), after: await page.locator('[data-result]').count(),
      requests: since(before), long: await longBetween(t0),
      ...(args["render-counts"] ? { react: await rendered("searchLive") } : {}) };
  }

  // 8. Opening settings reads only the settings resources used by that dialog.
  {
    const button = page.getByRole('button', { name: /Settings/i }).first();
    if (await button.count()) {
      const before = mark(), t0 = await now(), wall = Date.now();
      await renderPhase('settings');
      await button.click();
      await settle();
      out.phases.settings = { ms: Date.now() - wall, requests: since(before), long: await longBetween(t0),
        ...(args['render-counts'] ? { react: await rendered('settings') } : {}) };
    } else out.phases.settings = { unavailable: 'Settings button not found' };
  }

  out.final = await heap();
} catch (error) {
  if (error.message !== "stop") { out.error = String(error.stack ?? error); }
} finally {
  await browser.close();
  writeFileSync(args.out, JSON.stringify(out, null, 1));
}
