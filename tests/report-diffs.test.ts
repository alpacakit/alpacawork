import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareReportDiffs } from '../apps/cli/test-dist/report-diffs.js';
import { acceptsDiffInput, parseReportDiff } from '@alpacawork/contract/report-diff';
import { RECOVERY_PROTOCOL, INITIAL_RESTORE_ID } from '@alpacawork/contract/recovery';
import { cleanCliEnv } from './helpers/http-cli.ts';

function repository(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'report-diffs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  git('init', '-q'); writeFileSync(join(root, '文書.md'), '前の文章\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(root, '文書.md'), '前の文章に追加した語\n'); git('add', '.'); git('commit', '-qm', 'head');
  const head = git('rev-parse', 'HEAD');
  return { root, base, head, git };
}

test('a submission keeps pinned bytes after branch deletion and never runs diff/textconv/fsmonitor or shell suffixes', async t => {
  const { root, base, head, git } = repository(t), marker = join(root, 'executed');
  const helper = join(root, 'unsafe.sh'); writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  writeFileSync(join(root, '.gitattributes'), '*.md diff=unsafe\n');
  for (const key of ['diff.external', 'diff.unsafe.command', 'diff.unsafe.textconv', 'core.fsmonitor']) git('config', key, helper);
  git('branch', 'submitted', head);
  const prepared = await prepareReportDiffs('Changed.\n\n```sh\ngit diff --stat ' + base + '..submitted | ' + helper + '\n```', root);
  assert.equal(prepared.files.length, 1);
  const diff = parseReportDiff(Buffer.from(prepared.files[0]!.bytes).toString())!;
  assert.equal(diff.source.head.sha, head); assert.match(diff.patch, /追加した語/);
  assert.equal(diff.files[0]?.path, '文書.md'); assert.equal(diff.files[0]?.kept, true);
  assert.equal(existsSync(marker), false);
  git('branch', '-D', 'submitted');
  const again = await prepareReportDiffs('`git diff ' + base + '..' + head + '`', root);
  assert.equal(parseReportDiff(Buffer.from(again.files[0]!.bytes).toString())?.patch, diff.patch);
  assert.match(prepared.description, /```\n\n!\[diff\]\(diffs\/[a-f0-9]{16}\.diff\)/);
  const repeated = await prepareReportDiffs('`git diff ' + base + '..' + head + '`\n`git diff --stat ' + base + '..' + head + '`', root);
  assert.equal(repeated.files.length, 1); assert.equal(repeated.description.match(/!\[diff\]/g)?.length, 1);
});

test('a diff is named by its oldest piece of work; a merge bringing main into the branch, and what it brings, is none of it', async t => {
  const { root, base, git } = repository(t);
  const commit = (file: string, message: string) => { writeFileSync(join(root, file), message + '\n'); git('add', '.'); git('commit', '-qm', message); };
  git('branch', '-M', 'main');
  git('checkout', '-qb', 'work'); commit('a.md', 'T9: first piece of the work'); commit('b.md', 'second piece (T9 review 1)');
  git('checkout', '-q', 'main'); commit('main.md', 'meanwhile on main');
  git('checkout', '-q', 'work'); git('merge', '-q', '--no-edit', 'main'); commit('c.md', 'third piece');
  const read = async (command: string) => parseReportDiff(Buffer.from((await prepareReportDiffs('`' + command + '`', root)).files[0]!.bytes).toString())!;
  const work = await read('git diff main...work');
  assert.equal(work.commits?.title, 'T9: first piece of the work');
  assert.deepEqual(work.commits?.list.map(commit => commit.subject), ['third piece', 'second piece (T9 review 1)', 'T9: first piece of the work']);
  assert.equal(work.commits?.total, 3);
  // Narrowed to paths, only the commits touching them, even a path main changed before it was merged in.
  assert.deepEqual((await read('git diff main...work -- c.md')).commits?.list.map(commit => commit.subject), ['third piece']);
  commit('main.md', 'work touches main.md');
  assert.equal((await read('git diff main...work -- main.md')).commits?.title, 'work touches main.md');
  // A head that did not grow from its base, or no commit between them, has none.
  assert.equal((await read(`git diff work ${base}`)).commits, null);
  git('checkout', '-q', 'main'); commit('other.md', 'main moved on');
  assert.equal((await read('git diff work main')).commits, null);
  // Merged into main, the merge's own subject names it.
  git('merge', '-q', '--no-ff', '-m', 'Merge T9: the work', 'work');
  const merged = await read('git diff HEAD~1..HEAD');
  assert.equal(merged.commits?.title, 'Merge T9: the work');
  assert.equal(merged.commits?.total, 5);
});

test('omitted new files remain added; name status also preserves modified, deleted, renamed and copied files', async t => {
  const { root, git } = repository(t);
  const source = Array.from({ length: 40 }, (_, i) => `copy source ${i}: stable content for the committed fixture\n`).join('');
  writeFileSync(join(root, 'copy-source.md'), source);
  writeFileSync(join(root, 'rename-old.md'), source.replaceAll('copy source', 'rename candidate'));
  writeFileSync(join(root, 'deleted.md'), 'this committed file is deleted\n');
  git('add', '.'); git('commit', '-qm', 'status baseline'); const base = git('rev-parse', 'HEAD');
  copyFileSync(join(root, 'copy-source.md'), join(root, 'copied name.md'));
  writeFileSync(join(root, 'copy-source.md'), source + 'new source paragraph\n');
  renameSync(join(root, 'rename-old.md'), join(root, 'renamed name.md'));
  rmSync(join(root, 'deleted.md'));
  writeFileSync(join(root, 'a-small.md'), 'small\n');
  writeFileSync(join(root, 'z-large.txt'), 'x'.repeat(1_100_000));
  git('add', '.'); git('commit', '-qm', 'large'); const head = git('rev-parse', 'HEAD');
  const prepared = await prepareReportDiffs('`git diff ' + base + '..' + head + '`', root);
  const text = Buffer.from(prepared.files[0]!.bytes).toString(), diff = parseReportDiff(text)!;
  assert.equal(acceptsDiffInput(text), true);
  assert.equal(diff.files.length, 6);
  assert.equal(diff.files.find(file => file.path === 'a-small.md')?.kept, true);
  assert.equal(diff.files.find(file => file.path === 'z-large.txt')?.kept, false);
  assert.equal(diff.files.find(file => file.path === 'z-large.txt')?.change, 'added');
  assert.equal(diff.files.find(file => file.path === 'a-small.md')?.change, 'added');
  assert.equal(diff.files.find(file => file.path === 'copy-source.md')?.change, 'modified');
  assert.equal(diff.files.find(file => file.path === 'deleted.md')?.change, 'deleted');
  for (const [path, oldPath, change] of [['renamed name.md', 'rename-old.md', 'renamed'], ['copied name.md', 'copy-source.md', 'copied']]) {
    const file = diff.files.find(file => file.path === path);
    assert.equal(file?.oldPath, oldPath); assert.equal(file?.change, change);
  }
  assert.doesNotMatch(diff.patch, /diff --git a\/z-large/);
  await assert.rejects(prepareReportDiffs('`git diff missing..HEAD`', root), /cannot be attached/);
  await assert.rejects(prepareReportDiffs('`git diff HEAD~1..HEAD`\n'.repeat(9), root), /at most 8/);
  await assert.rejects(prepareReportDiffs('x'.repeat(950) + '\n`git diff HEAD~1..HEAD`', root), /shorten the description/);
  const triple = await prepareReportDiffs('`git diff HEAD~1...HEAD`', root);
  assert.equal(parseReportDiff(Buffer.from(triple.files[0]!.bytes).toString())?.source.head.sha, head);
});

test('a missing promisor blob cannot start a transport, even if local config explicitly permits the transport', async t => {
  const { root, base, head, git } = repository(t), marker = join(root, 'transport-ran'), helper = join(root, 'transport.sh');
  writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
  const blob = git('rev-parse', `${head}:文書.md`);
  git('config', 'remote.origin.url', `ext::${helper}`);
  git('config', 'remote.origin.promisor', 'true'); git('config', 'remote.origin.partialclonefilter', 'blob:none');
  git('config', 'protocol.ext.allow', 'always');
  rmSync(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  await assert.rejects(prepareReportDiffs('`git diff ' + base + '..' + head + '`', root), /cannot be attached/);
  assert.equal(existsSync(marker), false);
});

test('collection stops its process group when an output limit is exceeded, including descendants holding its pipes', async t => {
  const { root } = repository(t), bin = join(root, 'bin'); mkdirSync(bin);
  const pidFile = join(root, 'git-pids.json');
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\n` +
    `const {spawn}=require('node:child_process');const fs=require('node:fs');\n` +
    `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});\n` +
    `fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));\n` +
    `process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const path = process.env.PATH;
  let pids: number[] = [], timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (existsSync(pidFile)) pids = JSON.parse(readFileSync(pidFile, 'utf8'));
    if (pids[0]) { try { process.kill(-pids[0], 'SIGKILL'); } catch {} }
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  };
  const running = (pid: number) => {
    try {
      process.kill(pid, 0);
      // A terminated orphan may briefly await init's reap; it no longer owns a live process or pipe.
      if (process.platform === 'linux') return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      return true;
    } catch (error) {
      if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  };
  try {
    process.env.PATH = bin + ':' + path;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('collection did not finish after exceeding its output limit')); cleanup(); }, 3000);
    });
    await assert.rejects(Promise.race([prepareReportDiffs('`git diff HEAD~1..HEAD`', root), watchdog]), /exceeds the attachment limit/);
    pids = JSON.parse(readFileSync(pidFile, 'utf8'));
    const until = Date.now() + 500;
    while (pids.some(running) && Date.now() < until) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    assert.deepEqual(pids.filter(running), [], 'the collector must leave neither Git nor its descendant running');
  } finally {
    if (timer) clearTimeout(timer);
    cleanup();
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
  }
});

test('repository diff settings cannot remove the blank context prefix required by a diff card', async t => {
  const { root, git } = repository(t), file = join(root, '文書.md');
  writeFileSync(file, 'first paragraph\n\nold paragraph\n\nlast paragraph\n');
  git('add', '.'); git('commit', '-qm', 'blank context base'); const base = git('rev-parse', 'HEAD');
  writeFileSync(file, 'first paragraph\n\nnew paragraph\n\nlast paragraph\n');
  git('add', '.'); git('commit', '-qm', 'blank context head'); const head = git('rev-parse', 'HEAD');
  const command = '`git diff ' + base + '..' + head + '`';
  const plain = await prepareReportDiffs(command, root);
  for (const [key, value] of [['diff.suppressBlankEmpty', 'true'], ['diff.context', '0'], ['diff.interHunkContext', '100'],
    ['diff.orderFile', join(root, 'does-not-exist')], ['diff.submodule', 'log'], ['diff.renames', 'false']]) git('config', key!, value!);
  const configured = await prepareReportDiffs(command, root);
  const diff = parseReportDiff(Buffer.from(configured.files[0]!.bytes).toString())!;
  assert.match(diff.patch, /^ $/m, 'a blank context row must retain its unified-diff space prefix');
  assert.equal(diff.files[0]?.kept, true);
  assert.deepEqual(configured.files[0]?.bytes, plain.files[0]?.bytes, 'stored bytes are independent of repository output settings');
});

test('the real CLI uploads before reporting, reuses bytes on replay, and sends nothing for invalid versions or expanded length', async t => {
  const { root, base, head } = repository(t);
  const writes: { method: string; url: string; bytes: Buffer; opId?: string }[] = [], stored = new Map<string, Buffer>();
  let loseReportAnswer = true, reports = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), url = req.url!;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url === '/api/runtime/recovery') { json({ protocol: RECOVERY_PROTOCOL, restoreId: INITIAL_RESTORE_ID }); return; }
    if (url.startsWith('/api/commands/run/get')) { json({ run: 'R1', taskId: 'T2', files: [] }); return; }
    if (req.method === 'GET') {
      const value = stored.get(url);
      if (value) { res.writeHead(200); res.end(value); }
      else json({ error: { code: 'not_found', message: 'Missing', retry: 'fix' } }, 404);
      return;
    }
    writes.push({ method: req.method!, url, bytes, opId: req.headers['x-alpacawork-op-id'] as string });
    if (req.method === 'PUT') { stored.set(url, bytes); json({ path: url }); return; }
    reports++;
    if (loseReportAnswer) { loseReportAnswer = false; req.socket.destroy(); return; }
    json({ task: { id: 'T2' }, errors: [] });
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>(resolveClose => server.close(() => resolveClose())));
  const address = server.address(); assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const description = join(root, 'report.md'), cli = resolve('apps/cli/test-dist/cli-entry.js');
  const run = async (text: string, task: string | null = 'T2', asRun = false, opId = `report-operation-${task}`) => {
    writeFileSync(description, text);
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, [cli, '--server', origin, 'task', ...(task ? ['comment', '--task', task] : ['report', '--state', 'doing']), '--title', 'Changes',
        '--description-file', description, '--expected-task-hash', 'a'.repeat(64), '--op-id', opId], {
        cwd: root, env: cleanCliEnv({ HOME: root, XDG_STATE_HOME: join(root, 'state'),
          ...(asRun ? { ALPACAWORK_RUN: 'R1', ALPACAWORK_RUN_TOKEN: 'a'.repeat(64) } : {}) }), stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', code => done({ code, stdout, stderr }));
    });
  };
  assert.equal((await run('`git diff missing..HEAD`')).code, 2); assert.equal(writes.length, 0);
  assert.equal((await run('`git diff HEAD..missing`')).code, 2); assert.equal(writes.length, 0);
  assert.equal((await run('`git diff HEAD~1..HEAD`\n`git diff missing..HEAD`')).code, 2); assert.equal(writes.length, 0);
  assert.equal((await run('x'.repeat(950) + '\n`git diff HEAD~1..HEAD`')).code, 2); assert.equal(writes.length, 0);
  const markdown = '`git diff ' + base + '..' + head + '`';
  const sent = await run(markdown); assert.equal(sent.code, 0, sent.stderr);
  assert.equal(writes[0]?.method, 'PUT'); assert.equal(reports, 2);
  assert.deepEqual(writes[1]?.bytes, writes[2]?.bytes, 'automatic retry uses the exact prepared description');
  const summary = JSON.parse(sent.stdout).diffs[0];
  const file = stored.get(`/api/tasks/T2/file?path=${encodeURIComponent(summary.path)}`)!;
  assert.match(JSON.parse(writes[1]!.bytes.toString()).description, /!\[diff\]/);
  assert.equal(summary.path, 'diffs/' + createHash('sha256').update(file).digest('hex').slice(0, 16) + '.diff');
  assert.equal((await run(markdown)).code, 0);
  assert.equal(writes.filter(write => write.method === 'PUT').length, 1);
  const other = await run('`git diff missing..HEAD`', 'T3', true);
  assert.equal(other.code, 0, other.stderr); assert.equal(JSON.parse(other.stdout).diffs[0].attached, false);
  const implicit = await run(markdown, null, true);
  assert.equal(implicit.code, 0, implicit.stderr);
  assert.equal(JSON.parse(implicit.stdout).diffs[0].path, summary.path);
  assert.equal(writes.at(-1)?.url, '/api/commands/task/report');
  assert.equal(writes.filter(write => write.method === 'PUT').length, 1);
  const workingTreeCommand = '`git diff HEAD 文書.md`';
  const workingTree = await run(workingTreeCommand, 'T2', false, 'working-tree-path');
  assert.equal(workingTree.code, 0, workingTree.stderr);
  assert.equal(JSON.parse(workingTree.stdout).diffs[0].attached, false);
  assert.match(JSON.parse(workingTree.stdout).diffs[0].reason, /path.*working-tree/i);
  assert.equal(JSON.parse(writes.at(-1)!.bytes.toString()).description, workingTreeCommand);
  assert.equal(writes.filter(write => write.method === 'PUT').length, 1);
});
