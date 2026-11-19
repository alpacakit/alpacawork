#!/usr/bin/env node
/** Reproducible measurements over synthetic copies. Also runs against a built main checkout via --repo. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Page } from '@playwright/test';
import { ControlStore, holdControlWriter } from '@alpacawork/db';
import { createOriginal, copyWorkspace, removeWorkspace } from '../dev-fixtures/fixture.ts';

export interface Sample { readonly n: number; readonly median: number | null; readonly p95: number | null; readonly max: number | null; readonly values: readonly number[] }
export function summarize(values: readonly number[]): Sample {
  const ordered = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  return { n: ordered.length, median: ordered.length ? ordered[Math.floor(ordered.length / 2)]! : null,
    p95: ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * .95))]! : null, max: ordered.at(-1) ?? null, values: ordered };
}
interface Timing { [key: string]: unknown; step?: string }
const ownRepo = fileURLToPath(new URL('../../', import.meta.url));
const options = parseArgs({ options: { repo: { type: 'string', default: ownRepo }, output: { type: 'string' },
  scales: { type: 'string', default: '1,2' }, samples: { type: 'string', default: '3' }, burst: { type: 'string', default: '6' },
  'closed-burst': { type: 'string', default: '160' }, 'deadline-seconds': { type: 'string', default: '600' }, smoke: { type: 'boolean' }, help: { type: 'boolean' } } }).values;
if (options.help) {
  console.log('node scripts/projection-perf/run.ts --output /absolute/evidence [--repo /built/checkout] [--scales 1,2] [--samples 3] [--burst 6] [--deadline-seconds 600]');
} else await main();
async function main() {
  if (!options.output) throw new Error('--output is required; evidence survives cleanup');
  const output = resolve(options.output), repo = resolve(options.repo!), samples = Number(options.samples), burst = Number(options.burst), deadline = Number(options['deadline-seconds']), closedBurst = Number(options['closed-burst']);
  const scales = options.scales!.split(',').map(Number);
  if (![samples, burst, closedBurst, deadline, ...scales].every(n => Number.isSafeInteger(n) && n > 0) || deadline > 3600) throw new Error('Counts must be positive integers; deadline must be at most 3600 seconds');
  for (const path of ['apps/backend/dist/backend.js', 'apps/cli/dist/cli.js', 'apps/backend/public/index.html'])
    if (!existsSync(join(repo, path))) throw new Error(`Build before measuring: ${join(repo, path)}`);
  mkdirSync(output, { recursive: true });
  const sandbox = mkdtempSync(join(tmpdir(), 'projection-perf-')), home = join(sandbox, 'home'); mkdirSync(home);
  const environment: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), COREPACK_ENABLE_NETWORK: '0', ALPACAWORK_TELEMETRY_DISABLED: '1' };
  const results: unknown[] = [];
  try {
    for (const scale of scales) {
      const counts = options.smoke ? { tasks: 14, logs: 19, runs: 7 } : { tasks: 710 * scale, logs: 43000 * scale, runs: 17400 * scale };
      const original = createOriginal({ ...counts, seed: 'projection-performance-v1' }, join(sandbox, 'cache'));
      const root = copyWorkspace(original.root, join(sandbox, `workspace-${scale}`)).root;
      let diagnosticPage: Page | undefined;
      let server: ChildProcess | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      const timing: Timing[] = [], log = createWriteStream(join(output, `server-${scale}.log`));
      const metadata = { repo, sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
        dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), node: process.version, counts, fixtureKey: original.key,
        seed: original.spec.seed, at: new Date().toISOString(), scale, deadlineSeconds: deadline };
      writeFileSync(join(output, `metadata-${scale}.json`), JSON.stringify(metadata, null, 2));
      try {
        prepareReview(root);
        let stdout = '', stderrBuffer = '';
        server = spawn('timeout', ['--signal=TERM', '--kill-after=10s', `${deadline}s`, process.execPath, '--import', fileURLToPath(new URL('./event-loop.ts', import.meta.url)),
          join(repo, 'apps/backend/dist/backend.js'), '--workspace', root, 'workspace', 'serve', '--port', '0', '--timing'],
        { cwd: sandbox, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        writeFileSync(join(output, `process-${scale}.json`), JSON.stringify({ timeoutPid: server.pid, root, home }));
        server.stdout!.on('data', bytes => { stdout += String(bytes); log.write(bytes); });
        server.stderr!.on('data', bytes => {
          log.write(bytes); stderrBuffer += String(bytes); const lines = stderrBuffer.split('\n'); stderrBuffer = lines.pop()!;
          for (const line of lines) try { const value = JSON.parse(line); if (value.timing) timing.push(value); } catch { /* Non-JSON diagnostics stay in the log. */ }
        });
        const base = await until(() => stdout.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.url ? [value.url as string] : []; } catch { return []; } })[0],
          'server URL', deadline * 1000, () => { if (server!.exitCode !== null) throw new Error(`Server exited ${server!.exitCode}: ${stdout}`); });
        const json = async (path: string) => { const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(120000) });
          if (!response.ok) throw new Error(`${path}: ${response.status}: ${await response.text()}`); return response.json() as Promise<any>; };
        await json('/api/workspace/live');
        const view = await json('/api/task/view?task=T2');
        if (!view.userReviews?.length) throw new Error('Synthetic review has no review message; do not measure a blank reader');
        browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), env: environment });
        const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
        const page = await context.newPage(); diagnosticPage = page;
        let currentReviewMessage = 'Synthetic review message';
        page.on('pageerror', error => log.write(`BROWSER ${error.stack}\n`));
        const requests: Array<{ path: string; at: number; ms: number; bytes: number; status: number }> = [];
        const requestStarts = new Map<object, number>();
        page.on('request', request => { requestStarts.set(request, performance.now()); });
        const pendingResponses = new Set<Promise<void>>();
        page.on('response', response => {
          if (!response.url().includes('/api/task/history')) return;
          const read = (async () => { try { const body = await response.body(); requests.push({ path: new URL(response.url()).pathname + new URL(response.url()).search,
            at: requestStarts.get(response.request()) ?? performance.now(), ms: performance.now() - (requestStarts.get(response.request()) ?? performance.now()), bytes: body.length, status: response.status() }); } catch {} })();
          pendingResponses.add(read); void read.finally(() => pendingResponses.delete(read));
        });
        // A browser-side event-loop probe measures browser stalls independently of the server probe below.
        await page.addInitScript(() => { const samples: number[] = []; let previous = performance.now();
          setInterval(() => { const now = performance.now(); samples.push(Math.max(0, now - previous - 10)); previous = now; }, 10);
          Object.assign(window, { projectionPerfStalls: samples }); });
        const cold = performance.now(); await page.goto(new URL('/?task=T2&agent=1', base).href);
        await reviewPaint(page); const coldOpenMs = performance.now() - cold;
        await page.keyboard.press('Escape');
        const cliMs: number[] = [], writeToRowMs: number[] = [], openedMs: number[] = [], viewMs: number[] = [], writtenRequired: number[] = [];
        const sse: Array<{ at: number; event: string; data: any }> = [], sseAbort = new AbortController();
        const stream = readEvents(new URL('/api/events', base), sseAbort.signal, event => sse.push({ at: performance.now(), ...event }));
        await until(() => sse.find(event => event.event === 'index'), 'SSE initial index', 120000);
        let counter = 0;
        const submitReview = async () => {
          // Confirm the old snapshot, then cache the done view before a new review exists.
          let task = (await json('/api/task/view?task=T2')).task;
          await cli(repo, ['task', 'report', '--task', 'T2', '--state', 'done', '--expected-task-hash', task.hash], { ...environment, ALPACAWORK_SERVER: base });
          const response = page.waitForResponse(response => response.url().includes('/api/task/view?') && new URL(response.url()).searchParams.get('task') === 'T2');
          await page.goto(new URL('/?task=T2&agent=1', base).href); await (await response).finished();
          await page.locator('[data-report-feed][data-history-ready="true"]').first().waitFor({ timeout: 120000 });
          await page.keyboard.press('Escape');
          task = (await json('/api/task/view?task=T2')).task;
          const message = `Synthetic review message ${++counter}`, body = join(sandbox, 'review.txt'); writeFileSync(body, message + '. Fictional result for review.');
          const started = performance.now();
          await cli(repo, ['task', 'report', '--task', 'T2', '--state', 'waiting', '--title', message, '--description-file', body,
            '--expected-task-hash', task.hash], { ...environment, ALPACAWORK_SERVER: base });
          const ended = performance.now();
          const update = await until(() => sse.find(event => event.at >= started && event.data.tasks?.upsert?.some((row: any) => row.id === 'T2' && row.state === 'waiting')), 'new review SSE row', 120000);
          currentReviewMessage = message;
          return { cli: ended - started, row: update.at - started, update, started };
        };
        try {
          // Warm runs reproduce the user's retained reader: open once, close, write, reopen while the view is old.
          for (let i = 0; i < samples; i++) {
            const write = await submitReview(); cliMs.push(write.cli); writeToRowMs.push(write.row);
            if (write.update.data.requiredPv) writtenRequired.push(Object.values(write.update.data.requiredPv).reduce((total: number, patch: any) => total + Object.keys(patch.upsert ?? {}).length, 0) as number);
            const started = performance.now(); await page.locator('[data-read="T2"]').first().click();
            await reviewPaint(page, currentReviewMessage); openedMs.push(performance.now() - started);
            await page.keyboard.press('Escape');
            const read = performance.now(); await json('/api/task/view?task=T2'); viewMs.push(performance.now() - read);
          }
          await page.locator('[data-read="T2"]').first().click(); await reviewPaint(page, currentReviewMessage);
          const historyStart = requests.length, liveHistory: Array<{ writeToPaintMs: number; responses: typeof requests }> = [];
          for (let i = 0; i < burst; i++) {
            const task = (await json('/api/task/view?task=T2')).task;
            const writeStart = performance.now(), requestMark = requests.length;
            await cli(repo, ['task', 'comment', '--task', 'T2', '--title', `Synthetic live history ${i}`, '--expected-task-hash', task.hash], { ...environment, ALPACAWORK_SERVER: base });
            await until(async () => (await page.locator('[data-report-feed]').innerText()).includes(`Synthetic live history ${i}`), 'live History event painted', 120000);
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            liveHistory.push({ writeToPaintMs: performance.now() - writeStart, responses: requests.slice(requestMark) });
          }
          await until(async () => (await page.locator('[data-report-feed]').innerText()).includes(`Synthetic live history ${burst - 1}`), 'latest History event painted', 120000);
          const liveResponses = requests.slice(historyStart);
          await page.keyboard.press('Escape');
          console.log(JSON.stringify({ scale, phase: 'closed-history', writes: closedBurst }));
          for (let i = 0; i < closedBurst; i++) {
            const task = (await json('/api/task/view?task=T2')).task;
            await cli(repo, ['task', 'comment', '--task', 'T2', '--title', `Synthetic closed history ${i}`, '--expected-task-hash', task.hash], { ...environment, ALPACAWORK_SERVER: base });
          }
          const reopenResponseStart = requests.length;
          const reopened = performance.now(); await page.locator('[data-read="T2"]').first().click();
          await reviewPaint(page, currentReviewMessage);
          await until(async () => (await page.locator('[data-report-feed]').innerText()).includes(`Synthetic closed history ${closedBurst - 1}`), 'reopened History painted', 120000);
          const historyReopenMs = performance.now() - reopened;
          await page.screenshot({ path: join(output, `reader-${scale}.png`) });
          const browserStalls = await page.evaluate(() => (window as unknown as { projectionPerfStalls: number[] }).projectionPerfStalls);
          await Promise.allSettled([...pendingResponses]);
          const tree = timing.filter(entry => entry.step === 'tree');
          const numeric = (names: string[], step?: string) => timing.filter(entry => !step || entry.step === step).flatMap(entry => {
            const value = names.map(name => entry[name]).find(value => typeof value === 'number'); return typeof value === 'number' ? [value] : []; });
          const requiredPvChanges = sse.filter(entry => entry.event === 'delta').map(entry => entry.data.requiredPv).filter(Boolean).map(value =>
            Object.values(value).reduce((total: number, patch: any) => total + Object.keys(patch.upsert ?? {}).length, 0));
          const result = { ...metadata, coldOpenMs, cliMs: summarize(cliMs), writeToRowMs: summarize(writeToRowMs), openedMs: summarize(openedMs), warmViewMs: summarize(viewMs),
            legacyTreeReadMs: summarize(numeric(['readMs'], 'tree')), legacyTreeIndexMs: summarize(numeric(['indexMs'], 'tree')),
            legacyTreeTotalMs: summarize(tree.map(entry => Number(entry.readMs ?? 0) + Number(entry.indexMs ?? 0) + Number(entry.publishMs ?? 0))),
            catchUpMs: summarize(numeric(['catchUpMs', 'totalMs', 'ms'], 'catchUp')),
            routingPassMs: summarize(numeric(['routeMs', 'routingMs', 'ms'], 'pass')),
            writeQueueMs: summarize(numeric(['queueMs', 'waitMs'], 'write')), writeBodyMs: summarize(numeric(['bodyMs', 'writeMs'], 'write')),
            serverLongestStallMs: summarize(numeric(['longestStallMs', 'maxStallMs', 'stallMs'])), browserStallMs: summarize(browserStalls),
            requiredPvChangedResources: summarize(writtenRequired), requiredPvChangesAllDeltas: summarize(requiredPvChanges as number[]),
            history: { reopenMs: historyReopenMs, liveSamples: liveHistory, responsesWhileOpen: liveResponses, responsesAfterReopen: requests.slice(reopenResponseStart), liveWrites: burst, writesWhileClosed: closedBurst },
            unavailable: { catchUp: !timing.some(entry => entry.step === 'catchUp'), writeBreakdown: !timing.some(entry => entry.step === 'write'),
              serverStall: !numeric(['longestStallMs', 'maxStallMs', 'stallMs']).length, requiredPv: !requiredPvChanges.length },
            workload: { synthetic: true, realProviders: false, concurrentWriterProcesses: 1, filesScene: false } };
          writeFileSync(join(output, `result-${scale}.json`), JSON.stringify(result, null, 2));
          results.push(result); console.log(JSON.stringify({ scale, sha: metadata.sha, cli: result.cliMs, row: result.writeToRowMs, open: result.openedMs,
            tree: result.legacyTreeTotalMs, historyReopenMs, unavailable: result.unavailable }));
        } finally { sseAbort.abort(); await stream; }
      } catch (error) {
        if (diagnosticPage && !diagnosticPage.isClosed()) {
          await diagnosticPage.screenshot({ path: join(output, `failure-${scale}.png`) }).catch(() => {});
          writeFileSync(join(output, `failure-${scale}.html`), await diagnosticPage.content().catch(() => ''));
        }
        writeFileSync(join(output, `failure-${scale}.txt`), String(error));
        throw error;
      } finally {
        await browser?.close();
        if (server) await stopServer(server);
        await new Promise<void>(resolve => log.end(resolve));
        // Only owned synthetic roots, after the timeout group has exited and released the writer lease.
        removeWorkspace(root); removeWorkspace(original.root);
      }
    }
    writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2));
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
}
function prepareReview(root: string) {
  const release = holdControlWriter(root), store = new ControlStore(root);
  try { store.write(db => {
    db.prepare(`WITH RECURSIVE below(id) AS (SELECT id FROM tasks WHERE external_id='T2'
      UNION ALL SELECT t.id FROM tasks t JOIN below b ON t.parent_id=b.id)
      UPDATE tasks SET base_state='done',hold=0 WHERE id IN (SELECT id FROM below) AND external_id<>'T2' AND kind='task'`).run();
    // Give the synthetic sender a closed result for every ended child Request. No unfinished business masks a review.
    db.prepare(`INSERT INTO returns(id,request_id,to_task_id,outcome,boundary_run_id,created_at)
      SELECT 'perf-close-'||q.id,q.id,'T2','succeeded','R'||r.id,'2026-11-15T00:00:00Z'
      FROM requests q JOIN runs r ON r.request_id=q.id
      WHERE json_extract(q.author,'$.placementId')='fixture-placement-2' AND NOT EXISTS(SELECT 1 FROM returns x WHERE x.request_id=q.id)`).run();
    db.prepare(`INSERT OR IGNORE INTO return_resolutions(return_id,reason,at)
      SELECT id,'migrated_handled','2026-11-15T00:00:00Z' FROM returns WHERE to_task_id='T2'`).run();
    db.prepare("UPDATE tasks SET base_state='waiting',hold=0,user_requested=1,revision=revision+1 WHERE external_id='T2'").run();
    db.prepare(`INSERT INTO task_log(id,task_id,ordinal,entry) SELECT 'perf-review',id,
      (SELECT coalesce(max(ordinal),-1)+1 FROM task_log WHERE task_id=tasks.id),? FROM tasks WHERE external_id='T2'`).run(JSON.stringify({
      id: 'perf-review', kind: 'reported', at: '2026-11-16T00:00:00Z', title: 'Synthetic review message', description: 'Synthetic review message for performance measurement.',
      actor: { kind: 'placement', placementId: 'fixture-placement-2' }, fromState: 'doing', toState: 'waiting' }));
  }); } finally { store.close(); release(); }
}
async function reviewPaint(page: Page, message = 'Synthetic review message') {
  await page.locator('[data-reader-mode]').getByText(message === 'Synthetic review message' ? message : `${message}. Fictional result for review.`, { exact: message !== 'Synthetic review message' }).first().waitFor({ state: 'visible', timeout: options.smoke ? 15000 : 120000 });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function until<T>(read: () => T | Promise<T>, label: string, ms: number, guard?: () => void): Promise<NonNullable<T>> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) { guard?.(); const value = await read(); if (value) return value as NonNullable<T>; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
async function cli(repo: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, [join(repo, 'apps/cli/dist/cli.js'), ...args], { env, cwd: env.HOME, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  let output = ''; child.stdout.on('data', bytes => { output += String(bytes); }); child.stderr.on('data', bytes => { output += String(bytes); });
  const [code] = await once(child, 'exit'); if (code !== 0) throw new Error(`CLI ${args.slice(0, 2).join(' ')} exited ${code}: ${output}`);
}
async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  process.kill(-server.pid!, 'SIGTERM');
  const completed = once(server, 'exit');
  const timer = setTimeout(() => { try { process.kill(-server.pid!, 'SIGKILL'); } catch {} }, 10000);
  try { await completed; } finally { clearTimeout(timer); }
}
async function readEvents(url: URL, signal: AbortSignal, receive: (value: { event: string; data: any }) => void) {
  try {
    const response = await fetch(url, { signal }); if (!response.ok) throw new Error(`SSE ${response.status}`);
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); const data = /^data: (.+)$/m.exec(block)?.[1];
        if (data) receive({ event: /^event: (.+)$/m.exec(block)?.[1] ?? 'message', data: JSON.parse(data) }); }
    } } finally { await reader.cancel().catch(() => {}); }
  } catch (error) { if (!signal.aborted) throw error; }
}
