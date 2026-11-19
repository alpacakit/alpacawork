import { defineConfig } from 'vite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nodeAppBuild } from '../../scripts/node-app-build.ts';
import { releaseName } from './src/release/edition.ts';
import { BACKEND_ENTRIES } from './src/app-paths.ts';

export default defineConfig(({ mode }) => {
  const config = nodeAppBuild(new URL('.', import.meta.url),
    Object.fromEntries(Object.entries(BACKEND_ENTRIES).map(([name, source]) => [name, 'src/' + source + '.ts'])));
  config.build!.rollupOptions!.output = {
    entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js',
    banner: '#!/usr/bin/env node',
  };
  config.plugins!.push({
    name: 'backend-database-assets',
    generateBundle() {
      const assets = new URL('../../packages/db/', import.meta.url);
      const copy = (path: string) => {
        for (const entry of readdirSync(new URL(path + '/', assets), { withFileTypes: true })) {
          const file = path + '/' + entry.name;
          if (entry.isDirectory()) copy(file);
          else if (entry.isFile()) this.emitFile({ type: 'asset', fileName: 'assets/db/' + file, source: readFileSync(new URL(file, assets)) });
        }
      };
      copy('drizzle');
    },
  });
  if (mode === 'diagnostic') {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const sha = existsSync(root + 'SOURCE') ? readFileSync(root + 'SOURCE', 'utf8').trim()
      : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Diagnostic build needs a commit SHA');
    config.define = { __DIAGNOSTIC_RELEASE__: JSON.stringify(releaseName(sha, 'diagnostic')) };
    config.plugins!.push({
      name: 'backend-diagnostic-edition',
      // Select the edition before Vite resolves the .js import to its .ts source.
      enforce: 'pre',
      resolveId(source, importer) {
        if (source === '../edition.js' && importer?.endsWith('/src/receiver/server.ts'))
          return fileURLToPath(new URL('./src/edition.diagnostic.ts', import.meta.url));
      },
    });
  }
  return config;
});
