import { defineConfig } from 'vite';
import { nodeAppBuild } from '../../scripts/node-app-build.ts';

export default defineConfig(nodeAppBuild(new URL('.', import.meta.url), {
  cli: 'src/cli.ts',
  'codex-home': 'src/codex-home.ts',
}));
