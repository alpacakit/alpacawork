import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const alreadyReleased of [false, true]) test(`fake provider release gate works when inotify is unavailable (${alreadyReleased ? 'already released' : 'released after waiting'})`, t => {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Local fault injection only: do not exhaust other test runs' shared inotify quota.
  const source = `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    fs.watch = () => { throw Object.assign(new Error('inotify instance quota exhausted'), { code: 'EMFILE' }); };
    syncBuiltinESMExports();
    const { waitForGate } = await import(${JSON.stringify(new URL('./fixtures/fake-gate.mjs', import.meta.url).href)});
    const gate = ${JSON.stringify(join(root, 'release'))};
    if (${alreadyReleased}) fs.writeFileSync(gate, '');
    const done = waitForGate(gate);
    if (!${alreadyReleased}) queueMicrotask(() => fs.writeFileSync(gate, ''));
    await done;
    console.log('observed release');`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 12_000 }).trim(), 'observed release');
});
