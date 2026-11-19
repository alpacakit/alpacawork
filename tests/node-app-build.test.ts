import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { appRoot } from '../scripts/app-root.mjs';
import { nodeAppBuild } from '../scripts/node-app-build.ts';

test('application root survives nested bundle chunks and test outputs after relocation', () => {
  const root = join(tmpdir(), 'relocated application');
  for (const app of ['backend', 'cli']) for (const output of ['dist', 'test-dist'])
    for (const file of ['cli.js', 'chunks/shared.js', 'receiver/chunks/worker.js'])
      assert.equal(appRoot(pathToFileURL(join(root, 'apps', app, output, file))), root);
  assert.throws(() => appRoot(pathToFileURL(join(root, 'packages/core/dist/index.js'))), /application output path/);
});

test('Node bundles keep internal code and shared JS dependencies inside, stopping at native roots', () => {
  const config = nodeAppBuild(new URL('../apps/backend/', import.meta.url), { backend: 'src/backend-entry.ts' });
  const external = config.build!.rollupOptions!.external as (id: string) => boolean;
  for (const id of ['@alpacawork/core', '@alpacawork/db', '@alpacawork/contract/run', '@alpacawork/raw', 'zod', 'drizzle-orm'])
    assert.equal(external(id), false, id);
  for (const id of ['node:fs', 'koffi', 'koffi/subpath', '@github/copilot-sdk']) assert.equal(external(id), true, id);
});
