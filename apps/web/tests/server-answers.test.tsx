// @vitest-environment node
/** A real HTTP write whose browser reply is lost must remain an unconfirmed result. */
import { afterAll, beforeAll, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanCliEnv } from "../../../tests/helpers/http-cli.ts";
import { projectedIndexSchema, taskWriteResultSchema } from "@alpacawork/contract/control";
import { randomUUID } from "node:crypto";
import { commandFetch } from "../../../tests/helpers/command-fetch.ts";
import { useConnection, rowWriteBasis } from "../src/data/connection";
import { queryClient } from "../src/data/query-client";
import { receiveFullIndex } from "../src/data/resources";
import { createApi, retryOf } from "../src/data/client";

// The shared setup loads the screen's stores, and the view store reads the page URL and media queries as it loads;
// a node test has no page, so it gets a blank one.
const page = globalThis as { location?: { href: string }; matchMedia?: (query: string) => unknown };
page.location ??= { href: "http://localhost/" };
page.matchMedia ??= (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });

const tabStorage=new Map<string,string>();
Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(k:string)=>tabStorage.get(k)??null,setItem:(k:string,v:string)=>tabStorage.set(k,v),removeItem:(k:string)=>tabStorage.delete(k),clear:()=>tabStorage.clear()}});

const project = resolve(import.meta.dirname, "../../..");
/** The project Task `workspace init` makes, the top of the workspace; the screen makes its Tasks under it. */
const ROOT_PROJECT = "P1";
let root = "";
/** The test's own temporary folder, removed after it; empty until made, so a test that failed before making it removes nothing. */
let scratch = "";
let child: ChildProcess | null = null;

/** The same real CLI initializes and serves in one child: one module graph and one owned lifetime. */
async function serve(): Promise<string> {
  const entry = pathToFileURL(resolve(project, "apps/backend/dist/backend.js")).href;
  const script = `
    const started = performance.now();
    const expiry = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 5 * 60_000);
    try {
      const { main } = await import(${JSON.stringify(entry)});
      const loaded = performance.now();
      await main(['--workspace', process.argv[2], 'workspace', 'init']);
      const code = process.exitCode ?? 0;
      process.send({ phase: 'initialized', code, loadMs: loaded - started, initMs: performance.now() - loaded });
      if (code !== 0) process.exit(code);
      await main(['--workspace', process.argv[2], 'workspace', 'serve', '--port', '0']);
    } finally { clearTimeout(expiry); if (process.connected) process.disconnect(); }
  `;
  // Register ownership before awaiting init or listening; a timed-out hook still reaps this child.
  const scriptFile = join(scratch, 'init-serve.mjs');
  writeFileSync(scriptFile, script);
  const started = performance.now();
  const running = child = spawn(process.execPath, [scriptFile, root], {
    cwd: project, env: cleanCliEnv({ HOME: scratch, XDG_CONFIG_HOME: join(scratch, '.config') }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  console.error(`[server-answers] init/serve PID ${running.pid} workspace ${scratch}; TTL 5 min`);
  let stderr = '', initialized = false, origin = '';
  const lines = createInterface({ input: running.stdout! });
  running.stderr!.on('data', bytes => { stderr += String(bytes); });
  try {
    return await new Promise<string>((done, fail) => {
      const ready = () => { if (initialized && origin) done(origin); };
      running.once('error', fail);
      running.once('close', (code, signal) => fail(new Error(`CLI init/serve exited before ready: ${code}/${signal}; ${stderr}`)));
      running.on('message', (message: { phase?: string; code?: number; loadMs?: number; initMs?: number }) => {
        if (message.phase !== 'initialized') return;
        console.error(`[server-answers] initialized ${JSON.stringify({ ...message, elapsedMs: performance.now() - started })}`);
        if (message.code !== 0) { fail(new Error(`CLI workspace init failed: ${message.code}; ${stderr}`)); return; }
        initialized = true; ready();
      });
      lines.on('line', line => {
        let info: { root?: string; url?: string };
        try { info = JSON.parse(line); } catch { return; }
        if (info.root !== root || typeof info.url !== 'string') return;
        origin = new URL(info.url).origin;
        console.error(`[server-answers] listening ${origin} elapsedMs=${performance.now() - started}`); ready();
      });
    });
  } finally { lines.close(); }
}

async function task(base: string) {
  const response = await commandFetch(`${base}/api/commands/task/new`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent: ROOT_PROJECT, title: "Investigate" }) });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return (JSON.parse(text) as { task: { id: string; hash: string } }).task;
}

let base = "";
beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "alpacawork-web-answers-")));
  root = join(scratch, "tasks");
  base = await serve();
});
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
  }
  child = null;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
  root = "";
});

test.each(["lost", "invalid"])("a committed HTTP write with a %s reply reads as check", async mode => {
  const current = await task(base);
  const input = { task: current.id, values: { notes: "New body" }, expectedTaskHash: current.hash };
  const opId = randomUUID();
  const real = globalThis.fetch;
  const snapshot = await real(`${base}/api/workspace/live`);
  expect(snapshot.status).toBe(200);
  receiveFullIndex(queryClient, projectedIndexSchema.parse(await snapshot.json()));
  useConnection.setState({ state: "live", offline: false });
  let intercepted = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await real(typeof url === "string" && url.startsWith("/api/") ? base + url : url, init);
    if (!intercepted && String(url).endsWith("/api/commands/task/update")) {
      expect(new Headers(init?.headers).get("X-Alpacawork-Op-Id")).toBe(opId);
      expect(JSON.parse(String(init?.body))).toEqual(input);
      expect(response.status, await response.clone().text()).toBe(200);
      intercepted = true;
      if (mode === "lost") throw new Error("reply lost after commit");
      return new Response("{", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return response;
  }) as typeof fetch;
  try {
    let failure: unknown;
    try { await createApi().request("commands/task/update", taskWriteResultSchema, undefined, input, opId, rowWriteBasis(input.task, input.expectedTaskHash)); }
    catch (error) { failure = error; }
    expect(intercepted).toBe(true);
    expect(retryOf(failure)).toBe("check");
    const saved = await real(`${base}/api/task/view?task=${encodeURIComponent(current.id)}`);
    expect(saved.status).toBe(200);
    const committed = (await saved.json()).task;
    expect(committed).toMatchObject({ id: current.id, values: input.values });
    expect(committed.hash).not.toBe(current.hash);
    // Receipt replay confirms the committed operation even though its original CAS is now stale.
    const checked = await createApi().request("commands/task/update", taskWriteResultSchema, undefined, input, opId, rowWriteBasis(input.task, input.expectedTaskHash));
    expect(checked.task).toMatchObject({ id: current.id, values: input.values, hash: committed.hash });
  } finally { globalThis.fetch = real; }
});
