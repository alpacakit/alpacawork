import { snapshotGroup } from '../../apps/backend/test-dist/release/recovery-data.js';
/** A target executable for release boundary tests. Its database stands in for the separately tested SQL Owner. */
import { appendFileSync, existsSync, readFileSync, readlinkSync, writeFileSync, writeSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const [mode, workspace, receiptInput] = process.argv.slice(2);
if(mode==='recovery-protocol'){console.log('1');process.exit(0);}
if(mode==='recovery-snapshot'){await snapshotGroup(workspace!,receiptInput!);console.log('{}');process.exit(0);}
if (!workspace || !['inspect', 'migrate'].includes(mode!)) throw new Error('Missing maintenance identity');
const release = resolve(dirname(process.argv[1]!), '../../..');
if (mode === 'inspect' && existsSync(join(release, 'fail-inspect'))) throw new Error('Target inspection unavailable');
const stateFile = join(workspace, 'inspection.json');
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
appendFileSync(join(workspace, 'maintenance.jsonl'), JSON.stringify({ mode, schemaBefore: state.schema,
  stopped: existsSync(join(workspace, 'service-stopped')), current: basename(readlinkSync(join(release, '..', 'current'))) }) + '\n');
const control = JSON.parse(readFileSync(join(release, 'SCHEMA.json'), 'utf8')).control;
if (mode === 'inspect' && existsSync(join(release, 'kill-after-version-refusal'))) {
  // A truncated version error cannot certify a process that actually died by signal.
  writeSync(2, `Error: Unsupported control database version ${state.schema}; supported version is ${control.version}\n`);
  process.kill(process.pid, 'SIGKILL');
}
if (mode === 'inspect' && state.schema !== control.version)
  throw new Error(`Unsupported control database version ${state.schema}; supported version is ${control.version}`);
if (mode === 'migrate') {
  if (existsSync(join(release, 'fail-inspect-after-migrate'))) writeFileSync(join(release, 'fail-inspect'), '');
  if (!existsSync(join(workspace, 'service-stopped'))) throw new Error('Migration ran before service stopped');
  if (existsSync(join(release, 'fail-before-migrate'))) throw new Error('Migration failed before commit');
  state.schema = control.version; state.control = control;
  writeFileSync(stateFile, JSON.stringify(state));
  if (existsSync(join(release, 'fail-after-migrate-commit'))) throw new Error('Target exited after database commit');
}
console.log(JSON.stringify(state));
