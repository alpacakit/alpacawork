import { defineConfig, mergeConfig } from 'vite';
import { nodeAppBuild } from '../../scripts/node-app-build.ts';

export default defineConfig(mergeConfig(nodeAppBuild(new URL('.', import.meta.url), { cli: 'src/cli-entry.ts' }), {
  build: {
    rollupOptions: {
      output: {
        // Preserve direct shell execution and Run CLI redirection as well as `node cli.js`.
        banner: '#!/bin/sh\n//usr/bin/true; if [ -n "$ALPACAWORK_RUN_CLI" ] && [ "$ALPACAWORK_RUN_CLI" != "$0" ]; then exec "$ALPACAWORK_RUN_CLI" "$@"; fi; exec node "$0" "$@"',
      },
    },
  },
}));
