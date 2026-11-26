import { requireRuntimeAdapter } from '../agents/registry.js';
import { pathToFileURL } from 'node:url';
import { appRoot } from '../app-paths.js';
import { SKILL_INVOCATIONS } from './skill-invocations.js';
/** Read-only local skill catalogs. No CLI startup, plugin initialization, network, or TTL success cache. */
import { join, resolve } from 'node:path';
import { Files, CatalogUnavailable, type CatalogReason } from './skill-catalog/files.js';
import { claudeDefinitions, codexDefinitions, type Definition } from './skill-catalog/definitions.js';
import { projectRoots, type CatalogInput } from './skill-catalog/context.js';
import { claudeSettings, codexSettings, jsonSettings } from './skill-catalog/settings.js';
import { coordinatorCwd } from '../runs/execution-control.js';
/** A skill is its name for this agent: the name is what a message carries, and the CLI resolves it when the turn runs. */
type CatalogSkill = { name: string; description: string; invocation: '/' | '$' };
type Catalog = { status: 'ready'; profile: string; skills: CatalogSkill[] } |
  { status: 'unavailable'; profile: string; skills: []; reason: CatalogReason };

/**
 * What a coordinator turn finds from the folder it runs in. `adapter`, `argv`, `env` and `session` are the admitted
 * launch's, never inferred from a profile name or binary: the adapter alone decides which flags leave discovery unchanged.
 */
export async function coordinatorSkills(input: CatalogInput & { adapter: string }): Promise<Catalog> {
  const { profile } = input, cwd = coordinatorCwd(input.root);
  try {
    const { kind, env, session } = requireRuntimeAdapter(input.adapter).skillCatalogContext(input), home = env.HOME;
    if (!home || !home.startsWith('/')) throw new CatalogUnavailable('launch');
    const files = new Files();
    // Before the first turn makes the empty folder, discovery from where it will be is the same.
    if (await files.kind(cwd) === 'file') throw new CatalogUnavailable('unreadable');
    const roots = await projectRoots(files, cwd);
    const definitions: Definition[] = [];
    // Codex lists distinct definitions of one name, which a $name mention cannot tell apart: that name is not offered.
    const ambiguous = new Set<string>();
    if (kind === 'claude') {
      const config = resolve(cwd, env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
      for (const path of ['/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-settings.d', join(config, 'managed-settings.json')]) if (await files.kind(path)) throw new CatalogUnavailable('managed');
      for (const folder of [config, ...roots.chain.map(path => join(path, '.claude')), ...(roots.main ? [join(roots.main, '.claude')] : [])])
        for (const name of ['settings.json', 'settings.local.json']) claudeSettings(await jsonSettings(files, join(folder, name)));
      const add = async (folder: string, source: string) => {
        // First wins: the CLI gives personal definitions precedence over project definitions.
        for (const command of [false, true]) for (const definition of await claudeDefinitions(files, join(folder, command ? 'commands' : 'skills'), command, source)) {
          if (!definitions.some(item => item.name === definition.name)) definitions.push(definition);
        }
      };
      await add(config, 'personal');
      for (const folder of roots.chain) await add(join(folder, '.claude'), folder);
      if (roots.main) {
        for (const command of [false, true]) {
          const name = command ? 'commands' : 'skills';
          if (!await files.kind(join(roots.chain.at(-1)!, '.claude', name)))
            for (const definition of await claudeDefinitions(files, join(roots.main, '.claude', name), command, roots.main))
              if (!definitions.some(item => item.name === definition.name)) definitions.push(definition);
        }
      }
    } else {
      // Reuse the agent runtime's owner, including the original-thread exception. Never call prepareCodexHome.
      const owner = await import(pathToFileURL(join(appRoot(import.meta.url), 'apps/agent-cli/dist/codex-home.js')).href) as {
        defaultCodexHome(env: NodeJS.ProcessEnv, home: string): { source: string; target: string } | null;
        originalCodexThread(home: { source: string; target: string }, id: string): string | null;
      };
      const isolated = owner.defaultCodexHome(env, home);
      const config = isolated ? session && owner.originalCodexThread(isolated, session) ? isolated.source : isolated.target : resolve(cwd, env.CODEX_HOME!);
      for (const path of ['/etc/codex/managed_config.toml', '/etc/codex/requirements.toml', '/etc/codex/skills']) if (await files.kind(path)) throw new CatalogUnavailable('managed');
      const globalConfig = join(config, 'config.toml');
      const canonicalConfig = await files.kind(globalConfig) ? await files.canonical(globalConfig) : null;
      for (const folder of roots.chain) {
        const projectConfig = join(folder, '.codex', 'config.toml');
        // Outside a repository the ancestor chain can include HOME: its global file is not another project layer.
        if (await files.kind(projectConfig) && await files.canonical(projectConfig) !== canonicalConfig) throw new CatalogUnavailable('settings');
      }
      const disabled = await codexSettings(files, join(config, 'config.toml'));
      if (!await files.kind(join(config, 'skills', '.system', '.codex-system-skills.marker'))) throw new CatalogUnavailable('system');
      await files.text(join(config, 'skills', '.system', '.codex-system-skills.marker'));
      const locations = [...roots.chain.map(folder => join(folder, '.agents', 'skills')), join(config, 'skills'), join(home, '.agents', 'skills')];
      for (const location of locations) for (const definition of await codexDefinitions(files, location, location)) {
        if (!definition.invocable || disabled.has(definition.path)) continue;
        // Symlink aliases of one skill are one definition. Distinct same-name definitions cannot be routed unambiguously by $name.
        if (definitions.some(item => item.path === definition.path)) continue;
        if (definitions.some(item => item.name === definition.name)) ambiguous.add(definition.name);
        else definitions.push(definition);
      }
    }
    return { status: 'ready', profile,
      skills: definitions.filter(definition => definition.invocable && !ambiguous.has(definition.name)).sort((a, b) => a.name.localeCompare(b.name, 'en')).map(definition => ({
        name: definition.name, description: definition.description, invocation: SKILL_INVOCATIONS[kind],
      })) };
  } catch (error) {
    return { status: 'unavailable', profile, skills: [], reason: error instanceof CatalogUnavailable ? error.reason : 'unreadable' };
  }
}
