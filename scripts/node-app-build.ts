/** Common Node24 ESM build; app configurations own only their actual entries. */
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vite';
import { runtimeExternalPackages } from './runtime-externals.ts';
import { thirdPartyRecord } from './third-party-record.ts';

export function nodeAppBuild(app: URL, entry: Record<string, string>): UserConfig {
  const root = fileURLToPath(app);
  const external = runtimeExternalPackages();
  return {
    root,
    publicDir: false,
    plugins: [thirdPartyRecord().plugin],
    ssr: { noExternal: true, external: [...external], target: 'node' },
    build: {
      ssr: true,
      outDir: 'dist',
      emptyOutDir: true,
      target: 'node24',
      minify: false,
      lib: { entry, formats: ['es'] },
      rollupOptions: {
        external: id => isBuiltin(id) || [...external].some(name => id === name || id.startsWith(name + '/')),
        output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
      },
    },
  };
}
