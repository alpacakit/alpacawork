import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { Problem, errorBody } from '@alpacawork/core';
import { makeFolder } from '@alpacawork/backend/test-dist/control/folders.js';

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-folders-')));
  const root = join(base, 'data'), code = join(base, 'code');
  mkdirSync(root); mkdirSync(code);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const make = (path: string, name: string) => makeFolder(root, { path, name });
  return { base, root, code, make };
}
const issue = (code: string, path?: string) => (error: unknown) => {
  assert.ok(error instanceof Problem);
  assert.equal(error.issues?.[0]?.code, code);
  if (path) assert.equal(error.issues?.[0]?.path, path);
  return true;
};

test('makes one trimmed folder, returns the absolute real path, and accepts 255 bytes', async t => {
  const h = fixture(t), link = join(h.base, 'linked');
  symlinkSync(h.code, link);
  assert.deepEqual(await h.make(link, '  新しい場所  '), { path: join(h.code, '新しい場所') });
  assert.ok(existsSync(join(h.code, '新しい場所')));
  assert.deepEqual(await h.make(h.code, 'あ'.repeat(85)), { path: join(h.code, 'あ'.repeat(85)) });
  // A sibling whose name starts like the workspace is outside it.
  assert.deepEqual(await h.make(h.base, 'data-code'), { path: join(h.base, 'data-code') });
});

test('same-name folders, hidden folders, and files are conflicts', async t => {
  const h = fixture(t);
  mkdirSync(join(h.code, 'existing')); mkdirSync(join(h.code, '.hidden'));
  writeFileSync(join(h.code, 'file'), '');
  for (const name of ['existing', '.hidden', 'file']) await assert.rejects(h.make(h.code, name), issue('folder_exists', 'name'));
});

test('invalid names are rejected before touching the disk; mkdir never makes ancestors', async t => {
  const h = fixture(t);
  for (const name of ['', '  ', '/', 'a/b', '\0', 'a\0b', '.', '..', ' あ'.repeat(86), 'x'.repeat(256)])
    await assert.rejects(h.make(h.code, name), issue('folder_name'));
  assert.equal(existsSync(join(h.code, 'a')), false);
  await assert.rejects(h.make('relative', 'new'), issue('absolute_path', 'path'));
  await assert.rejects(h.make(join(h.code, 'missing'), 'new'), issue('missing_directory', 'path'));
  writeFileSync(join(h.code, 'file'), '');
  await assert.rejects(h.make(join(h.code, 'file'), 'new'), issue('missing_directory', 'path'));
});

test('the destination itself is checked before mkdir, including real parents and linked workspace roots', async t => {
  const h = fixture(t), link = join(h.base, 'linked-data'), parent = join(h.base, 'linked-parent');
  symlinkSync(h.root, link); symlinkSync(h.base, parent);
  await assert.rejects(h.make(h.base, 'data'), issue('inside_workspace'));
  await assert.rejects(h.make(parent, 'data'), issue('inside_workspace'));
  await assert.rejects(h.make(h.root, 'forbidden'), issue('inside_workspace'));
  await assert.rejects(h.make(link, 'forbidden'), issue('inside_workspace'));
  await assert.rejects(makeFolder(link, { path: h.root, name: 'forbidden' }), issue('inside_workspace'));
  assert.equal(existsSync(join(h.root, 'forbidden')), false);
});

test('a directory without write permission refuses creation', { skip: process.getuid?.() === 0 }, async t => {
  const h = fixture(t);
  chmodSync(h.code, 0o555);
  try { await assert.rejects(h.make(h.code, 'new'), issue('unwritable_directory', 'path')); }
  finally { chmodSync(h.code, 0o755); }
  assert.equal(existsSync(join(h.code, 'new')), false);
});

for (const code of ['ENOSPC', 'EDQUOT', 'ELOOP']) {
  test(`mkdir ${code} is translated only when it has a folder-specific meaning`, async t => {
    const h = fixture(t);
    const error = Object.assign(new Error(`mkdir failed: ${code}`), { code, syscall: 'mkdir', path: join(h.code, 'new') });
    const mocked = t.mock.method(fs, 'mkdir', async () => { throw error; });
    syncBuiltinESMExports();
    try {
      if (code === 'ELOOP') {
        await assert.rejects(h.make(h.code, 'new'), caught => {
          assert.equal(caught, error, 'an unmapped errno reaches the normal failure boundary unchanged');
          const body = errorBody(caught).error;
          assert.equal(body.code, 'unavailable');
          assert.equal(body.retry, 'check');
          assert.deepEqual(body.reason, { kind: 'system_error', code, syscall: 'mkdir', path: error.path, diagnostic: error.message });
          return true;
        });
      } else {
        await assert.rejects(h.make(h.code, 'new'), issue('no_space', 'path'));
      }
      assert.equal(mocked.mock.callCount(), 1);
      assert.equal(existsSync(join(h.code, 'new')), false);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  });
}
