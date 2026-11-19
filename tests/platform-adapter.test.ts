import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const [name, path] of [
  ['core', '../packages/core/dist/index.js'],
  ['CLI', '../apps/cli/dist/cli.js'],
  ['backend', '../apps/backend/dist/backend.js'],
] as const) {
  test(`${name} rejects Windows before loading a POSIX library`, () => {
    const entry = new URL(path, import.meta.url).href;
    const script = `
      Object.defineProperty(process, 'platform', { value: 'win32' });
      Object.defineProperty(process, 'arch', { value: 'x64' });
      try { await import(${JSON.stringify(entry)}); process.exitCode = 1; }
      catch (error) {
        if (error.code !== 'unsupported_platform' || !error.message.includes('win32 x64')) process.exitCode = 2;
      }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });
}

test('Windows resource measurement can be imported independently of the unsupported POSIX host', () => {
  const entry = new URL('../packages/core/dist/platform/host-measurement.js', import.meta.url).href;
  const script = `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const resources = await import(${JSON.stringify(entry)});
    const windows = await import(${JSON.stringify(new URL('../packages/core/dist/platform/windows-host.js', import.meta.url).href)});
    if (resources.measureHost !== windows.windowsHostMeasurement) process.exitCode = 1;
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
