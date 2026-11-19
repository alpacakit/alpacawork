import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { projectedIndexSchema, taskProjectedPageSchema } from "@alpacawork/contract/control";
import { ControlStore } from "@alpacawork/db";
import { RunStore } from "@alpacawork/runs";
import { NOTICE_VERSION, taskBaseline, type NoticeSaved } from "../apps/web/src/data/notice-model.ts";
import { generate } from "./fixture/generate.ts";
import { assertInertFixtureRuns } from "./fixture/inert-runs.ts";
import { createSampleTasks, SAMPLE_CHANGED_AT, SAMPLE_CHECKPOINT_AT } from "./fixture/sample.ts";
import { readTaskLog } from "./task-history.ts";
import { cleanEnv } from "../tests/acceptance/processes.ts";
import { assertGuardLoaded } from "./guard.ts";
import { fixturePath } from "../tests/helpers/agent-stub.ts";

import { seedSetupSkill } from '../tests/helpers/setup-skill-fixture.ts';

export type Runtime = { origin: string; root: string };
export const readRuntime = (): Runtime => JSON.parse(process.env.ALPACAWORK_E2E_RUNTIME!);

const keeperScript = fileURLToPath(new URL("./serve-keeper.ts", import.meta.url));
/**
 * For a runner that never finishes; one that ends takes its serve with it. The shared serve spans the whole run, which
 * measured 142 minutes one case at a time on a quiet machine and has no limit of its own, so this stays well past that under load.
 */
export const SERVE_BACKSTOP_MS = 12 * 60 * 60_000;

/**
 * A fixed port taken before serve starts fails the caller at once and names the holder, so one
 * leftover listener does not turn into a chain of cases that each wait for serve to fail.
 */
export function assertPortFree(port: string) {
  if (port === "0") return;
  const lsof = spawnSync("/usr/sbin/lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  // lsof exits 1 with no output when nothing listens.
  if (lsof.status === 1 && !lsof.stdout) return;
  if (lsof.status !== 0) throw new Error(`lsof could not check port ${port}: ${lsof.error ?? lsof.stderr}`);
  const holders = spawnSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,etime=,command=", "-p", lsof.stdout.trim().split("\n").join(",")],
    { encoding: "utf8" }).stdout;
  throw new Error(`Port ${port} is already in use (pid ppid pgid elapsed command):\n${holders}`);
}

/**
 * Each serve owns its port and generated root. A keeper process, started before anything that needs
 * cleaning, does all of the cleanup: on stop() and whenever this process ends without calling it.
 */
