/**
 * Faults run the real CLI test boundary; its watchdog and afterEach own capture/cleanup. A capture without faults is
 * failure-workspace.test.ts's; here the watchdog's kill is captured even when one capture step fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanCliEnv } from './helpers/http-cli.ts';

/** The child's init finishes its work, then never exits; a short backstop still leaves init time to write its database. */
const WATCHDOG_MS = 10_000;

for (const mode of ['success', 'capture-fault']) test(`CLI afterEach preserves ${mode} before removing HOME`, t => {
  const parent = process.env.ALPACAWORK_FAILURE_EVIDENCE_DIR ?? tmpdir(); mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(join(parent, 'cli-capture-'));
  if (!process.env.ALPACAWORK_FAILURE_EVIDENCE_DIR) t.after(() => rmSync(folder, { recursive: true, force: true }));
  const evidence = join(folder, 'evidence'), scratch = mkdtempSync(join(tmpdir(), 'cli-capture-home-')), preload = join(folder, 'preload.mjs');
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
if (process.argv[1]?.endsWith('/backend.js') && process.argv.includes('init')) {
 console.log('deliberate watchdog stdout'); console.error('deliberate watchdog stderr'); setInterval(()=>{},1000);
}
${mode === 'capture-fault' ? `const copy=fs.copyFileSync;fs.copyFileSync=(from,to,...args)=>{if(String(to).endsWith('/runtime-raw/tasks/config.yaml'))throw Error('deliberate CLI config capture fault');return copy(from,to,...args)};syncBuiltinESMExports();` : ''}
`);
  const env = cleanCliEnv({ TMPDIR: scratch, ALPACAWORK_FAILURE_EVIDENCE_DIR: evidence });
  delete env.NODE_TEST_CONTEXT;
  if (mode !== 'success') { env.NODE_OPTIONS = `--import=${preload}`; env.ALPACAWORK_CLI_FIXTURE_WATCHDOG_MS = String(WATCHDOG_MS); }
  else delete env.NODE_OPTIONS;
  const child = spawnSync(process.execPath, ['--test', '--test-name-pattern=^CLI field get gives', 'tests/cli.test.ts'],
    // The real watchdog must fire before the outer process budget; evidence and afterEach then still have time.
    { env, encoding: 'utf8', timeout: WATCHDOG_MS + 30_000 });
  writeFileSync(join(folder, 'output.log'), child.stdout + child.stderr);
  assert.ifError(child.error);
  assert.equal(child.status, mode === 'success' ? 0 : 1, child.stdout + child.stderr);
  assert.deepEqual(readdirSync(scratch), [], 'CLI HOME and children cleaned even if capture fails');
  if (mode === 'success') { assert.equal(existsSync(evidence), false); return; }
  const folders = readdirSync(evidence); assert.equal(folders.length, 1);
  const saved = join(evidence, folders[0]!);
  const manifest = JSON.parse(readFileSync(join(saved, 'failure.json'), 'utf8'));
  assert.match(manifest.originalError.message, /CLI did not finish/);
  const diagnostics = JSON.parse(readFileSync(join(saved, 'diagnostics.json'), 'utf8'));
  const init = diagnostics.executions.find((item: { argv: string[] }) => item.argv.includes('init'));
  assert.ok(init.argv.includes('workspace')); assert.equal(init.signal, 'SIGKILL');
  assert.match(init.stdout, /deliberate watchdog stdout/); assert.match(init.stderr, /deliberate watchdog stderr/);
  assert.ok(existsSync(join(saved, 'runtime-raw/tasks/.alpacawork/alpacawork.sqlite')));
  assert.ok(existsSync(join(saved, 'control-backup.sqlite')));
  const faults = manifest.outcomes.filter((item: { error?: unknown }) => item.error);
  assert.match(JSON.stringify(faults), /deliberate CLI config capture fault/);
  writeFileSync(join(folder, 'verified.json'), JSON.stringify({ mode, sourceRemoved: !existsSync(manifest.root), init, saved }));
});
