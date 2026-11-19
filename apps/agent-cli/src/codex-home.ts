/** Owns the default Codex storage boundary. Explicit CODEX_HOME belongs to the caller. */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

type CodexHome = { source: string; target: string };
const guidance = 'Set CODEX_HOME to an independently configured dedicated Codex home to use other authentication or storage settings.';
const stateEntry = (name: string) => /^(?:sessions|archived_sessions|history\.jsonl|session_index\.jsonl|shell_snapshots|log|cache|memories|\.tmp|app-server-.*)$/.test(name)
  || /\.sqlite(?:-|$)/.test(name);

export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): CodexHome | null {
  if (env.CODEX_HOME !== undefined) {
    if (!env.CODEX_HOME.trim()) throw new Error('CODEX_HOME must not be empty');
    return null;
  }
  const source = join(home, '.codex'), target = join(home, '.codex-alpacawork');
  if (!existsSync(join(source, 'auth.json'))) throw new Error(`Default Codex isolation requires ~/.codex/auth.json. ${guidance}`);
  return { source, target };
}

function inputPaths(config: any): string[] {
  const paths: string[] = [];
  const collect = (value: any) => {
    for (const key of ['model_instructions_file', 'experimental_compact_prompt_file', 'model_catalog_json']) {
      if (typeof value?.[key] === 'string') paths.push(value[key]);
    }
    for (const agent of Object.values(value?.agents ?? {}) as any[]) {
      if (typeof agent?.config_file === 'string') paths.push(agent.config_file);
    }
    for (const skill of value?.skills?.config ?? []) {
      if (typeof skill?.path === 'string') paths.push(skill.path);
    }
  };
  collect(config);
  for (const profile of Object.values(config?.profiles ?? {})) collect(profile);
  return paths;
}

export function prepareCodexHome(home: CodexHome, config: any): void {
  const store = config.cli_auth_credentials_store;
  if (store != null && store !== 'file') throw new Error(`Automatic Codex isolation supports file authentication only. ${guidance}`);
  if (existsSync(home.target) && (!lstatSync(home.target).isDirectory() || lstatSync(home.target).isSymbolicLink())) {
    throw new Error(`Dedicated Codex home must be a directory, not a link. ${guidance}`);
  }
  mkdirSync(home.target, { recursive: true, mode: 0o700 });
  // Never reuse a directory whose session/state entries link back into another home.
  for (const name of readdirSync(home.target)) {
    if (stateEntry(name) && lstatSync(join(home.target, name)).isSymbolicLink()) {
      throw new Error(`Dedicated Codex state must not be a symbolic link. ${guidance}`);
    }
  }
  const inputs = new Set(['auth.json', 'config.toml', '.env', 'AGENTS.md', 'AGENTS.override.md', 'skills', 'rules', 'agents', 'plugins', 'hooks.json']);
  for (const path of inputPaths(config)) {
    const absolute = isAbsolute(path) ? path : resolve(home.source, path);
    const local = relative(home.source, absolute);
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) continue;
    const root = local.split(sep)[0]!;
    if (stateEntry(root)) throw new Error(`Codex configuration references session/state storage as an input. ${guidance}`);
    inputs.add(root);
  }
  for (const name of readdirSync(home.source)) if (name.endsWith('.config.toml')) inputs.add(name);
  for (const name of inputs) {
    const source = join(home.source, name), target = join(home.target, name);
    // Links also follow later creation/replacement of optional source inputs.
    try { symlinkSync(source, target, existsSync(source) && lstatSync(source).isDirectory() ? 'dir' : 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !lstatSync(target).isSymbolicLink()
        || resolve(dirname(target), readlinkSync(target)) !== source) {
        throw new Error(`Dedicated Codex input conflicts with the shared configuration. ${guidance}`, { cause: error });
      }
    }
  }
}

/** Preserve the requested pre-isolation conversation in place; never move or copy its rollout. */
export function originalCodexThread(home: CodexHome, id: string): string | null {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) return null;
  const sessions = join(home.source, 'sessions');
  if (!existsSync(sessions)) return null;
  const suffix = `-${id}.jsonl`;
  const matches = readdirSync(sessions, { recursive: true }).map(String)
    .filter(path => path.endsWith(suffix) || path.endsWith(`${suffix}.zst`));
  if (matches.length > 1) throw new Error('Multiple original Codex rollouts match the requested thread; select its CODEX_HOME explicitly');
  return matches.length ? join(sessions, matches[0]!) : null;
}
