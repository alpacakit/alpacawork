/** Outer regression: intentional Playwright failures are data, not failures of test:all.
 * Run in its own e2e queue stage. Inner Playwright inherits admission and never queues again. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

type InnerResult = { title: string; status: string; workerIndex: number; errors: { message: string }[]; attachments: { name: string; path: string }[] };
type Report = { errors: unknown[]; suites: { specs: { title: string; tests: { results: Omit<InnerResult, "title">[] }[] }[] }[] };
type Snapshot = { tasks: { id: string }[] };
type CapturedFs = { root: string; config: string; files: { path: string; size: number; links: number }[]; database: [string, { external_id?: string }[]][] };
const root = process.env.ALPACAWORK_FIXTURE_REGRESSION_OUTPUT ?? mkdtempSync(join(tmpdir(), "alpacawork-capture-regression-"));
mkdirSync(root, { recursive: true });
const cli = resolve("node_modules/@playwright/test/cli.js");
// Cover every runtime/sequence pair and both trace values without repeating
// the full three-axis product. Dedicated capture faults below stay independent.
const scenarios = ["isolated", "prepared", "shared"].flatMap((runtime, index) =>
  ["after-pass", "both-fail"].map((sequence, order) => ({ runtime, sequence,
    trace: (index + order) % 2 ? "on" : "off", closePage: false, fault: "", realTime: false })));
scenarios.push({ runtime: "isolated", sequence: "after-pass", trace: "off", closePage: true, fault: "", realTime: false });
for (const fault of ["backup", "attachment", "workspace"]) scenarios.push({ runtime: "prepared", sequence: "both-fail", trace: "off", closePage: false, fault, realTime: false });
scenarios.push({ runtime: "prepared", sequence: "after-pass", trace: "off", closePage: false, fault: "", realTime: true });
for (const { runtime, sequence, trace, closePage, fault, realTime } of scenarios) test(`${runtime}: ${sequence}, trace ${trace}${closePage ? ", closed page" : ""}${fault ? `, ${fault} fault` : ""}${realTime ? ", real time" : ""}`, async t => {
    const name = `${runtime}-${sequence}-${trace}${closePage ? "-closed-page" : ""}${fault ? `-${fault}` : ""}${realTime ? "-real-time" : ""}`, output = join(root, name), reportPath = `${output}.json`;
    const child = spawn(process.execPath, [cli, "test", "-c", "e2e/fixture-regression/playwright.config.ts"], {
      env: { ...process.env, ALPACAWORK_E2E_ONLY_ISOLATED: runtime === "shared" ? "0" : "1", CAPTURE_RUNTIME: runtime,
        CAPTURE_FAULT: fault, CAPTURE_REAL_TIME: realTime ? "1" : "0",
        CAPTURE_SEQUENCE: sequence, CAPTURE_CLOSE_PAGE: closePage ? "1" : "0", CAPTURE_TRACE: trace, CAPTURE_OUTPUT: output, CAPTURE_REPORT: reportPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", data => { log += data; });
    child.stderr.on("data", data => { log += data; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    const [code] = await once(child, "exit");
    clearTimeout(timer);
    writeFileSync(`${output}.log`, log);
    assert.equal(code, 1, `inner suite must fail deliberately: ${log}`);
    const report: Report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.deepEqual(report.errors, []);
    const results = report.suites.flatMap(suite => suite.specs.map(spec => ({ title: spec.title, ...spec.tests[0]!.results[0]! })));
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(result => result.status), [sequence === "after-pass" ? "passed" : "failed", "failed"]);
    if (sequence === "after-pass") assert.equal(results[0]!.workerIndex, results[1]!.workerIndex, "success then failure must reuse the same worker across files");
    else assert.notEqual(results[0]!.workerIndex, results[1]!.workerIndex, "a failure must restart the worker before the second file");
    for (const result of results) {
      // Check actual output files, not just reporter attachment metadata.
      const dir = join(output, result.title === "first file" ? "01-first.case.ts-first-file" : "02-second.case.ts-second-file");
      const before = JSON.parse(readFileSync(join(dir, "before.json"), "utf8"));
      assert.equal(before.workerIndex, result.workerIndex);
      assert.equal(existsSync(before.root), false, "runtime keeper must have removed the target root after capture");
      await assert.rejects(fetch(`${before.origin}/api/workspace/live`, { signal: AbortSignal.timeout(1000) }), "owned server must be stopped");
      if (result.status === "passed") {
        assert.equal(existsSync(join(dir, "failure-capture.json")), false);
        continue;
      }
      assert.ok(result.errors.some(error => error.message.includes("deliberate inner failure")), "capture must preserve the original failure");
      if (closePage) assert.equal(existsSync(join(dir, "failure-screen.png")), false);
      else {
        const screen = readFileSync(join(dir, "failure-screen.png"));
        assert.equal(screen.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        assert.ok(screen.length > 1000);
        assert.ok(screen.readUInt32BE(16) > 0 && screen.readUInt32BE(20) > 0);
      }
      const api: { status: number; body: Snapshot } = JSON.parse(readFileSync(join(dir, "failure-api.json"), "utf8"));
      assert.equal(api.status, 200);
      assert.deepEqual(api.body.tasks.map(task => task.id), (before.api as Snapshot).tasks.map(task => task.id));
      const fs: CapturedFs = JSON.parse(readFileSync(join(dir, "failure-fs.json"), "utf8"));
      assert.equal(fs.root, before.root, "capture must refer to the live target root");
      assert.equal(readFileSync(join(dir, "failure-workspace/capture-marker.txt"), "utf8"), before.marker);
      const manifest = JSON.parse(readFileSync(join(dir, "failure-workspace/capture-manifest.json"), "utf8"));
      assert.equal(manifest.root, before.root);
      assert.ok(manifest.files.some((file: { path: string; sha256?: string }) => file.path.endsWith(".sqlite") && file.sha256));
      assert.ok(fs.files.some(file => file.path === "capture-marker.txt" && file.size === Buffer.byteLength(before.marker)));
      assert.equal(fs.files.find(file => file.path === 'capture-marker.txt')?.links, 2, 'retain source hardlink count, not the copy inode');
      assert.ok(fs.files.some(file => file.path.endsWith(".sqlite")));
      assert.match(fs.config, /agents:/);
      if (fault !== "backup") {
        assert.ok(fs.database.length > 0);
        assert.ok(fs.database.find(([name, rows]) => name === "tasks" && rows.some(row => row.external_id === "T111")));
      } else assert.equal(fs.database, undefined);
      const captured = JSON.parse(readFileSync(join(dir, "failure-capture.json"), "utf8"));
      assert.deepEqual(captured.map((entry: { name: string }) => entry.name), ["screen", "api", "database", "workspace"]);
      assert.deepEqual(captured.map((entry: { status: string }) => entry.status),
        [closePage ? "rejected" : "fulfilled", "fulfilled", fault === "backup" || fault === "attachment" ? "rejected" : "fulfilled", fault === "workspace" ? "rejected" : "fulfilled"]);
      if (closePage) assert.match(captured[0].reason, /closed/);
      if (fault) {
        assert.ok(captured[fault === 'workspace' ? 3 : 2].reason);
        if (fault === 'workspace') assert.ok(manifest.files.some((file: { path: string; error?: string }) => file.path === 'capture-denied.txt' && file.error?.includes('EACCES')));
        assert.ok(result.errors.some(error => error.message.includes("Failure evidence capture incomplete")), "capture fault must also fail teardown");
      }
      const timing = JSON.parse(readFileSync(join(dir, "runtime-capture.json"), "utf8"));
      assert.equal(timing.root, before.root);
      assert.equal(timing.status, 'failed');
      assert.ok(timing.errors.some((error: { message?: string }) => error.message?.includes('deliberate inner failure')));
      assert.deepEqual(timing.raw.map((entry: { name: string }) => entry.name), ['config.yaml',
        '.alpacawork/alpacawork.sqlite', '.alpacawork/alpacawork.sqlite-wal', '.alpacawork/alpacawork.sqlite-shm', '.alpacawork/runs']);
      for (const entry of timing.raw) {
        assert.equal(entry.status, 'fulfilled');
        assert.equal(entry.present, true);
        assert.ok(existsSync(join(dir, 'runtime-raw', entry.name)), entry.name);
        assert.ok(Date.parse(entry.end) <= Date.parse(timing.backup.begin));
        assert.ok(timing.apis.every((api: { begin: string }) => Date.parse(entry.end) <= Date.parse(api.begin)));
      }
      assert.deepEqual(timing.apis.map((api: { name: string; statusCode: number; status: string }) =>
        [api.name, api.statusCode, api.status]), [['workspace/live', 200, 'fulfilled'], ['host/status', 200, 'fulfilled']]);
      const host = JSON.parse(readFileSync(join(dir, 'failure-host.json'), 'utf8'));
      assert.equal(host.status, 200);
      assert.equal(timing.backup.status, fault === "backup" || fault === "attachment" ? "rejected" : "fulfilled");
      assert.ok(Date.parse(timing.backup.begin) <= Date.parse(timing.backup.end));
      assert.ok(Date.parse(timing.backup.end) <= Date.parse(timing.runsCopy.begin));
      assert.ok(Date.parse(timing.runsCopy.begin) <= Date.parse(timing.runsCopy.end));
      assert.equal(timing.runsCopy.status, fault === "workspace" ? "rejected" : "fulfilled");
      assert.ok(Array.isArray(timing.files));
      if (fault !== "backup") {
        const db = new DatabaseSync(join(dir, "runtime-control.sqlite"), { readOnly: true });
        try {
          assert.deepEqual(timing.attempts, db.prepare("SELECT run_no, attempt_id, next_seq, acked_seq, last_digest, completed_digest FROM run_attempts ORDER BY run_no").all().map(row => ({ ...row })));
          assert.ok(db.prepare("SELECT 1 FROM tasks WHERE external_id='T111'").get());
        } finally { db.close(); }
      }
      assert.equal(existsSync(join(dir, "trace.zip")), trace === "on");
      for (const name of [...(closePage ? [] : ["failure-screen"]), "failure-api", "failure-fs", "failure-capture", "runtime-capture", ...(fault === "backup" || fault === "attachment" ? [] : ["runtime-control"])])
        assert.ok(result.attachments.some(attachment => attachment.name === name && existsSync(attachment.path)));
    }
    t.diagnostic(`evidence: ${output}; workers: ${results.map(result => result.workerIndex).join(",")}`);
  });

for (const fault of ['success', 'stop', 'capture-fault', 'timeout', 'pending-capture']) test(`cleanup evidence: ${fault} after a passed body`, async () => {
  const output = join(root, `cleanup-${fault}`), reportPath = `${output}.json`;
  const child = spawn(process.execPath, [cli, 'test', '-c', 'e2e/fixture-regression/playwright.config.ts', '03-cleanup.case.ts'], {
    env: { ...process.env, CAPTURE_CLEANUP_FAULT: fault, CAPTURE_OUTPUT: output, CAPTURE_REPORT: reportPath,
      ALPACAWORK_E2E_ONLY_ISOLATED: '1', CAPTURE_RUNTIME: 'isolated' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
  const [code] = await once(child, 'exit'); clearTimeout(timer); writeFileSync(`${output}.log`, log);
  assert.equal(code, fault === 'success' ? 0 : 1, log);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const result = report.suites[0].specs[0].tests[0].results[0];
  assert.equal(result.status, fault === 'success' ? 'passed' : ['timeout', 'pending-capture'].includes(fault) ? 'timedOut' : 'failed');
  const dir = join(output, '03-cleanup.case.ts-passed-body-then-cleanup');
  const before = JSON.parse(readFileSync(join(dir, 'before.json'), 'utf8'));
  if (fault !== 'success') {
    assert.ok(existsSync(join(dir, 'runtime-raw/.alpacawork/alpacawork.sqlite')));
    assert.ok(existsSync(join(dir, 'runtime-raw/config.yaml')));
    const capture = JSON.parse(readFileSync(join(dir, 'runtime-capture.json'), 'utf8'));
    assert.equal(capture.root, before.root);
    assert.ok(capture.raw.every((item: { status: string }) => item.status === 'fulfilled'));
    if (['timeout', 'pending-capture'].includes(fault)) {
      assert.equal(capture.mode, 'worker-exit-before-cleanup-finished');
      assert.equal(capture.complete, false);
      assert.equal(capture.status, 'timedOut');
      assert.match(JSON.stringify(capture.errors), /timeout/i);
      const terminal = JSON.parse(readFileSync(join(dir, 'failure-capture.json'), 'utf8'));
      assert.ok(terminal.some((item: { name: string; status: string }) => item.name === 'worker-exit' && item.status === 'rejected'));
      const raw = JSON.parse(readFileSync(join(dir, 'runtime-raw/capture-manifest.json'), 'utf8'));
      assert.equal(raw.status, 'timedOut');
      if (fault === 'pending-capture') {
        const held = JSON.parse(readFileSync(join(dir, 'capture-held.json'), 'utf8'));
        assert.equal(held.raw.status, 'passed');
        assert.deepEqual(raw.raw, held.raw.raw, 'exit must reuse the original raw outcomes');
        const path = join(dir, 'runtime-raw/.alpacawork/alpacawork.sqlite');
        assert.equal(statSync(path).ino, held.inode);
        assert.equal(statSync(path).mtimeMs, held.mtime);
        assert.equal(readFileSync(path).toString('base64'), held.bytes, 'raw bytes must not be recopied or opened with SQLite');
        const cleanup = JSON.parse(readFileSync(join(dir, 'runtime-cleanup.json'), 'utf8'));
        assert.match(JSON.stringify(cleanup.failures), /deliberate stop fault/);
        assert.ok(capture.outcomes.some((item: { name: string; status?: string }) => item.name === 'database' && !item.status), 'pending attachment must remain incomplete');
      }
    }
    else {
      assert.equal(capture.complete, true);
      assert.equal(capture.mode, undefined);
      const cleanup = JSON.parse(readFileSync(join(dir, 'runtime-cleanup.json'), 'utf8'));
      assert.match(JSON.stringify(cleanup.failures), /deliberate stop fault/);
      if (fault === 'capture-fault') assert.match(JSON.stringify(cleanup.failures), /capture incomplete/);
    }
  } else assert.equal(existsSync(join(dir, 'runtime-raw')), false);
  // The keeper finishes just after the worker exits on the timeout path. Bound the observation, not the test threshold.
  const until = Date.now() + 5000;
  while (existsSync(before.root) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(before.root), false, `owned keeper must remove ${before.root}`);
  await assert.rejects(fetch(`${before.origin}/api/workspace/live`, { signal: AbortSignal.timeout(1000) }));
});
