import { commandFetch as fetch } from './command-fetch.ts';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

const cli = fileURLToPath(new URL('../../apps/cli/dist/cli.js', import.meta.url));
const serve = fileURLToPath(new URL('./serve-http.ts', import.meta.url));

/**
 * Backstop for a stuck fixture command; capture tests must also allow their enclosing cleanup to finish. A test of the
 * backstop itself shortens it with ALPACAWORK_CLI_FIXTURE_WATCHDOG_MS instead of waiting the whole 30 seconds.
 */
export const CLI_FIXTURE_WATCHDOG_MS = Number(process.env.ALPACAWORK_CLI_FIXTURE_WATCHDOG_MS) || 30_000;

/**
 * A person's CLI, whatever runs the tests: no Run, no main conversation and no server but the one a test names.
 * Every test that starts the CLI or serve cleans its environment here.
 */
export function cleanCliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['ALPACAWORK_RUN_CLI', 'ALPACAWORK_RUNTIME_LEASE_FD', 'ALPACAWORK_RUN', 'ALPACAWORK_RUN_TOKEN', 'ALPACAWORK_SERVER',
    'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID']) delete env[key];
  return { ...env, ...extra };
}

export async function isolatedServe(root: string, t?: TestContext, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [serve, root], {
    env: cleanCliEnv(extra), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout! });
  const line = await Promise.race([
    once(lines, 'line').then(([value]) => String(value)),
    once(child, 'exit').then(() => { throw new Error(stderr || 'serve exited before ready'); }),
  ]);
  lines.close();
  const info = JSON.parse(line) as { url: string; connection: string; generation: string };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  };
  t?.after(stop);
  return { ...info, child, stop };
}

export function cliSync(url: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [cli, '--server', new URL(url).origin, ...args], {
    env: cleanCliEnv(env), encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(result.error);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export async function cliRun(url: string, args: string[], env: NodeJS.ProcessEnv = {}, input = '') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--server', new URL(url).origin, ...args], {
      env: cleanCliEnv(env), stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** Storage tests use the same isolated HTTP serve without a test-context hook. */
export async function startCliFixtureServer(root: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const { url, stop } = await isolatedServe(root);
  return { url, stop };
}

/** Finish status-only exchanges so teardown does not wait on an unread response. */
export async function httpStatus(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<number> {
  const response = await fetch(input, init);
  await response.arrayBuffer();
  return response.status;
}
