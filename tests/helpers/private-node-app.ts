/** A writable copy of emitted app code; dependencies remain the checkout's read-only test inputs. */
import { copyFileSync, cpSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { scratch } from './managed-skills-fixture.ts';

export function privateNodeApp(t: TestContext, name: 'cli' | 'agent-cli') {
  const repo = resolve(import.meta.dirname, '../..'), root = scratch(t, `alpacawork-${name}-edited-`);
  const app = join(root, 'apps', name), dist = join(app, 'dist');
  mkdirSync(app, { recursive: true });
  for (const file of ['package.json', 'pnpm-workspace.yaml']) copyFileSync(join(repo, file), join(root, file));
  copyFileSync(join(repo, 'apps', name, 'package.json'), join(app, 'package.json'));
  cpSync(join(repo, 'apps', name, 'dist'), dist, { recursive: true });
  symlinkSync(join(repo, 'apps', name, 'node_modules'), join(app, 'node_modules'), 'dir');
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  return { root, dist, entry: join(dist, 'cli.js') };
}
