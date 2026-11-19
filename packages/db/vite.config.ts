/**
 * The ORM is bundled into `dist` so that starting a process does not resolve
 * hundreds of `drizzle-orm` modules; Node re-reads that package's 290 KB
 * package.json on every one of those resolutions.
 *
 * `dist` keeps its published shape: the entry points named by the
 * `exports` map stay at their paths, shared chunks stay directly under `dist`,
 * and `migrate` still reads `../drizzle/<kind>/` relative to its own file.
 * Workspace packages and Node builtins stay external.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { thirdPartyRecord } from '../../scripts/third-party-record.ts';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // The backend bundles this dist; its record carries drizzle-orm into the backend's record.
  plugins: [thirdPartyRecord().plugin],
  ssr: { noExternal: true, external: ['@alpacawork/core'], target: 'node' },
  build: {
    ssr: true,
    outDir: 'dist',
    emptyOutDir: false,
    target: 'node24',
    minify: false,
    lib: {
      entry: {
        index: 'src/index.ts',
        'host/schema': 'src/host/schema.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: (id: string) => id.startsWith('node:') || id.startsWith('@alpacawork/'),
      output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' },
    },
  },
});
