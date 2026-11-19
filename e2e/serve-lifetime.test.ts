/** A served fixture lasts as long as the runner that started it: a long run keeps it, a lost runner does not leave it behind. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanEnv, until } from "../tests/acceptance/processes.ts";
import { isLive, killGroup, processRows } from "../tests/helpers/process-groups.ts";
import { generate } from "./fixture/generate.ts";
import { SERVE_BACKSTOP_MS } from "./server.ts";

const started: ChildProcess[] = [], roots: string[] = [], groups = new Set<number>();
const running = (pid: number) => processRows().find(row => row.pid === pid && isLive(row));
const answers = (origin: string) => fetch(`${origin}/api/workspace/live`, { signal: AbortSignal.timeout(5000) }).then(response => response.ok, () => false);
after(() => {
  for (const pid of groups) if (running(pid)) killGroup(pid);
  for (const child of started) child.kill("SIGKILL");
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A runner as Playwright's own process is one: it starts a serve through server.ts and then only stays alive. */
async function runner() {
  const server = new URL("./server.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `const {start}=await import(${JSON.stringify(server)});const {origin,root}=await start();console.log(JSON.stringify({origin,root}));setInterval(()=>{},1000);`],
    { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
  started.push(child);
  let out = "", err = "";
  child.stdout.on("data", chunk => { out += chunk; });
  child.stderr.on("data", chunk => { err += chunk; });
  const ready = await until(() => {
    if (child.exitCode !== null) throw new Error(`The runner ended early: ${err}`);
    const pids = /serve PID (\d+) keeper PID (\d+)/.exec(err);
    return out.includes("\n") && pids ? { ...JSON.parse(out) as { origin: string; root: string }, serve: Number(pids[1]), keeper: Number(pids[2]) } : null;
  }, "the runner's serve is ready", 90_000);
  roots.push(ready.root); groups.add(ready.serve); groups.add(ready.keeper);
  return { ...ready, child };
}

test("the backstop stays well past a whole run under load", () => {
  // One case at a time on a quiet machine a run took 142 minutes; the busiest machine measured took 3.3 times as long.
  assert.ok(SERVE_BACKSTOP_MS >= 8 * 60 * 60_000, `${SERVE_BACKSTOP_MS} ms is within what a whole run can take`);
});

test("a runner that is lost takes its serve with it, even when its keeper went first", async () => {
  const { origin, serve, keeper, child } = await runner();
  assert.ok(running(serve)?.command.includes(String(SERVE_BACKSTOP_MS)), "The serve is given this backstop");
  killGroup(keeper);
  await until(() => !running(keeper), "the keeper is gone");
  assert.equal(await answers(origin), true, "The runner is still there, so its serve stays without a keeper");
  child.kill("SIGKILL");
  await until(() => !running(serve), "the serve stops once its runner is gone", 15_000);
});

test("a runner that never finishes loses its serve at the backstop, which says so", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "alpacawork-e2e-")); roots.push(root);
  generate(root);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./serve-main.ts", import.meta.url)), root, "0", "3000"],
    { stdio: ["pipe", "pipe", "pipe"], env: cleanEnv() });
  started.push(child);
  let out = "", err = "";
  child.stdout!.on("data", chunk => { out += chunk; });
  child.stderr!.on("data", chunk => { err += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, err);
  assert.match(out, /"url"/, "It served until then");
  assert.match(err, /serve stopped at its backstop of 3000 ms/);
});
