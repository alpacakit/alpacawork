/** Independent synthetic releases with exact built entry bytes and installed Node. No provider. */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { protocolFingerprint } from '@alpacawork/contract/run-protocol';
import { copyTree } from '@alpacawork/backend/test-dist/release/package-files.js';
import { readManifest, matchesTarget, type PackageTarget } from '@alpacawork/backend/test-dist/release/package-closure.js';
function resolveDependency(from: string, name: string, repo: string): string | null {
  for (let dir = from;; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dir === repo || dir === dirname(dir)) return null;
  }
}
export function releaseFixture(root: string, source = 'a'.repeat(40)) {
  const repo = resolve('.'), built = process.env.ALPACAWORK_TEST_BUILT_ROOT ?? repo;
  const image = join(root, 'releases', source), node = process.execPath;
  mkdirSync(image, { recursive: true });
  const target: PackageTarget = process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64-glibc';
  const installed = new Map<string, string>();
  function install(name: string, from: string): void {
    const origin = resolveDependency(from, name, repo);
    if (!origin) throw new Error(`Missing fixture dependency ${name}`);
    const pkg = readManifest(origin), previous = installed.get(name);
    if (previous) { if (previous !== pkg.version) throw new Error(`Conflicting fixture dependency ${name}`); return; }
    installed.set(name, pkg.version);
    const dest = join(image, 'node_modules', name); mkdirSync(dest, { recursive: true });
    const workspace = origin.startsWith(join(repo, 'packages') + '/');
    if (workspace) {
      copyTree(join(built, 'packages', name.split('/')[1]!, 'dist'), join(dest, 'dist'));
      if (existsSync(join(origin, 'drizzle'))) copyTree(join(origin, 'drizzle'), join(dest, 'drizzle'));
    } else {
      for (const file of readdirSync(origin)) if (!['node_modules', 'package.json'].includes(file)) cpSync(join(origin, file), join(dest, file), { recursive: true });
    }
    writeFileSync(join(dest, 'package.json'), JSON.stringify(pkg));
    for (const dep of Object.keys(pkg.dependencies ?? {})) install(dep, origin);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      const child = resolveDependency(origin, dep, repo);
      if (child && matchesTarget(readManifest(child), target)) install(dep, origin);
    }
  }
  for (const app of ['cli', 'agent-cli', 'backend']) {
    copyTree(join(built, 'apps', app, 'dist'), join(image, 'apps', app, 'dist'));
    const from = join(repo, 'apps', app);
    for (const name of Object.keys(readManifest(from).dependencies ?? {})) install(name, from);
  }
  // Only this synthetic internal-library fixture includes tsc modules; production assembly never copies them.
  copyTree(join(built, 'apps/backend/test-dist'), join(image, 'apps/backend/test-dist'));
  for (const file of ['app-root.mjs', 'runtime-roots.mjs']) { mkdirSync(join(image, 'scripts'), { recursive: true }); copyTree(join(repo, 'scripts', file), join(image, 'scripts', file)); }
  copyTree(join(repo, 'apps/launcher'), join(image, 'bin'));
  for (const bin of ['alpacawork.mjs', 'backend.mjs', 'agent.mjs']) chmodSync(join(image, 'bin', bin), 0o755);
  const format = protocolFingerprint();
  writeFileSync(join(image, 'package.json'), JSON.stringify({ name: 'alpacawork', version: '0.3.0', type: 'module',
    alpacawork: { source, format, targets: [target] } }));
  writeFileSync(join(image, 'SOURCE'), source); writeFileSync(join(image, 'FORMAT'), format);
  const web = join(image, 'apps/backend/public'); mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<script type="module" src="/assets/app.js"></script>');
  writeFileSync(join(web, 'assets/app.js'), '// synthetic web fixture');
  writeFileSync(join(web, 'assets/mermaid.js'), '// synthetic mermaid fixture');
  writeFileSync(join(web, 'asset-manifest.json'), JSON.stringify({ 'index.html': { file: 'assets/app.js' }, 'mermaid-frame.html': { file: 'assets/mermaid.js' } }));
  writeFileSync(join(image, 'SCHEMA.json'), execFileSync(node, [join(image, 'apps/backend/dist/schema-manifest.js')]));
  return { image, node, cli: join(image, 'apps/cli/dist/cli.js'), manager: join(image, 'apps/backend/dist/run-manager.js') };
}
