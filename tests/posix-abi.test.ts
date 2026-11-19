import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('Linux restricted process is refused at the serve boundary', t => {
  if (process.platform !== 'linux') return t.skip('Linux process status only');
  const server = new URL('../apps/backend/test-dist/receiver/server.js', import.meta.url).href;
  const probe = `import { startServer } from ${JSON.stringify(server)};
` +
    `try { await startServer('/missing', 0); process.exit(2); } catch (error) {
` +
    `  if (error.code !== 'sandboxed_caller') { console.error(error); process.exit(3); }
` +
    `}`;
  const run = spawnSync('setpriv', ['--no-new-privs', process.execPath, '--input-type=module', '-e', probe],
    { encoding: 'utf8' });
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return t.skip('setpriv not installed');
  assert.equal(run.status, 0, run.stderr);
});
