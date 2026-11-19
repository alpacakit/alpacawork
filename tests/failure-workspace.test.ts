import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

test('fixtures preserve original failures and capture faults before cleanup; successes only clean up', async t => {
  const cases = ['acceptance', 'runtime'].flatMap(kind => ['success', 'failure', 'capture-fault'].map(mode => ({ kind, mode, live: false, closed: false })));
  cases.push({ kind: 'acceptance', mode: 'failure', live: true, closed: false });
  cases.push({ kind: 'runtime', mode: 'failure', live: true, closed: false });
  cases.push({ kind: 'runtime', mode: 'failure', live: false, closed: true });
  // Each case is its own workspace and process, so they run together; their results are still verified in order and
  // the first failed verification stops the rest, so later probes cannot hide an invalid setup.
  const started = cases.map(({ kind, mode, live, closed }) => {
    const parent = process.env.ALPACAWORK_FAILURE_EVIDENCE_DIR ?? tmpdir();
    mkdirSync(parent, { recursive: true });
    const folder = mkdtempSync(join(parent, `fixture-${kind}-${mode}${live ? '-live' : ''}-`));
    const evidence = join(folder, 'evidence'), report = join(folder, 'subject.json');
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT; // A fresh test runner, not a recursive invocation of its parent.
    const child = execFileAsync(process.execPath, ['--test', 'tests/fixtures/failure-evidence-subject.ts'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...childEnv, ALPACAWORK_FAILURE_EVIDENCE_DIR: evidence,
        ALPACAWORK_EVIDENCE_SUBJECT: JSON.stringify({ kind, report, live, closed, fail: mode !== 'success', fault: mode === 'capture-fault' }) },
    }).then(({ stdout, stderr }) => ({ status: 0, stdout, stderr, error: undefined }),
      (error: { code?: unknown; killed?: boolean; stdout?: string; stderr?: string }) => typeof error.code === 'number' && !error.killed
        ? { status: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error: undefined }
        : { status: null, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error });
    return { folder, evidence, report, child };
  });
  // A failed verification stops the loop; the other cases still end before their folders go.
  t.after(async () => {
    await Promise.allSettled(started.map(item => item.child));
    if (!process.env.ALPACAWORK_FAILURE_EVIDENCE_DIR) for (const { folder } of started) rmSync(folder, { recursive: true, force: true });
  });
  for (const [index, { kind, mode, live, closed }] of cases.entries()) {
    const { folder, evidence, report } = started[index]!, child = await started[index]!.child;
    const output = child.stdout + child.stderr;
    writeFileSync(join(folder, 'output.log'), output);
    assert.ifError(child.error);
    assert.equal(child.status, mode === 'success' ? 0 : 1, output);
    assert.match(output, /tests 1/);
    const subject = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(subject.removed, true, 'fixture cleanup still runs after capture, including capture faults');
    if (mode === 'success') {
      assert.equal(existsSync(evidence), false, 'successful fixtures do not capture evidence');
      t.diagnostic(`Verified ${kind} success cleanup`);
      continue;
    }
    assert.match(output, new RegExp(`original ${kind} failure before teardown`));
    const folders = readdirSync(evidence);
    assert.equal(folders.length, 1);
    const saved = join(evidence, folders[0]!);
    const manifest = JSON.parse(readFileSync(join(saved, 'failure.json'), 'utf8'));
    assert.match(manifest.originalError.message, new RegExp(`original ${kind} failure`));
    if (live) {
      assert.equal(manifest.api.state, 'started');
      const raw = manifest.outcomes.find((item: { name: string }) => item.name === 'raw');
      for (const [name, path] of [['workspace/live', 'live.json'], ['host/status', 'host.json']]) {
        const api = manifest.outcomes.find((item: { name: string }) => item.name === name);
        assert.ok(raw.end <= api.begin);
        assert.equal(JSON.parse(readFileSync(join(saved, path!), 'utf8')).status, 200);
      }
      if (kind === 'runtime') {
        // In the caller's catch Node has not yet finalized its error, so the explicit failure is essential.
        assert.equal(manifest.contextAtCapture.error, null);
      }
    } else {
      assert.equal(manifest.api.state, 'not_started');
      assert.match(manifest.api.reason, /not applicable/);
    }
    const raw = join(saved, 'runtime-raw');
    assert.equal(readFileSync(join(raw, 'before-cleanup.txt'), 'utf8'), 'subject still exists');
    const files = JSON.parse(readFileSync(join(raw, 'capture-manifest.json'), 'utf8')).files;
    for (const name of ['.alpacawork/alpacawork.sqlite', ...closed ? [] : [
      '.alpacawork/alpacawork.sqlite-wal', '.alpacawork/alpacawork.sqlite-shm']]) {
      const file = files.find((item: { path: string }) => item.path === name);
      assert.ok(file?.sha256, `raw ${name} was present before the live store closed`);
      assert.equal(createHash('sha256').update(readFileSync(join(raw, name))).digest('hex'), file.sha256,
        'backup/inspection must not mutate raw evidence');
    }
    assert.ok(files.some((file: { path: string }) => file.path.startsWith('.alpacawork/runs/')));
    assert.equal(existsSync(join(saved, 'control-backup.sqlite')), true);
    assert.deepEqual(JSON.parse(readFileSync(join(saved, 'database-integrity.json'), 'utf8')), [{ integrity_check: 'ok' }]);
    const diagnostics = JSON.parse(readFileSync(join(saved, 'diagnostics.json'), 'utf8'));
    if (live && kind === 'runtime') {
      assert.equal(diagnostics.serverStillOpen, true);
      assert.match(diagnostics.callerError.message, /original runtime failure/);
    }
    assert.ok(diagnostics.task.hash);
    assert.ok(diagnostics.snapshot.records.some((run: { id: string }) => run.id === subject.run));
    const rawOutcome = manifest.outcomes.find((item: { name: string }) => item.name === 'raw');
    const database = manifest.outcomes.find((item: { name: string }) => item.name === 'database');
    assert.ok(rawOutcome.end <= database.begin);
    if (mode === 'capture-fault') {
      assert.match(output, /injected config copy fault/);
      assert.match(rawOutcome.error.message, /config copy fault/);
    } else assert.equal(manifest.outcomes.filter((item: { error?: unknown }) => item.error).length, 0);
    t.diagnostic(`Verified ${kind} ${mode}${live ? ' with live/host HTTP' : ''}`);
  }
});
