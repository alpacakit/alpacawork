import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isLiveProcess, processRows } from '@alpacawork/core';
import {
  recoverAutomationBundle, runAutomationBundle, type BundleCallbacks, type BundleIdentity, type BundleLaunch,
} from '@alpacawork/backend/test-dist/automations/bundle-process.js';

const moduleUrl = new URL('../apps/backend/test-dist/automations/bundle-process.js', import.meta.url).href;
const runner = fileURLToPath(new URL('../apps/backend/test-dist/automations/bundle-entry.js', import.meta.url));
const live = (group: number) => processRows().filter(row => row.pgid === group && isLiveProcess(row));
const source = `
  import { spawn } from 'node:child_process';
  import { once } from 'node:events';
  import { writeFile } from 'node:fs/promises';
  export const config = { on: { event: 'schedule' }, limits: { perDay: 1 } };
  /** Wait with a child process. */
  export async function run() {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await once(child, 'message');
    await writeFile('child', String(child.pid));
    for (;;) {}
  }
`;

async function until<T>(check: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = performance.now() + 12_000;
  while (performance.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await delay(40);
  }
  throw new Error('The automation process did not reach the expected state');
}

test('automation groups with a busy program and a child stop on request, deadline, or loss of serve', { timeout: 22_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'alpacawork-bundle-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const callbacks: BundleCallbacks = {
    recordIdentity: () => {}, beforeImport: () => true, beforeRun: () => ({ allowed: true }),
    operate: () => { throw new Error('Unexpected SDK operation'); },
  };
  const at = new Date().toISOString();

  async function check(folder: string) {
    const cwd = await mkdtemp(join(root, folder));
    const entry = join(cwd, 'main.ts');
    await writeFile(entry, source);
    await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
    const launch: BundleLaunch = {
      cwd, entry, preview: false, timeoutMinutes: folder === 'deadline' ? 0.05 : 1,
      event: { kind: 'schedule', ref: at, at, scheduledAt: at, manual: true },
    };
    const identityPath = join(cwd, 'identity.json');
    const localCallbacks = { ...callbacks, recordIdentity: async (identity: BundleIdentity) => {
      await writeFile(identityPath + '.tmp', JSON.stringify(identity));
      await rename(identityPath + '.tmp', identityPath);
    } };
    const stop = new AbortController();
    const serve = folder === 'serve' ? spawn(process.execPath, ['--input-type=module', '-e', `
      import { runAutomationBundle } from ${JSON.stringify(moduleUrl)};
      import { rename, writeFile } from 'node:fs/promises';
      await runAutomationBundle(${JSON.stringify(launch)}, {
        beforeImport: () => true, beforeRun: () => ({ allowed: true }), operate: () => {},
        recordIdentity: async identity => {
          const path = ${JSON.stringify(identityPath)};
          await writeFile(path + '.tmp', JSON.stringify(identity));
          await rename(path + '.tmp', path);
        },
      }, undefined, ${JSON.stringify(runner)});
    `], { stdio: 'ignore' }) : undefined;
    const completion = serve === undefined ? runAutomationBundle(launch, localCallbacks, stop.signal, runner) : undefined;

    let identity: BundleIdentity | undefined;
    try {
      identity = await until(() => readFile(identityPath, 'utf8').then(JSON.parse, () => undefined));
      const child = await until(() => readFile(join(cwd, 'child'), 'utf8').then(text => Number(text) || undefined, () => undefined));
      assert.ok(live(identity.group).some(row => row.pid === child));
      if (serve) {
        const exited = once(serve, 'exit');
        assert.ok(serve.kill('SIGKILL'));
        assert.equal((await exited)[1], 'SIGKILL');
        await until(() => live(identity!.group).length === 0 ? true : undefined);
        assert.equal(await recoverAutomationBundle(identity), true);
      } else {
        if (folder === 'request') stop.abort();
        const result = await completion!;
        assert.equal(result.stopped, true);
        assert.equal(result.phase, 'run');
        assert.equal(result.timedOut, folder === 'deadline');
        assert.deepEqual(live(identity.group), []);
      }
    } finally {
      stop.abort();
      if (serve && serve.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL');
      await completion;
      if (identity && live(identity.group).length) await recoverAutomationBundle(identity);
    }
  }

  const checked = await Promise.allSettled(['request', 'deadline', 'serve'].map(check));
  for (const result of checked) {
    if (result.status === 'rejected') throw result.reason;
  }
});