export async function start(port?: string, prepare?: (root: string) => void, retainedDirectory?: string): Promise<Runtime & { stop: () => Promise<void> }> {
  assertGuardLoaded("child-launch");
  const servePort = port ?? process.env.ALPACAWORK_E2E_PORT ?? "0";
  if (servePort !== "0") assertPortFree(servePort);
  if (retainedDirectory) mkdirSync(retainedDirectory, { recursive: true });
  const root = mkdtempSync(join(realpathSync(tmpdir()), "alpacawork-e2e-"));
  const keeper = spawn(process.execPath, [keeperScript], {
    stdio: ["pipe", "ignore", "inherit"], env: cleanEnv({ ALPACAWORK_E2E_KEEPER_ROOT: root,
      ...(retainedDirectory ? { ALPACAWORK_E2E_KEEPER_RETAIN: '1' } : {}) }), detached: true });
  const keeperExit = once(keeper, "exit");
  const stop = async () => {
    keeper.stdin!.end();
    const [code] = await keeperExit;
    if (retainedDirectory) writeFileSync(join(retainedDirectory, 'stopped.json'), JSON.stringify({ keeper: keeper.pid, code, at: new Date().toISOString() }));
    if (code !== 0) throw new Error(`Serve keeper exited with ${code}: ${root}`);
    if (retainedDirectory) {
      // Preserve stopped evidence on disk; live fixture writes use the stage TMPDIR.
      cpSync(root, join(retainedDirectory, basename(root)), { recursive: true, preserveTimestamps: true });
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    const samples = createSampleTasks();
    generate(root);
    const initialStore = new RunStore(root, { busyTimeoutMs: 0 });
    try { assert.equal(initialStore.read().length, 7, "Fixture contains all seven runs"); }
    finally { initialStore.close(); }
    prepare?.(root);
    // The states as written, a preparation's changes included, before serve's first pass reads the Runs.
    const control = new ControlStore(root, { busyTimeoutMs: 0 }, true);
    const written = (() => { try {
      return new Map(control.read(db => db.prepare("SELECT external_id,state FROM tasks").all())
        .map(row => [String(row.external_id), String(row.state)]));
    } finally { control.close(); } })();
    const store = new RunStore(root, { busyTimeoutMs: 0 });
    const generatedRuns = (() => { try { return store.read(); } finally { store.close(); } })();
    assertInertFixtureRuns(generatedRuns);
    // The served copy reads the user state (installed skills, setup records, settings) of its own empty home, as
    // test-all's isolated runs do, so a check run straight from playwright does not meet this PC's own installation.
    const home = join(root, ".home");
    mkdirSync(home);
    await seedSetupSkill(home, resolve('.'));
    const env = cleanEnv({ PATH: fixturePath(root), HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local/state"), XDG_DATA_HOME: join(home, ".local/share") });
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./serve-main.ts", import.meta.url)), root, servePort, String(SERVE_BACKSTOP_MS),
    ], { stdio: ["pipe", "pipe", "pipe"], env, detached: true });
    process.stderr.write(`[e2e] serve PID ${child.pid} keeper PID ${keeper.pid} workspace ${root}\n`);
    if (retainedDirectory) {
      writeFileSync(join(retainedDirectory, 'processes.json'), JSON.stringify({ worker: process.pid, serve: child.pid, keeper: keeper.pid,
        root, startedAt: new Date().toISOString(), serveBackstopMs: SERVE_BACKSTOP_MS }));
      child.stderr!.on('data', (chunk: Buffer) => appendFileSync(join(retainedDirectory, 'server.stderr.log'), chunk));
      child.stdout!.on('data', (chunk: Buffer) => appendFileSync(join(retainedDirectory, 'server.stdout.log'), chunk));
    }
    const readinessStarted = performance.now();
    let reportedOrigin = false, lastTiming: Record<string, unknown> | null = null;
    const readinessError = (message: string) => new Error(`${message}; ${JSON.stringify({
      pid: child.pid, elapsedMs: Math.round(performance.now() - readinessStarted),
      reportedOrigin, exitCode: child.exitCode, signalCode: child.signalCode, lastTiming,
    })}`);
    // The first reconciliation pass runs after serve starts listening. Its completion is the
    // readiness point for tests that read and write Tasks in this particular workspace.
    const firstPass = new Promise<void>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(readinessError("serve did not complete its first pass")), 30000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", (code, signal) => fail(new Error(`serve exited with ${signal ?? code} before first pass`)));
      child.stderr!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const entry = JSON.parse(line);
            if (entry.timing) lastTiming = entry;
            if (entry.step === "pass") { clearTimeout(timer); resolve(); }
            if (entry.timing) continue;
          } catch { /* Non-timing diagnostics still reach the test log. */ }
          process.stderr.write(`${line}\n`);
        }
      });
      child.stderr!.once("end", () => { if (buffer) process.stderr.write(buffer); });
    });
    const originReady = new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(readinessError("serve did not report a URL")), 30000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", (code, signal) => fail(new Error(`serve exited with ${signal ?? code}`)));
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        clearTimeout(timer);
        try { const origin = new URL(JSON.parse(buffer.slice(0, end)).url).origin; reportedOrigin = true; resolve(origin); }
        catch (error) { reject(error); }
      });
    });
    const [origin] = await Promise.all([originReady, firstPass]);
    const response = await fetch(`${origin}/api/workspace/live`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`tree returned ${response.status}`);
    const snapshot = projectedIndexSchema.parse(await response.json());
    const parents = new Set(["root", ...samples.map(task => task.parent).filter((id): id is string => !!id)]);
    const finished = await Promise.all([...parents].map(async parent => {
      const response = await fetch(`${origin}/api/task/finished?parent=${encodeURIComponent(parent)}&limit=20`, { signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200);
      const page = taskProjectedPageSchema.parse(await response.json());
      assert.equal(page.nextAfter, null, "The small fixture fits each bounded finished page");
      return page.rows;
    }));
    const fixtureRows = [...snapshot.tasks, ...finished.flat()];
    if (fixtureRows.length !== written.size || snapshot.errors.length || !snapshot.writable)
      throw new Error(`Invalid fixture: ${fixtureRows.length} tasks, ${JSON.stringify(snapshot.errors.slice(0, 3))}`);
    assert.deepEqual(new Set(fixtureRows.map(row => row.id)), new Set(written.keys()));
    // The first pass applied the sample Runs' starts and ends; none may have changed a state as written.
    assert.deepEqual(new Map(fixtureRows.map(row => [row.id, row.state])), written, "Serve keeps the fixture's states");
    assert.ok(snapshot.runs.every(run => generatedRuns.some(saved => saved.id === run.id)),
      "The live projection contains only saved fixture Run IDs");
    // Global setup observes the shared Runs after the first pass. Isolated-only runs have no
    // shared runtime, so they retain the observation for each server they start.
    if (!process.env.ALPACAWORK_E2E_RUNTIME) {
      await delay(2500);
      const settledResponse = await fetch(`${origin}/api/workspace/live`, { signal: AbortSignal.timeout(30000) });
      assert.equal(settledResponse.status, 200);
      const settled = projectedIndexSchema.parse(await settledResponse.json());
      assert.deepEqual(settled.runs, snapshot.runs, "Fixture runs must remain stable after the first pass");
    }
    // The reader's saved baseline is the fixture before its sample changes, so those changes are unread.
    const sampleById = new Map(samples.map((task) => [task.id, task]));
    const tasks: NoticeSaved["checkpoint"]["tasks"] = {};
    for (const task of fixtureRows) {
      const change = sampleById.get(task.id)?.change;
      if (change?.kind === "new") continue;
      const baseline = taskBaseline(task);
      if (change) {
        // The opened view contains only its current report; the stored log is read whole.
        baseline.log = (await readTaskLog(origin, task.id)).filter((log) => log.at !== SAMPLE_CHANGED_AT).length;
        if (change.kind === "state") baseline.state = change.from;
      }
      tasks[task.id] = baseline;
    }
    const notices = { version: NOTICE_VERSION, checkpoint: { at: SAMPLE_CHECKPOINT_AT, tasks }, reads: {} } satisfies NoticeSaved;
    const seeded = await fetch(`${origin}/api/person/notices/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: notices, expectedRevision: null }),
    });
    if (!seeded.ok) throw new Error(`Notice fixture returned ${seeded.status}: ${await seeded.text()}`);
    return { origin, root, stop };
  } catch (error) {
    try { await stop(); } catch (stopError) { throw new AggregateError([error, stopError], 'Serve preparation and stop both failed'); }
    throw error;
  }
}
