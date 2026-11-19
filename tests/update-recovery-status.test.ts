/** Real switch restoration and a separate recovery CLI must report progress only while executing. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { platform } from '@alpacawork/core';
import { managedUpdateFixture } from './helpers/managed-update.ts';
import { simpleUpdateCandidate } from './helpers/simple-update-candidate.ts';

const ok = (response: any) => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, timeout = 240000): Promise<T> {
  let last: unknown;
  for (const end = Date.now() + timeout; Date.now() < end;) {
    try { const value = await read(); last = value; if (accept(value)) return value; } catch (error) { last = String(error); }
    await delay(25);
  }
  throw new Error('Timed out: ' + JSON.stringify(last));
}

test('HTTP restoration stops at attention with the original resume; a separate live recovery CLI still reports recovering', { skip: process.platform !== 'linux' && 'GNU tar --transform and a linux-x64-glibc fixture image', timeout: 600000 }, async t => {
  const f = await managedUpdateFixture(t), candidate = await simpleUpdateCandidate(t, f);
  f.configureUpdate({ failRestart: [join(f.releases, candidate.sha)] });
  // Inject only at ordinary filesystem publication in this private service adapter. Never handwrite journal state.
  appendFileSync(f.adapter, `
const publish = fs.renameSync;
fs.renameSync = function(from, to) {
  if (String(to) === join(root, 'releases/switch.json')) {
    const value = JSON.parse(readFileSync(from, 'utf8'));
    const phase = value.phase;
    if (phase === 'aborted' || phase === 'recovery_intent') {
      // Restore gate: old serve has passed real readiness, but the durable phase is still restoring_old.
      // CLI gate: publish recovery_intent before pausing, while the existing release lock remains held.
      if (phase === 'recovery_intent') publish(from, to);
      writeFileSync(join(root, 'gate-' + phase), JSON.stringify({pid:process.pid,phase}));
      for (const end = Date.now()+60000; Date.now()<end && !existsSync(join(root,'pass-'+phase));)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      if (!existsSync(join(root,'pass-'+phase))) throw Error('Synthetic journal gate expired');
      if (phase === 'recovery_intent') return;
    }
  }
  return publish(from, to);
}; syncBuiltinESMExports();
`);
  await f.start();
  const status = async () => ok(await f.call('/api/update/status'));
  const available = await until(status, value => value.kind === 'available');
  const review = ok(await f.call('/api/update/review?candidateId=' + available.candidateId));
  const input = { opId: randomUUID(), candidateId: available.candidateId, reviewDigest: review.reviewDigest };
  ok(await f.call('/api/update/confirm', input));
  const gate = join(f.root, 'gate-aborted');
  await until(() => existsSync(gate), Boolean);
  const journal = join(f.releases, 'switch.json'), execution = join(f.releases, '.updates', 'state.json');
  assert.equal(json(journal).phase, 'restoring_old');
  assert.equal((await status()).kind, 'recovering', 'the actual restoring controller is still alive');
  const controller = json(gate); controller.started = platform.run.started(controller.pid); assert(controller.started);
  assert.equal(platform.run.started(controller.pid), controller.started);
  process.kill(controller.pid, 'SIGKILL');
  await f.awaitUpdateControllers(input.opId);
  assert.equal(platform.run.commandProcesses(controller.pid, null).some(p => p.pid === controller.pid && p.started === controller.started), false);
  const stopped = readFileSync(journal);
  for (let read = 0; read < 2; read++) {
    assert.deepEqual(await status(), { kind: 'attention', opId: input.opId, version: '0.3.1' });
    assert.deepEqual(ok(await f.call('/api/update/review')).resume, input);
    assert.deepEqual(readFileSync(journal), stopped, 'GET never repairs the stalled switch');
    await delay(100);
  }
  const saved = json(execution).operation;
  assert(!saved.controller || !platform.run.commandProcesses(saved.controller.pid, null).some(p => p.pid === saved.controller.pid && p.started === saved.controller.started));

  // Enter the actual formal CLI, including its whole-operation release lock, with the real switch backup.
  const child = spawn(process.execPath, [join(f.release, 'apps/backend/dist/backend.js'), '--workspace', f.workspace,
    'release', 'recover', '--releases', f.releases, '--service', f.definition.name, '--backup', json(journal).backup], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ALPACAWORK_'))),
      ...f.installationEnvironment, ALPACAWORK_MANAGED_RELEASES: f.releases, NODE_OPTIONS: '--import=' + f.adapter },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit'); let log = '';
  child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
  const expiry = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    await until(() => { assert.equal(child.exitCode, null, log); return existsSync(join(f.root, 'gate-recovery_intent')); }, Boolean, 30000);
    assert.equal(json(journal).phase, 'recovery_intent');
    assert.deepEqual(await status(), { kind: 'recovering', opId: input.opId, version: '0.3.1' }, 'CLI progress cannot depend on the dead update controller');
    child.kill('SIGKILL'); await exited;
    assert.deepEqual(await status(), { kind: 'attention', opId: input.opId, version: '0.3.1' });
    assert.deepEqual(ok(await f.call('/api/update/review')).resume, input);
  } finally { clearTimeout(expiry); child.kill('SIGKILL'); await exited; }
  await f.stop();
});
