/** Actual old CLI (built from --old-ref) entrance; dedicated temporary unit, synthetic root, always removed. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';
import { point } from '@alpacawork/backend/test-dist/release/layout.js';
const { values } = parseArgs({ options: { production: { type: 'string' }, diagnostic: { type: 'string' }, old: { type: 'string' }, out: { type: 'string' } } });
const { production, diagnostic, old } = values;
if (!production || !diagnostic || !old || !values.out) throw Error('all release paths required');
const out = resolve(values.out), releases = dirname(production), root = join(out, 'upgrade-copy');
copyWorkspace(createOriginal({ ...profiles.small, seed: 'diagnostic-upgrade' }, join(out, 'fixture-cache')).root, root);
const unit = 'alpacawork-diagnostic-test-' + randomUUID() + '.service';
const units = join(homedir(), '.config/systemd/user'); mkdirSync(units, { recursive: true });
const file = join(units, unit), wrapper = join(out, 'test-unit.mjs');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ALPACAWORK_|CODEX_|CLAUDE_)/.test(key)));
const journal = () => JSON.parse(readFileSync(join(releases, 'switch.json'), 'utf8'));
const records: unknown[] = [];
async function run(executable: string, args: string[], extra = {}) {
  const child = spawn(executable, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise<number>(done => child.once('exit', code => done(code ?? 1)));
  const record = { executable, args, pid: child.pid, status, stdout, stderr }; records.push(record);
  writeFileSync(join(out, 'upgrade-commands.json'), JSON.stringify(records, null, 2)); return record;
}
const systemctl = (...args: string[]) => run('/usr/bin/systemctl', ['--user', ...args]);
const cli = (release: string, args: string[], extra = {}) => run(process.execPath, [join(release, 'apps/backend/dist/backend.js'), '--workspace', root, 'release', ...args,
  '--releases', releases, ...(['deploy', 'rollback'].includes(args[0]!) ? ['--service', unit] : [])], extra);
const deploy = ['deploy', '--repo', process.cwd(), '--ref', basename(production)];
async function ready() {
  for (const deadline = performance.now() + 30000; performance.now() < deadline;) {
    try {
      const connection = JSON.parse(readFileSync(join(root, '.alpacawork/connection.json'), 'utf8'));
      const response = await fetch(new URL('/api/runtime/readiness', connection.url), { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).state === 'accepting') return connection;
    } catch { /* bounded startup */ }
    await delay(100);
  }
  throw Error('Test unit not ready');
}
let success = false;
try {
  point(releases, 'current', old); point(releases, 'previous', null);
  writeFileSync(wrapper, `import {realpathSync} from 'node:fs';\nimport {pathToFileURL} from 'node:url';\nconst entry=realpathSync(${JSON.stringify(join(releases, 'current/apps/backend/dist/backend.js'))});\nconst {main}=await import(pathToFileURL(entry).href); await main(['--workspace',${JSON.stringify(root)},'workspace','serve','--port','0']);\n`);
  writeFileSync(file, `[Unit]\nDescription=Bounded diagnostic build regression\nStartLimitIntervalSec=0\n[Service]\nType=simple\nExecStart=${process.execPath} ${wrapper}\nEnvironment=PATH=${process.env.PATH}\nEnvironment=NODE_OPTIONS=--import=${resolve('e2e/perf/guard.mjs')}\nUnsetEnvironment=ALPACAWORK_RUN ALPACAWORK_RUN_TOKEN\nRestart=on-failure\nRestartSec=0.2\nRuntimeMaxSec=900\nTimeoutStopSec=20\nKillMode=control-group\nStandardOutput=append:${join(out, 'upgrade-unit.log')}\nStandardError=append:${join(out, 'upgrade-unit.log')}\n`);
  assert.equal((await systemctl('daemon-reload')).status, 0);
  assert.equal((await systemctl('start', unit)).status, 0); await ready();
  const introduced = await cli(old, deploy); assert.equal(introduced.status, 0, introduced.stderr);
  assert.equal(realpathSync(join(releases, 'current')), production); await ready();
  assert.equal((await cli(production, ['rollback'])).status, 0); assert.equal(realpathSync(join(releases, 'current')), old); await ready();
  // Refuse one service stop at the adapter boundary. The old CLI's actual prepared journal survives untouched.
  const shim = join(out, 'refuse-stop-bin'), flag = join(out, 'refuse-test-stop'); mkdirSync(shim);
  writeFileSync(flag, '');
  writeFileSync(join(shim, 'systemctl'), `#!/bin/sh\nif [ -f '${flag}' ] && [ "$2" = stop ]; then exit 1; fi\nexec /usr/bin/systemctl "$@"\n`, { mode: 0o700 });
  const refused = await cli(old, deploy, { PATH: shim + ':' + process.env.PATH });
  assert.notEqual(refused.status, 0); const pending = journal(); assert.equal(pending.phase, 'prepared');
  writeFileSync(join(out, 'old-pending-journal.json'), JSON.stringify(pending, null, 2)); rmSync(flag);
  const resumed = await cli(production, deploy); assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(journal().opId, pending.opId); assert.equal(journal().phase, 'committed'); await ready();
  const measured = await cli(production, [...deploy, '--kind', 'diagnostic']); assert.equal(measured.status, 0, measured.stderr);
  assert.equal(realpathSync(join(releases, 'current')), diagnostic); await ready();
  const rollback = await cli(diagnostic, ['rollback']); assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(realpathSync(join(releases, 'current')), production); await ready();
  const again = await cli(production, [...deploy, '--kind', 'diagnostic']); assert.equal(again.status, 0, again.stderr); await ready();
  const pruned = await cli(diagnostic, ['prune', '--keep', '0']); assert.equal(pruned.status, 0, pruned.stderr);
  assert.ok(!existsSync(old)); assert.ok(existsSync(production)); assert.ok(existsSync(diagnostic));
  success = true;
} finally {
  await systemctl('stop', unit);
  const activity = await systemctl('is-active', unit);
  const processesLeft = !['inactive', 'unknown', 'failed'].includes(activity.stdout.trim());
  await systemctl('reset-failed', unit); rmSync(file, { force: true }); await systemctl('daemon-reload');
  writeFileSync(join(out, 'upgrade-result.json'), JSON.stringify({ success, unit, root, unitRemoved: !existsSync(file), processesLeft }, null, 2));
  assert.equal(processesLeft, false, 'test service must actually stop');
  if (success) removeWorkspace(root);
}
