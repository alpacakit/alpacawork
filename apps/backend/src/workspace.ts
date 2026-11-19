/** One workspace selection policy for backend commands and first-install setup. Reads never initialize. */
import { closeSync, readSync, readdirSync, existsSync, openSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hasCode, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { META_DIRECTORY, WORKSPACE_MARKER } from '@alpacawork/raw';
import { controlDatabasePath } from '@alpacawork/db';
import { absolutePath } from './installation/files.js';
import { assertInstallationIdentity, type Installation } from './installation/store.js';

type WorkspaceState = { root: string; state: 'missing' | 'empty' | 'occupied' | 'legacy' | 'initialized' };

/** Recognize the current DB and the older marker. The DB Owner validates schema on open. */
export function inspectWorkspace(root: string): WorkspaceState {
  let names: string[];
  try { names = readdirSync(root); } catch (error) { if (hasCode(error, 'ENOENT')) return { root, state: 'missing' }; throw error; }
  if (!names.length) return { root, state: 'empty' };
  if (!names.includes(META_DIRECTORY)) return { root, state: 'occupied' };
  const database = controlDatabasePath(root);
  if (existsSync(database)) {
    const db = openSync(database, constants.O_RDONLY);
    try {
      const header = Buffer.alloc(16);
      if (readSync(db, header, 0, 16, 0) !== 16 || header.toString() !== 'SQLite format 3\0')
        throw new Problem(PROBLEM_CODE.invalidRoot, `Invalid workspace database: ${root}; files are unchanged. Diagnose it with ${workspaceCommand(root, "maintenance --mode inspect")}; do not reinitialize existing data`);
    } finally { closeSync(db); }
    return { root, state: 'initialized' };
  }
  if (existsSync(join(root, META_DIRECTORY, WORKSPACE_MARKER))) return { root, state: 'legacy' };
  throw new Problem(PROBLEM_CODE.invalidRoot, `Incomplete workspace: ${root}; files are unchanged. Inspect existing data with ${workspaceCommand(root, "maintenance --mode inspect")}. If first init was interrupted, stop serve and all agents, move this directory to an unused backup path and retry ${workspaceCommand(root, "init")}; see skills/alpacawork/references/troubleshoot.md#interrupted-init`);
}

function workspaceCommand(root: string, command: string): string {
  const quoted = "'" + root.replace(/'/g, "'\\''") + "'";
  return `alpacawork-backend --workspace ${quoted} workspace ${command}`;
}

function ancestors(cwd: string): string[] {
  const result: string[] = [];
  for (let directory = resolve(cwd); dirname(directory) !== directory; directory = dirname(directory)) {
    // Inspect metadata only; ordinary nonempty code directories are not workspaces.
    if (!existsSync(join(directory, META_DIRECTORY))) continue;
    if (['initialized', 'legacy'].includes(inspectWorkspace(directory).state)) result.push(directory);
  }
  return result;
}
function conflict(roots: string[]): never {
  throw new Problem(PROBLEM_CODE.conflict, `Different workspace candidates: ${roots.join(', ')}; select --workspace <path> explicitly`);
}
export function findWorkspace(cwd: string): string {
  const roots = ancestors(cwd);
  if (roots.length > 1) conflict(roots);
  if (roots[0]) return roots[0];
  throw new Problem(PROBLEM_CODE.invalidRoot, 'No initialized workspace found from cwd; specify --workspace <path>');
}
type WorkspaceSelection = { root: string; source: 'explicit' | 'installation' | 'ancestor' | 'default' };
export type WorkspaceRequest = {
  explicit?: string; cwd: string; env: Readonly<Record<string, string | undefined>>;
  record: Installation | null; intent: 'inspect' | 'existing' | 'initialize' | 'setup';
};

export function userHome(env: Readonly<Record<string, string | undefined>>): string {
  return absolutePath(env.HOME || homedir());
}
/** Where setup puts the data folder unless told otherwise. Uninstall never removes it, record or no record. */
export const defaultWorkspace = (home: string): string => join(home, 'alpacawork');
export function workspaceArgument(value: string, cwd: string, home: string): string {
  if (!value.trim()) throw new Problem(PROBLEM_CODE.invalidInput, 'Workspace path cannot be empty');
  if (/^[a-z]:|^\/\//i.test(value)) throw new Problem(PROBLEM_CODE.unsafePath, 'Windows drive and UNC workspace paths are outside the target');
  return absolutePath(resolve(cwd, value === '~' ? home : value.startsWith('~/') ? home + value.slice(1) : value));
}

/** Placement must preserve the create-only workspace initializer's empty-directory premise. */
export function validateSetupLocations(workspace: string, releases: string, existing: boolean): void {
  const child = relative(workspace, releases);
  if (!existing && (child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)))
    throw new Problem(PROBLEM_CODE.invalidInput,
      `Releases ${releases} would occupy the new workspace ${workspace} before initialization. Choose a separate releases folder outside the new workspace, then run setup again`);
}
const SETUP_PATH_ADVICE = 'Choose an empty folder or an initialized workspace with --workspace <path>, then run alpacawork setup again';

export function selectWorkspace(request: WorkspaceRequest): WorkspaceSelection {
  const { record, cwd, env, intent } = request;
  const home = record?.home ?? userHome(env);
  const explicit = request.explicit === undefined ? undefined : workspaceArgument(request.explicit, cwd, home);
  if (record) {
    if (intent !== 'inspect') assertInstallationIdentity(record);
    if (explicit !== undefined && explicit !== record.workspace)
      throw new Problem(PROBLEM_CODE.conflict, `Explicit workspace ${explicit} differs from the installation record ${record.workspace}. The data folder of an installation cannot be changed; use the recorded path or omit --workspace`);
  }
  // An explicit selection disambiguates discovery, but never changes a registered server.
  if (explicit !== undefined) {
    // Inspection/maintenance must reach damaged or historical databases through their own Owner.
    // In particular, do not put a current-schema/SQLite gate in front of release recovery.
    if (intent === 'inspect') {
      return { root: explicit, source: 'explicit' };
    }
    const selected = inspectWorkspace(explicit);
    if (intent === 'setup' && !['initialized', 'missing', 'empty'].includes(selected.state))
      throw new Problem(PROBLEM_CODE.invalidRoot, `Workspace is ${selected.state}: ${explicit}. ${SETUP_PATH_ADVICE}`);
    if (intent === 'existing' && selected.state !== 'initialized')
      throw new Problem(PROBLEM_CODE.invalidRoot, `No initialized workspace at ${explicit}; for a new workspace use alpacawork-backend --workspace <empty-path> workspace init. Existing files are unchanged`);
    if (intent === 'initialize' && !['empty', 'missing'].includes(selected.state))
      throw new Problem(PROBLEM_CODE.invalidRoot, `Workspace initialization requires an empty directory: ${explicit}; existing files are unchanged. To use initialized data, run ${workspaceCommand(explicit, "serve")}; otherwise inspect the data before continuing`);
    return { root: explicit, source: 'explicit' };
  }
  const fallback = defaultWorkspace(home);
  const defaultState = inspectWorkspace(fallback);
  const roots = [...new Set([...(record ? [record.workspace] : []), ...ancestors(cwd),
    ...(['initialized', 'legacy'].includes(defaultState.state) ? [fallback] : [])])];
  if (roots.length > 1) conflict(roots);
  if (record) {
    if ((intent === 'existing' || intent === 'setup') && inspectWorkspace(record.workspace).state !== 'initialized')
      throw new Problem(PROBLEM_CODE.invalidRoot, `Recorded workspace is not initialized: ${record.workspace}; stop serve and see skills/alpacawork/references/troubleshoot.md#installation-record`);
    return { root: record.workspace, source: 'installation' };
  }
  // An unrelated non-workspace directory is not evidence against a registered root.
  if (defaultState.state === 'occupied')
    throw new Problem(PROBLEM_CODE.conflict, `Default workspace path is not empty: ${fallback}; existing files are unchanged. ${intent === 'setup' ? SETUP_PATH_ADVICE : 'For a new workspace, use alpacawork-backend --workspace <empty-path> workspace init'}`);
  if (intent === 'initialize') {
    if (roots.length)
      throw new Problem(PROBLEM_CODE.conflict, `Existing data found: ${roots.join(', ') || fallback}; to use initialized data, run ${workspaceCommand(roots[0]!, "serve")}. For a new workspace, use alpacawork-backend --workspace <empty-path> workspace init`);
    return { root: fallback, source: 'default' };
  }
  if (roots[0]) {
    // The default without a record is evidence to select, not proof of this installation.
    if (roots[0] === fallback && intent !== 'setup')
      throw new Problem(PROBLEM_CODE.conflict, `Unregistered workspace found at ${fallback}; select --workspace explicitly`);
    if ((intent === 'existing' || intent === 'setup') && inspectWorkspace(roots[0]).state !== 'initialized')
      throw new Problem(PROBLEM_CODE.invalidRoot, `No initialized workspace database at ${roots[0]}; use explicit maintenance to inspect it`);
    return { root: roots[0], source: 'ancestor' };
  }
  if (intent === 'setup') return { root: fallback, source: 'default' };
  throw new Problem(PROBLEM_CODE.invalidRoot, 'No initialized workspace or installation record found; use workspace init for a new workspace, or specify --workspace <path>');
}
