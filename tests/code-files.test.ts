import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { attachmentBytes, DEFAULT_LIMITS } from '@alpacawork/contract';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';

/**
 * A Task whose project registers a code location on this PC: a git repository (its `.git` folder made by hand, as git
 * lays it out: no git runs here or in the server) with one worktree elsewhere, beside a place it does not register.
 */
async function fixture(t: { after: (fn: () => void) => void }, prepare: (places: { base: string; repo: string; outside: string }) => string = places => places.repo) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-code-files-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'workspace'), repo = join(base, 'repo'), worktree = join(base, 'worktree'), outside = join(base, 'outside');
  for (const folder of [root, join(repo, 'src'), join(repo, '.git', 'worktrees', 'wt'), join(worktree, 'src'), outside]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.git', 'config'), '[credential]\n\thelper = store\n');
  writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'gitdir'), `${join(worktree, '.git')}\n`);
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
  writeFileSync(join(worktree, 'src', 'b.ts'), 'export const b = 2;\n');
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  symlinkSync(join(outside, 'secret.txt'), join(repo, 'src', 'link.txt'));
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x50, 0x4b, 0x00, 0x01]));
  // Larger than any file may be: sparse, so it costs no disk.
  writeFileSync(join(repo, 'big.txt'), ''); truncateSync(join(repo, 'big.txt'), attachmentBytes(DEFAULT_LIMITS) + 1);
  const writer = new FileWriter(root);
  writeFileSync(join(root, 'config.yaml'), 'agents: {}\n');
  let project: string;
  try { project = initializeControlFixture(root); } finally { writer.close(); }
  writeFileSync(join(root, 'config.yaml'), `agents: {}\nprojects:\n  ${project}:\n    cwd: ${prepare({ base, repo, outside })}\n`);
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: null, tasks: [{ title: 'Code' }] })).tasks[0]!;
  const server = await startServer(root, 0);
  t.after(() => server.close());
  const read = async (path: string) => {
    const response = await fetch(new URL(`/api/tasks/${task.id}/code?path=${encodeURIComponent(path)}`, server.url));
    return response.ok ? { status: response.status, text: await response.text() }
      : { status: response.status, reason: ((await response.json()) as { error: { reason?: { kind: string } } }).error.reason?.kind };
  };
  const roots = async () => ((await (await fetch(new URL(`/api/tasks/${task.id}/code-roots`, server.url))).json()) as { roots: string[] }).roots.sort();
  return { base, root, repo, worktree, outside, server, task, read, roots };
}

test('a Task reads files of its code location and its worktrees, and nothing past them, git\'s own folder, a large file or a binary one', async t => {
  const { base, repo, worktree, outside, server, task, read } = await fixture(t);
  assert.deepEqual(await read(join(repo, 'src', 'a.ts')), { status: 200, text: 'export const a = 1;\n' });
  assert.deepEqual(await read(join(worktree, 'src', 'b.ts')), { status: 200, text: 'export const b = 2;\n' });
  // Out by `..`, out by a link: judged where the file really is.
  assert.deepEqual(await read(join(repo, 'src', '..', '..', 'outside', 'secret.txt')), { status: 403, reason: 'code_file_outside' });
  assert.deepEqual(await read(join(repo, 'src', 'link.txt')), { status: 403, reason: 'code_file_outside' });
  // git's own folder may hold secrets; a worktree's `.git` file is git's too.
  assert.deepEqual(await read(join(repo, '.git', 'config')), { status: 403, reason: 'code_file_in_git_folder' });
  assert.deepEqual(await read(join(worktree, '.git')), { status: 403, reason: 'code_file_in_git_folder' });
  // A place no project of the Task registers, whether or not something is there, and a path that is not absolute.
  assert.deepEqual(await read(join(outside, 'secret.txt')), { status: 403, reason: 'code_file_outside' });
  assert.deepEqual(await read(join(outside, 'none.txt')), { status: 403, reason: 'code_file_outside' });
  assert.equal((await read('src/a.ts')).status, 400);
  assert.deepEqual(await read(join(repo, 'big.txt')), { status: 413, reason: 'file_exceeds_mib' });
  assert.deepEqual(await read(join(repo, 'bin.dat')), { status: 400, reason: 'code_file_binary' });
  assert.deepEqual(await read(join(repo, 'src', 'none.ts')), { status: 404, reason: 'code_file_missing' });
  // The places the screen may offer to open: the location and each checkout of its repository.
  const roots = await (await fetch(new URL(`/api/tasks/${task.id}/code-roots`, server.url))).json() as { roots: string[] };
  assert.deepEqual(roots.roots.sort(), [repo, worktree].sort());
  assert.ok(!roots.roots.some(place => place.startsWith(join(base, 'outside'))));
});

