// One measurement of one root: clone it, profile the tree read, serve the clone, measure the server
// and the browser, stop serve by its PID and remove the clone. See README.md in this folder.
// Usage: node e2e/perf/run.mjs --data <measurement root> --label <name> --out-dir <dir>
//          [--port 5688] [--heavy T42] [--word sol] [--updates 5] [--interval 4000]
//          [--listen-timeout 120000] [--tree-timeout 300000] [--first-row-timeout 120000] [--max-seconds 3600] [--timing]
import { spawn, spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import YAML from "yaml";
import { DEFAULT_SERVER_PORT } from '../../packages/contract/dist/default-server.js';

const { values: args } = parseArgs({ options: {
  data: { type: "string" }, label: { type: "string" }, "out-dir": { type: "string" }, port: { type: "string", default: "5688" },
  heavy: { type: "string", default: "T42" }, word: { type: "string", default: "sol" },
  updates: { type: "string", default: "5" }, interval: { type: "string", default: "4000" },
  "listen-timeout": { type: "string", default: "120000" }, "tree-timeout": { type: "string", default: "300000" },
  "first-row-timeout": { type: "string", default: "120000" }, "max-seconds": { type: "string", default: "3600" },
  // Older serves have no --timing; leave it off to measure one of them.
  timing: { type: "boolean", default: false },
  "render-counts": { type: "boolean", default: false },
} });
for (const key of ["data", "label", "out-dir"]) if (!args[key]) throw new Error(`--${key} is required`);
const data = resolve(args.data), outDir = resolve(args["out-dir"]), port = Number(args.port);

// Never against a working root or the production port: the root must be a measurement copy.
if (port === DEFAULT_SERVER_PORT) throw new Error(`Port ${DEFAULT_SERVER_PORT} is production`);
if (existsSync(join(data, ".alpacawork", "connection.json"))) throw new Error(`${data} has a serve connection file; measure a copy (copy-root.mjs)`);
const agents = YAML.parse(readFileSync(join(data, "config.yaml"), "utf8"))?.agents;
if (!agents || !Object.keys(agents).length || Object.values(agents).some((agent) =>
  [agent.start, agent.resume].filter(Boolean).some((command) => !Array.isArray(command) ||
    command.length !== 1 || command[0] !== "/usr/bin/false")))
  throw new Error(`${data}/config.yaml can launch an agent; measure a copy (copy-root.mjs)`);
const lsof = spawnSync("/usr/sbin/lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
if (lsof.stdout.trim()) throw new Error(`Port ${port} is in use by PID ${lsof.stdout.trim()}`);

mkdirSync(outDir, { recursive: true });
const work = join(outDir, `work-${args.label}`);
if (existsSync(work)) throw new Error(`Leftover clone ${work}; remove it first`);
const env = { ...process.env, NODE_NO_WARNINGS: "1" };
for (const key of Object.keys(env)) if (/^(ALPACAWORK|CODEX|CLAUDE)/.test(key)) delete env[key];
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const result = { label: args.label, data, at: new Date().toISOString(),
  commit: spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim() };
const save = () => writeFileSync(join(outDir, `${args.label}.json`), JSON.stringify(result, null, 1));

let serve;
try {
  if (spawnSync("/bin/cp", ["-cR", data, work]).status !== 0) throw new Error("clone failed");
  // Tree read stages, before serve runs, so no tick competes for the CPU.
  const profile = spawnSync(process.execPath, [here("profile-tree.mjs"), work, "2"], { encoding: "utf8", env });
  result.profile = profile.status === 0 ? JSON.parse(profile.stdout) : { failed: profile.stderr.slice(-2000) };

  // perl's alarm stops serve by itself if this script dies; exec keeps the PID recorded here.
  const backend = fileURLToPath(new URL("../../apps/backend/dist/backend.js", import.meta.url));
  const log = openSync(join(outDir, `${args.label}.serve.log`), "w");
  serve = spawn("/usr/bin/perl", ["-e", "alarm shift; exec @ARGV", args["max-seconds"], process.execPath, backend,
    "--workspace", work, "workspace", "serve", "--port", String(port), ...(args.timing ? ["--timing"] : [])],
  { stdio: ["ignore", "pipe", log], env, detached: true });
  writeFileSync(join(outDir, `${args.label}.serve.pid`), String(serve.pid));
  const started = Date.now();
  const origin = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("serve did not report a URL")), Number(args["listen-timeout"]));
    serve.once("exit", (code) => { clearTimeout(timer); reject(new Error(`serve exited with ${code}`)); });
    serve.stdout.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve(new URL(JSON.parse(buffer.slice(0, end)).url).origin); } catch (error) { reject(error); }
    });
  });
  result.server = { listenMs: Date.now() - started };

  // /api/workspace/live: size and what it is made of (UTF-8 bytes of each key's JSON).
  {
    const t0 = Date.now();
    try {
      const response = await fetch(`${origin}/api/workspace/live`, { signal: AbortSignal.timeout(Number(args["tree-timeout"])) });
      const text = await response.text();
      const tree = JSON.parse(text);
      const size = (value) => Buffer.byteLength(JSON.stringify(value));
      const keys = Object.fromEntries(Object.entries(tree).map(([key, value]) => [key, size(value)]).sort((a, b) => b[1] - a[1]));
      const taskKeys = {};
      for (const task of tree.tasks) for (const [key, value] of Object.entries(task)) taskKeys[key] = (taskKeys[key] ?? 0) + size(value);
      // What crosses the wire when the browser accepts gzip (an older serve sends it as is).
      const wire = await new Promise((resolve, reject) => httpRequest(`${origin}/api/workspace/live`, { headers: { "Accept-Encoding": "gzip" } }, (response) => {
        let n = 0;
        response.on("data", (chunk) => { n += chunk.length; });
        response.on("end", () => resolve({ bytes: n, encoding: response.headers["content-encoding"] ?? null }));
      }).on("error", reject).end());
      result.server.tree = { ms: Date.now() - t0, bytes: Buffer.byteLength(text), wireBytes: wire.bytes, wireEncoding: wire.encoding,
        tasks: tree.tasks.length, runs: tree.runs.length, requests: tree.requests?.length ?? null,
        keys, taskKeys: Object.fromEntries(Object.entries(taskKeys).sort((a, b) => b[1] - a[1])) };
    } catch (error) { result.server.tree = { failed: String(error), ms: Date.now() - t0 }; }
  }
  save();

  const measure = spawnSync(process.execPath, [here("measure.mjs"), "--origin", origin, "--root", work,
    "--serve-pid", String(serve.pid), "--out", join(outDir, `${args.label}.browser.json`), "--heavy", args.heavy, "--word", args.word,
    "--updates", args.updates, "--interval", args.interval, "--first-row-timeout", args["first-row-timeout"],
    ...(args["render-counts"] ? ["--render-counts"] : [])],
  { encoding: "utf8", env, stdio: ["ignore", "inherit", "inherit"] });
  result.browser = existsSync(join(outDir, `${args.label}.browser.json`))
    ? JSON.parse(readFileSync(join(outDir, `${args.label}.browser.json`), "utf8")) : { failed: `measure exited ${measure.status}` };
} finally {
  if (serve?.pid) {
    // Stop the group serve leads, by the recorded PID; escalate if it does not end.
    const alive = () => { try { process.kill(serve.pid, 0); return serve.exitCode === null && serve.signalCode === null; } catch { return false; } };
    try { process.kill(-serve.pid, "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 200 && alive(); i++) await delay(100);
    if (alive()) { result.serveKilled = true; try { process.kill(-serve.pid, "SIGKILL"); } catch { /* already gone */ } }
  }
  rmSync(work, { recursive: true, force: true });
  save();
}
console.log(join(outDir, `${args.label}.json`));
