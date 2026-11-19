import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, rmdirSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeRecoveryService, recoveryServiceRestarts } from './helpers/recovery-service-identity.ts';

test('IW1 observes the sole service identity: live, exited, reused, missing, invalid and unreadable stay distinct', { skip: process.platform !== 'linux' && 'reads /proc/<pid>/stat' }, async t => {
  const base = mkdtempSync(join(tmpdir(), 'service-identity-')), file = join(base, 'serve.identity.json');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // The parent owns the observation interval; the watchdog only bounds an abandoned fixture.
  const child = spawn(process.execPath, ['-e', `
    const watchdog = setTimeout(() => process.exit(1), 10_000);
    process.once('message', () => { clearTimeout(watchdog); process.disconnect(); });
    process.once('disconnect', () => { clearTimeout(watchdog); });
    process.send('ready');
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const ended = once(child, 'exit');
  try {
    await once(child, 'message');
    const starttick = readFileSync('/proc/' + child.pid + '/stat', 'utf8').split(') ')[1]!.split(' ')[19]!;
    const identity = { pid: child.pid, starttick, cwd: process.cwd() }, observations: unknown[] = [];
    writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
    assert.equal(observeRecoveryService(base).state, 'live');
    assert.equal(recoveryServiceRestarts(base, observation => observations.push(observation)), 0);
    writeFileSync(file, JSON.stringify({ ...identity, starttick: starttick + '0' }));
    assert.equal(observeRecoveryService(base).state, 'reused');
    assert.throws(() => recoveryServiceRestarts(base, observation => observations.push(observation)), /reused/);
    rmSync(file);
    assert.equal(observeRecoveryService(base).state, 'missing');
    assert.throws(() => recoveryServiceRestarts(base, observation => observations.push(observation)), /missing/);
    writeFileSync(file, '{');
    assert.equal(observeRecoveryService(base).state, 'invalid');
    assert.throws(() => recoveryServiceRestarts(base, observation => observations.push(observation)), /invalid/);
    writeFileSync(file, JSON.stringify(identity)); chmodSync(file, 0o000);
    try {
      assert.equal(observeRecoveryService(base).state, 'unreadable');
      assert.throws(() => recoveryServiceRestarts(base, observation => observations.push(observation)), /unreadable/);
    } finally { chmodSync(file, 0o600); }
    child.send('exit');
    await ended;
    assert.equal(observeRecoveryService(base).state, 'exited');
    assert.equal(recoveryServiceRestarts(base, observation => observations.push(observation)), 1);
    assert.deepEqual(observations.map((observation: any) => observation.state), ['live', 'reused', 'missing', 'invalid', 'unreadable', 'exited']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
  }
});

test('the emitted fixture stop code checks ordinary/deleted cwd, process exit and PID reuse', { skip: process.platform !== 'linux' && 'reads /proc/<pid>/stat' }, async t => {
  const base = mkdtempSync(join(tmpdir(), 'service-stop-code-'));
  const workspace = join(base, 'data'), log = join(base, 'serve.log');
  mkdirSync(join(workspace, '.alpacawork'), { recursive: true });
  writeFileSync(join(base, 'service.json'), JSON.stringify({ workspace, releases: join(base, 'releases'), fixtureImages: [] }));
  const previous = process.env.ALPACAWORK_RECOVERY_FIXTURE;
  process.env.ALPACAWORK_RECOVERY_FIXTURE = base;
  const children: ReturnType<typeof spawn>[] = [], ended: Promise<unknown>[] = [], evidence: unknown[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(ended);
    if (previous === undefined) delete process.env.ALPACAWORK_RECOVERY_FIXTURE;
    else process.env.ALPACAWORK_RECOVERY_FIXTURE = previous;
    const output = process.env.ALPACAWORK_FAILURE_EVIDENCE_DIR;
    if (output) writeFileSync(join(output, 'stop-code-contrasts.json'), JSON.stringify(evidence, null, 2));
    rmSync(base, { recursive: true, force: true });
  });
  const { stop } = await import('./fixtures/recovery-service.mjs');
  for (const kind of ['ordinary', 'deleted', 'asynchronous', 'exited', 'reused', 'stalled']) {
    const cwd = join(base, kind); mkdirSync(cwd);
    const fd = openSync(log, 'a');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {createServer} from 'node:http';
      const workspace=${JSON.stringify(workspace)};
      const server=createServer((req,res)=>{
        if(req.method!=='POST'||req.url!=='/api/runtime/quiesce'){res.writeHead(404);res.end();return;}
        res.setHeader('Connection','close');res.end(JSON.stringify({workspace,generation:'boundary',state:'drained'}));
      });
      const close=()=>server.close(()=>{if(process.connected)process.disconnect();});
      const lifetime=setTimeout(close,10_000);
      process.once('SIGTERM',()=>{${kind === 'stalled' ? '' : 'clearTimeout(lifetime);' + (kind === 'asynchronous' ? 'setTimeout(close,2050);' : 'close();')}});
      server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
    `], { cwd, stdio: ['ignore', fd, fd, 'ipc'] });
    closeSync(fd);
    children.push(child);
    const exited = once(child, 'exit'); ended.push(exited);
    const [ready] = await once(child, 'message');
    const starttick = readFileSync('/proc/' + child.pid + '/stat', 'utf8').split(') ')[1]!.split(' ')[19]!;
    const identity = { pid: child.pid, starttick, cwd };
    writeFileSync(join(base, 'serve.identity.json'), JSON.stringify(identity));
    writeFileSync(join(workspace, '.alpacawork/connection.json'), JSON.stringify({ url: 'http://127.0.0.1:' + ready.port, generation: 'boundary' }));
    assert.equal(observeRecoveryService(base).state, 'live');
    if (kind === 'deleted') rmdirSync(cwd);
    if (kind === 'exited') { child.kill('SIGTERM'); await exited; }
    if (kind === 'reused') {
      writeFileSync(join(base, 'serve.identity.json'), JSON.stringify({ ...identity, starttick: starttick + '0' }));
      assert.equal(observeRecoveryService(base).state, 'reused');
    }
    const result = stop();
    const event = JSON.parse(readFileSync(join(base, 'service-events.jsonl'), 'utf8').trim().split('\n').at(-1)!);
    evidence.push({ kind, result, identity, event });
    if (kind === 'reused') {
      assert.equal(result, false);
      assert.match(event.stderr, /Fixture PID\/starttick mismatch/);
      assert.doesNotMatch(event.audit, /SIGTERM/);
      writeFileSync(join(base, 'serve.identity.json'), JSON.stringify(identity));
      assert.equal(observeRecoveryService(base).state, 'live');
      assert.equal(stop(), true, 'cleanup uses the restored sole identity');
    } else if (kind === 'stalled') {
      assert.equal(result, false, 'a process that ignores stop must exhaust the original total budget');
      assert.notEqual(event.status, 0);
      assert.ok(event.stderr.includes('exit deadline') || event.error?.includes('ETIMEDOUT'));
      assert.equal(observeRecoveryService(base).state, 'live');
      child.kill('SIGKILL'); // Only this deliberately broken fixture is force-reaped.
    } else {
      assert.equal(result, true, event.stderr);
      assert.equal(event.status, 0);
      if (kind !== 'exited') {
        const audit = event.audit.trim().split('\n').map((line: string) => JSON.parse(line));
        assert.equal(audit[0].result.state, 'drained');
        assert.equal(audit[1].cwd, cwd + (kind === 'deleted' ? ' (deleted)' : ''));
        assert.equal(audit[1].signal, 'SIGTERM');
      } else assert.doesNotMatch(event.audit, /SIGTERM/);
    }
    await exited;
    assert.equal(observeRecoveryService(base).state, 'exited');
  }
});