test('a code file saved with download=1 is its stored bytes under its own name, refused wherever its reading is', async t => {
  const { repo, outside, server, task } = await fixture(t);
  const stored = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const word = "日本語";\r\n')]);
  writeFileSync(join(repo, 'src', 'bom.ts'), stored);
  const save = (path: string) => fetch(new URL(`/api/tasks/${task.id}/code?path=${encodeURIComponent(path)}&download=1`, server.url));
  const saved = await save(join(repo, 'src', 'bom.ts'));
  assert.equal(saved.status, 200);
  assert.deepEqual(Buffer.from(await saved.arrayBuffer()), stored);
  assert.match(saved.headers.get('content-disposition') ?? '', /^attachment; filename="bom\.ts"/);
  const reason = async (path: string) => { const response = await save(path);
    return { status: response.status, reason: ((await response.json()) as { error: { reason?: { kind: string } } }).error.reason?.kind }; };
  assert.deepEqual(await reason(join(outside, 'secret.txt')), { status: 403, reason: 'code_file_outside' });
  assert.deepEqual(await reason(join(repo, '.git', 'config')), { status: 403, reason: 'code_file_in_git_folder' });
  assert.deepEqual(await reason(join(repo, 'big.txt')), { status: 413, reason: 'file_exceeds_mib' });
  assert.deepEqual(await reason(join(repo, 'bin.dat')), { status: 400, reason: 'code_file_binary' });
});

// The test's PATH is the fixture agents'; mkfifo is where the system keeps it.
const MKFIFO = ['/usr/bin/mkfifo', '/bin/mkfifo'].find(path => existsSync(path))!;
const mkfifo = (path: string) => { const made = spawnSync(MKFIFO, [path], { encoding: 'utf8' }); assert.equal(made.status, 0, String(made.error ?? made.stderr)); };

test('a worktree counts only when its checkout names it back: forged records open nothing more', async t => {
  const { base, repo, worktree, outside, read, roots } = await fixture(t, ({ base, repo, outside }) => {
    // A `gitdir` naming a place that does not name the entry back; one naming git's own folder; one naming what holds
    // the repository, though that place names the entry back.
    for (const [name, target] of [['elsewhere', join(outside, '.git')], ['own', join(repo, '.git', '.git')], ['above', join(base, '.git')]] as const) {
      mkdirSync(join(repo, '.git', 'worktrees', name), { recursive: true });
      writeFileSync(join(repo, '.git', 'worktrees', name, 'gitdir'), `${target}\n`);
    }
    writeFileSync(join(base, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'above')}\n`);
    return repo;
  });
  assert.deepEqual(await roots(), [repo, worktree].sort());
  assert.deepEqual(await read(join(outside, 'secret.txt')), { status: 403, reason: 'code_file_outside' });
  assert.deepEqual(await read(join(repo, '.git', 'config')), { status: 403, reason: 'code_file_in_git_folder' });
  assert.equal((await read(join(base, 'workspace', 'config.yaml'))).status, 403);
});

test('a registered worktree whose .git names a repository that does not name it back opens only itself', async t => {
  const { outside, read, roots, base } = await fixture(t, ({ base, outside }) => {
    // A checkout claiming a repository beside the secret, whose entry names some other place, and a forged commondir.
    const claimed = join(base, 'claimed');
    mkdirSync(join(outside, '.git', 'worktrees', 'x'), { recursive: true });
    writeFileSync(join(outside, '.git', 'worktrees', 'x', 'gitdir'), `${join(base, 'nowhere', '.git')}\n`);
    writeFileSync(join(outside, '.git', 'worktrees', 'x', 'commondir'), '../../..\n');
    mkdirSync(claimed);
    writeFileSync(join(claimed, '.git'), `gitdir: ${join(outside, '.git', 'worktrees', 'x')}\n`);
    writeFileSync(join(claimed, 'own.txt'), 'own\n');
    return claimed;
  });
  assert.deepEqual(await roots(), [join(base, 'claimed')]);
  assert.deepEqual(await read(join(base, 'claimed', 'own.txt')), { status: 200, text: 'own\n' });
  assert.deepEqual(await read(join(outside, 'secret.txt')), { status: 403, reason: 'code_file_outside' });
});

test('a file that is also another name (a hard link) is not read: its inside name may be a file outside', async t => {
  const { repo, outside, read } = await fixture(t);
  linkSync(join(outside, 'secret.txt'), join(repo, 'src', 'hard.txt'));
  assert.deepEqual(await read(join(repo, 'src', 'hard.txt')), { status: 403, reason: 'code_file_shared' });
  assert.equal((await read(join(repo, 'src', 'a.ts'))).status, 200);
});

test('a named pipe, as a file or as a git record, is answered at once and never read', async t => {
  const { repo, read, roots } = await fixture(t, ({ repo }) => {
    mkfifo(join(repo, 'pipe'));
    mkdirSync(join(repo, '.git', 'worktrees', 'piped'), { recursive: true });
    mkfifo(join(repo, '.git', 'worktrees', 'piped', 'gitdir'));
    return repo;
  });
  assert.deepEqual(await read(join(repo, 'pipe')), { status: 404, reason: 'code_file_missing' });
  assert.ok((await roots()).includes(repo));
});

test('alpacawork\'s data is never read, though a registered location holds it', async t => {
  const { base, read } = await fixture(t, ({ base }) => base);
  assert.deepEqual(await read(join(base, 'workspace', 'config.yaml')), { status: 403, reason: 'code_file_outside' });
  assert.deepEqual(await read(join(base, 'repo', 'src', 'a.ts')), { status: 200, text: 'export const a = 1;\n' });
});
