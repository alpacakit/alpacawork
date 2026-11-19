import { writeFileSync, mkdirSync, cpSync, copyFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
/** Model-free synthetic bridge: never starts the installed SDK or reads provider credentials. It answers a version and
 * reports "signed out" for every check; valid both as CommonJS and as a module. */
const SYNTHETIC_BRIDGE = "if(process.argv.at(-1)==='--version')console.log('synthetic bundled 1');else process.exit(1);\n";
export function syntheticStatusBridge(root: string): string[] {
  const file = join(root, 'status-bridge.cjs');
  writeFileSync(file, SYNTHETIC_BRIDGE);
  return [process.execPath, file];
}

/** A copy of the app started in its own process cannot be handed a bridge, so its bridge entry is the synthetic one.
 * Only bundled-runtime checks start that entry in these setups; no Run is launched through it. */
export function stubBundledStatus(root: string): void {
  writeFileSync(join(root, 'apps/agent-cli/dist/cli.js'), SYNTHETIC_BRIDGE);
}

/** A private backend/bridge pair for tests that exercise initialization through the real CLI. */
export function syntheticStatusApp(repo: string, root: string): string {
  mkdirSync(root, { recursive: true });
  for (const app of ['backend', 'agent-cli']) {
    const directory = join(root, 'apps', app); mkdirSync(directory, { recursive: true });
    cpSync(join(repo, 'apps', app, 'dist'), join(directory, 'dist'), { recursive: true });
    copyFileSync(join(repo, 'apps', app, 'package.json'), join(directory, 'package.json'));
    symlinkSync(join(repo, 'apps', app, 'node_modules'), join(directory, 'node_modules'));
  }
  for (const file of ['package.json', 'pnpm-workspace.yaml']) copyFileSync(join(repo, file), join(root, file));
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
  stubBundledStatus(root);
  return join(root, 'apps/backend/dist/backend.js');
}
