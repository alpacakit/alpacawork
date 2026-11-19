/** Which bundled files count as third-party packages, and the license text a package without a license file gets. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describe, packageDirectory, workspaceRecord } from '../scripts/third-party-record.ts';

test('a bundled module id names its package directory; own sources and virtual modules name none', () => {
  const store = '/repo/node_modules/.pnpm/react@19.3.0/node_modules';
  assert.equal(packageDirectory(store + '/react/cjs/react.production.js'), store + '/react');
  assert.equal(packageDirectory('\0' + store + '/@tiptap/core/dist/index.js?commonjs-proxy'), store + '/@tiptap/core');
  assert.equal(packageDirectory('/repo/node_modules/tailwindcss/index.css'), '/repo/node_modules/tailwindcss');
  assert.equal(packageDirectory('/repo/apps/web/src/main.tsx'), undefined);
  assert.equal(packageDirectory('\0vite/preload-helper.js'), undefined);
});

test('a workspace package that bundles its dependencies passes its record on; a missing license file gets the standard text', t => {
  const root = mkdtempSync(join(tmpdir(), 'third-party-record-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, text: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  put('packages/db/package.json', '{}'); put('packages/db/dist/third-party.json', '[]'); put('packages/db/dist/index.js', '');
  put('packages/core/package.json', '{}'); put('packages/core/dist/index.js', '');
  assert.equal(workspaceRecord(join(root, 'packages/db/dist/index.js')), join(root, 'packages/db/dist/third-party.json'));
  assert.equal(workspaceRecord(join(root, 'packages/db/src/index.ts')), undefined);
  assert.equal(workspaceRecord(join(root, 'packages/core/dist/index.js')), undefined);

  put('m/package.json', JSON.stringify({ name: 'm', version: '1.0.0', license: 'MIT', author: 'Ann <a@example.invalid>' }));
  put('a/package.json', JSON.stringify({ name: 'a', version: '2.0.0', license: 'Apache-2.0' }));
  put('a/license-update.mjs', 'not a license');
  put('own/package.json', JSON.stringify({ name: 'own', version: '1.0.0' })); put('own/LICENSE.md', 'Copyright (c) Own');
  assert.match(describe(join(root, 'm')).texts[0]!.text, /^Copyright \(c\) Ann <a@example\.invalid>\n\nPermission is hereby granted/);
  put('anon/package.json', JSON.stringify({ name: 'anon', version: '1.0.0', license: 'MIT' }));
  assert.deepEqual(describe(join(root, 'anon')).texts, []);
  assert.match(describe(join(root, 'a')).texts[0]!.text, /Apache License\s+Version 2\.0/);
  assert.equal(describe(join(root, 'a')).texts.length, 1);
  assert.deepEqual(describe(join(root, 'own')).texts, [{ file: 'LICENSE.md', text: 'Copyright (c) Own' }]);
});
