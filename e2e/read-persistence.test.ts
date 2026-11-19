/** Real IndexedDB contract enters the canonical e2e fixture stage (one queue admission). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
test('FORMAT14 IndexedDB: restore, scope cut, CAS, byte limits, refusal, deadlines and persistence faults', { timeout: 900_000 }, async () => {
  const child = spawn(process.execPath, ['apps/web/tests/read-persistence.browser.mjs'], { stdio: 'inherit' });
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null); assert.equal(code, 0);
});
