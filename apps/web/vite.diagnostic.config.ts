import { releaseName } from '../backend/src/release/edition.ts';
import { webConfig } from './vite.config.ts';
import { defineConfig, mergeConfig } from 'vite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = existsSync(root + 'SOURCE') ? readFileSync(root + 'SOURCE', 'utf8').trim()
  : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Diagnostic build needs a commit SHA');
/** The diagnostic edition is the product's build with this one difference: its hook, its entry, its entry's name. */
export default defineConfig(mergeConfig(webConfig(), {
  define: { __PERFORMANCE_BUILD__: JSON.stringify(releaseName(sha, 'diagnostic')) },
  plugins: [{ name: 'diagnostic-entry', transformIndexHtml: { order: 'pre' as const,
    handler(html: string, context: { filename: string }) { return context.filename.endsWith('/index.html') ? html.replace('/src/main.tsx', '/dev/diagnostic-bootstrap.ts') : html; } },
    closeBundle() {
      // main is required at startup even though evaluation waits for the hook. Optional renderers remain lazy.
      const file = fileURLToPath(new URL('../backend/public/asset-manifest.json', import.meta.url));
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (!manifest['index.html']?.dynamicImports?.includes('src/main.tsx')) throw new Error('Diagnostic bootstrap lost its application dependency');
      manifest['index.html'].startup = ['src/main.tsx'];
      writeFileSync(file, JSON.stringify(manifest, null, 2));
    } }],
  build: { rolldownOptions: { output: { entryFileNames: (chunk: { name: string }) => `assets/${chunk.name === 'app' ? 'diagnostic' : '[name]'}-[hash].js` } } },
}));
