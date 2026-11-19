import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const [name, path] of [
  ['core', '../packages/core/dist/index.js'],
  ['CLI', '../apps/cli/dist/cli.js'],
  ['backend', '../apps/backend/dist/backend.js'],
] as const) {
  for (const [host, arch] of [['win32', 'x64'], ['linux', 'x64'], ['darwin', 'arm64']] as const) {
    test(`${name}: ${host} host selection precedes native loading and preserves native faults`, () => {
      const script = `
        import assert from 'node:assert/strict';
        import { registerHooks } from 'node:module';
        Object.defineProperty(process, 'platform', { value: ${JSON.stringify(host)} });
        Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} });
        let loads = 0;
        const fault = new Error('native dependency unavailable');
        registerHooks({ resolve(id, context, next) {
          if (id === 'koffi') { loads++; throw fault; }
          return next(id, context);
        } });
        await assert.rejects(import(${JSON.stringify(new URL(path, import.meta.url).href)}), error => {
          if (process.platform === 'win32') {
            assert.equal(loads, 0);
            assert.equal(error.code, 'unsupported_platform');
            assert.match(error.message, /win32 x64/);
          } else {
            assert.equal(loads, 1);
            assert.equal(error, fault);
          }
          return true;
        });
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr || child.stdout);
    });
  }
}
