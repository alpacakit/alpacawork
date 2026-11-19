/** Optional test-process guard. Never imported by the shipped backend. */
import cp from "node:child_process";
import net from "node:net";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

type LoadedGuard = {
  pid: number; path: string; sha256: string; loadedAt: string;
  spawn: typeof cp.spawn; connect: typeof net.Socket.prototype.connect;
};
const key = Symbol.for("alpacawork.e2e.loadedGuard");
const state = globalThis as typeof globalThis & { [key]?: LoadedGuard };
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function selectedGuard() {
  const path = process.env.ALPACAWORK_E2E_BACKEND_GUARD;
  if (!path && process.env.ALPACAWORK_E2E_GUARD_REQUIRED === "1") throw new Error("E2E guard required before serve: no guard selected");
  return path ? realpathSync(path) : undefined;
}

function record(boundary: string, guard: LoadedGuard) {
  const row = { boundary, at: new Date().toISOString(), pid: process.pid, ppid: process.ppid,
    path: guard.path, sha256: guard.sha256, loadedAt: guard.loadedAt,
    argv: process.argv, execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS,
    worker: process.env.TEST_WORKER_INDEX };
  const line = JSON.stringify(row) + "\n";
  if (process.env.ALPACAWORK_E2E_GUARD_LOG) appendFileSync(process.env.ALPACAWORK_E2E_GUARD_LOG, line);
  else process.stderr.write(`[e2e-guard] ${line}`);
}

/** Consumers only verify; importing this module must never repair a missing preload. */
export function assertGuardLoaded(boundary: string) {
  const path = selectedGuard();
  if (!path) return;
  const guard = state[key];
  if (!guard || guard.pid !== process.pid || guard.path !== path || guard.sha256 !== digest(path) ||
      guard.spawn !== cp.spawn || guard.connect !== net.Socket.prototype.connect)
    throw new Error(`E2E guard not loaded before ${boundary}`);
  const expected = process.env.ALPACAWORK_E2E_GUARD_SHA256;
  if (expected && guard.sha256 !== expected) throw new Error("E2E guard digest mismatch");
  record(boundary, guard);
  return guard;
}

/** The one installation Owner, entered through guard-loader.mjs in every Node process. */
export async function loadGuard() {
  const path = selectedGuard();
  if (!path) return;
  if (state[key]) return assertGuardLoaded("preload-reused");
  const sha256 = digest(path), expected = process.env.ALPACAWORK_E2E_GUARD_SHA256;
  if (expected && sha256 !== expected) throw new Error("E2E guard digest mismatch");
  const spawn = cp.spawn, connect = net.Socket.prototype.connect;
  await import(pathToFileURL(path).href);
  // Verify completed installation without attempting any denied operation.
  if (cp.spawn === spawn || net.Socket.prototype.connect === connect) throw new Error("E2E guard did not install process/network hooks");
  const loader = `--import=${new URL("./guard-loader.mjs", import.meta.url).href}`;
  const options = process.env.NODE_OPTIONS ?? "";
  if (!options.split(/\s+/).includes(loader)) process.env.NODE_OPTIONS = `${options} ${loader}`.trim();
  state[key] = Object.freeze({ pid: process.pid, path, sha256, loadedAt: new Date().toISOString(),
    spawn: cp.spawn, connect: net.Socket.prototype.connect });
  return assertGuardLoaded("preload-complete");
}
