/** Inject OS boundary faults in an owned process; the production Linux reader still does the translation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const entry = new URL('../packages/core/dist/platform/linux-host.js', import.meta.url).href;
for (const code of ['EACCES', 'EPERM', 'ENOENT', 'ESRCH', 'malformed']) test(`Linux process ${code} preserves the correct failure meaning`, { skip: process.platform !== 'linux' }, () => {
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const originalRead = fs.readFileSync, originalList = fs.readdirSync;
    fs.readdirSync = (path, ...args) => path === '/proc' ? ['123'] : originalList(path, ...args);
    fs.readFileSync = (path, ...args) => {
      if (path !== '/proc/123/stat') return originalRead(path, ...args);
      if (${JSON.stringify(code)} === 'malformed') return 'invalid stat';
      throw Object.assign(new Error('injected process fault'), { code: ${JSON.stringify(code)} });
    };
    syncBuiltinESMExports();
    const { linuxHostMeasurement } = await import(${JSON.stringify(entry)});
    const reader = linuxHostMeasurement('/tmp');
    try { const value = reader.read(); console.log(JSON.stringify({ memory: value.memory.totalBytes,
      count: value.processes.size, row: value.processes.get(123) })); }
    catch (error) { console.log(JSON.stringify({ error: error.message })); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  if (code === 'malformed') assert.match(result.error, /Invalid.*stat/);
  else {
    assert.ok(result.memory > 0);
    if (code === 'EACCES' || code === 'EPERM') assert.deepEqual(result.row,
      { pid: 123, ppid: 0, comm: '123', ticks: null, startTime: null, rssBytes: null });
    else assert.equal(result.count, 0, 'only vanished processes disappear');
  }
});

test('Linux startup commands are bounded and surface failure instead of inventing clock/page units', { skip: process.platform !== 'linux' }, () => {
  const script = `
    import child from 'node:child_process'; import assert from 'node:assert/strict';
    import { syncBuiltinESMExports } from 'node:module';
    child.execFileSync = (file, args, options) => {
      assert.equal(file, '/usr/bin/getconf'); assert.equal(args.length, 1);
      assert.equal(options.timeout, 1000); assert.equal(options.killSignal, 'SIGKILL');
      assert.equal(options.maxBuffer, 1024); assert.equal(options.env.LC_ALL, 'C');
      assert.notEqual(options.shell, true);
      throw Object.assign(new Error('getconf timed out'), { code: 'ETIMEDOUT' });
    };
    syncBuiltinESMExports();
    const { linuxHostMeasurement } = await import(${JSON.stringify(entry)});
    assert.throws(() => linuxHostMeasurement('/tmp'), error => error.code === 'ETIMEDOUT');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  assert.equal(child.status, 0, child.stderr);
});
