import type { InspectionEnvironment } from '../agents/availability.js';
import { inspectSetupAgents, type DetectedSetupAgent } from './setup-ai.js';
import { managedSkillsRoot } from '@alpacawork/core/installed-skills';
import { backendEntry } from '../app-paths.js';
/** Installation sequence: resolve once, initialize, then publish facts. No service operations. */
import { createServer } from 'node:net';
import { realpathSync, statfsSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { Problem, PROBLEM_CODE, validateService, type ServiceDefinition } from '@alpacawork/core';
import { initializeWorkspace } from '../control/initialize.js';
import { selectWorkspace, userHome, type WorkspaceRequest } from '../workspace.js';
import { dirname, join } from 'node:path';
import { PUBLIC_HOST_PATTERN } from '@alpacawork/contract/inputs';
import { absolutePath, assertProductDirectory } from './files.js';
import { InstallationStore, installationPath, assertInstallationIdentity, workspaceIdentity as readWorkspaceIdentity, installationVersion, type Installation, type InstallationFacts } from './store.js';

/** What setup uses when the person names nothing else. Uninstall looks for the same when no record says otherwise. */
export const DEFAULT_SERVICE_NAME = 'alpacawork.service';
export const defaultReleases = (home: string): string => join(home, '.local/share/alpacawork/releases');
/** sudo keeps the person's HOME while reaching root's service manager and leaving root-owned files in that HOME. */
export const underSudo = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env.SUDO_USER !== undefined || env.SUDO_UID !== undefined;

type InstallationHost = { platform: string; wsl: boolean; filesystem: (path: string) => number; root?: boolean };
function installationHost(env: Readonly<Record<string, string | undefined>>): InstallationHost {
  return { platform: process.platform, wsl: process.platform === 'linux' && (/microsoft/i.test(osRelease()) || !!env.WSL_DISTRO_NAME),
    filesystem: path => statfsSync(path).type, root: process.platform === 'linux' && process.geteuid?.() === 0 };
}
export function validateNewWorkspace(root: string, env: Readonly<Record<string, string | undefined>>, host = installationHost(env)): void {
  if (!['linux', 'darwin'].includes(host.platform)) throw new Problem(PROBLEM_CODE.unsupportedPlatform, 'New installations require Linux, macOS, or WSL2', undefined,
    { reason: { kind: 'installation_platform_unsupported' } });
  // The server refuses to start as root on Linux; say so here, before anything is written.
  if (host.root) throw new Problem(PROBLEM_CODE.unsafePath, 'alpacawork does not run as root. Log in as an ordinary user and run this again as that user. Nothing was changed.');
  if (underSudo(env))
    throw new Problem(PROBLEM_CODE.unsafePath, 'Initialize as the intended user without sudo', undefined,
      { reason: { kind: 'installation_sudo_refused' } });
  if (host.wsl) {
    // DrvFS/9p, NTFS, FAT/exFAT, CIFS/SMB and FUSE Windows mounts are outside the initial target.
    if (/^\/mnt\/[a-z](?:\/|$)/i.test(root) || /^\/{2}|^[a-z]:/i.test(root))
      throw new Problem(PROBLEM_CODE.unsafePath, 'WSL2 workspace must use the Linux user HOME/filesystem', undefined,
        { reason: { kind: 'installation_wsl_filesystem_refused' } });
    let parent = root;
    for (;;) {
      if (existsSync(parent)) { statSync(parent); break; }
      parent = parent.slice(0, parent.lastIndexOf('/')) || '/';
      if (parent === '/') throw new Problem(PROBLEM_CODE.unsafePath, 'Cannot determine WSL2 workspace filesystem', undefined,
        { reason: { kind: 'installation_wsl_filesystem_unknown' } });
    }
    if ([0x01021997, 0x5346544e, 0x4d44, 0x2011bab0, 0xff534d42, 0xfe534d42, 0x65735546].includes(host.filesystem(parent) >>> 0))
      throw new Problem(PROBLEM_CODE.unsafePath, 'WSL2 workspace filesystem is outside the Linux filesystem target', undefined,
        { reason: { kind: 'installation_wsl_filesystem_refused' } });
  }
}
function facts(request: Pick<WorkspaceRequest, 'env'>): InstallationFacts {
  const home = userHome(request.env);
  if (!existsSync(home)) throw new Problem(PROBLEM_CODE.invalidInput, `User HOME does not exist: ${home}`, undefined,
    { reason: { kind: 'installation_home_missing', path: home } });
  return { home, uid: process.getuid!(), nodeExecutable: absolutePath(realpathSync(process.execPath)), releases: null };
}

/** Shared with future complete setup. Success means a workspace, never a registered service. */
export async function initializeInstallation(request: Omit<WorkspaceRequest, 'record' | 'intent'> & { language?: string; agentEnvironment?: InspectionEnvironment; detectedAgents?: readonly DetectedSetupAgent[] },
  store = new InstallationStore(installationPath(request.env)), host = installationHost(request.env)) {
  // Check the user/config filesystem before the installation lock creates any directories.
  validateNewWorkspace(userHome(request.env), request.env, host);
  validateNewWorkspace(store.path, request.env, host);
  // The installation lock creates its missing parents, HOME among them, so HOME is checked before it.
  const environment = facts(request); assertProductDirectory(dirname(store.path), environment.home);
  return store.locked(async (record, publish) => {
    const selected = selectWorkspace({ ...request, record, intent: 'initialize' });
    // init remains create-only even for a registered installation.
    if (record) throw new Problem(PROBLEM_CODE.alreadyInitialized, `Workspace already initialized: ${selected.root}; use workspace serve to start it`, undefined,
      { reason: { kind: 'workspace_already_initialized', path: selected.root } });
    validateNewWorkspace(selected.root, request.env, host);
    const { workspaceIdentity, ...initialized } = await initializeWorkspace(selected.root, request.detectedAgents ?? await inspectSetupAgents(request.agentEnvironment ?? request), { language: request.language });
    const installation: Installation = { version: installationVersion, ...environment,
      workspace: selected.root, workspaceIdentity, service: null };
    publish(installation);
    return { ...initialized, installation: { path: store.path, workspace: selected.root, source: selected.source } };
  });
}

/** Publish management facts for an existing workspace after reading its DB identity. */
export async function registerInstallation(request: Omit<WorkspaceRequest, 'record' | 'intent'>,
  releasesInput: string, store = new InstallationStore(installationPath(request.env))) {
  const environment = facts(request), releases = absolutePath(realpathSync(releasesInput));
  assertProductDirectory(dirname(store.path), environment.home); assertProductDirectory(releases, environment.home);
  return store.locked(async (record, publish) => {
    const selected = selectWorkspace({ ...request, record, intent: 'existing' });
    const workspaceIdentity = readWorkspaceIdentity(selected.root);
    if (record && (record.home !== environment.home ||
        record.releases !== null && record.releases !== releases)) throw new Error('Installation management facts differ; retained');
    assertProductDirectory(releases, environment.home); mkdirSync(releases, { recursive: true, mode: 0o700 });
    // The recorded Node path changes only with the service definition that names it (recordInstallationService).
    const installation: Installation = { version: installationVersion, ...environment, nodeExecutable: record?.nodeExecutable ?? environment.nodeExecutable,
      releases, workspace: selected.root, workspaceIdentity,
      service: record?.service ?? null };
    publish(installation);
    return installation;
  });
}

/** Derive the native service input from the one installation record and its normal config selection. */
export function installationService(releases: string, workspace: string, name: string,
  env: Readonly<Record<string, string | undefined>> = process.env): ServiceDefinition {
  const { definition } = readInstallationService({ releases, workspace, env, name });
  return definition;
}

/** Read-only: the definition this terminal would approve, by the same rules as managed startup. A recorded service
 * keeps its name, and its port and public host unless the caller names others; Node and PATH are this terminal's.
 * A result that differs from the recorded definition is a change only setup's re-approval may confirm. */
export async function inspectInstallationService(releases: string, workspace: string,
  env: Readonly<Record<string, string | undefined>> = process.env, name?: string, options: {port?: number; publicHost?: string; mcp?: boolean} = {}): Promise<ServiceDefinition> {
  const environment = facts({ env }), store = new InstallationStore(installationPath(env)), record = store.read();
  if (record && (record.workspace !== workspace || record.home !== environment.home ||
      record.releases !== null && record.releases !== releases)) throw new Error('Installation management facts differ; retained');
  const saved = record?.service ?? null;
  if (saved && name !== undefined && name !== saved.name) throw new Error('Requested service differs from the recorded service; retained');
  const port = options.port ?? saved?.port ?? await probeServicePort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Service port must be 1..65535');
  const publicHost = options.publicHost ?? saved?.publicHost ?? undefined;
  if (publicHost !== undefined && !PUBLIC_HOST_PATTERN.test(publicHost)) throw new Error('public-host must be host[:port] in lower case');
  const mcp = options.mcp ?? saved?.mcp ?? false;
  return serviceDefinition({ ...environment, releases, workspace, service: { name: saved?.name ?? name ?? DEFAULT_SERVICE_NAME, port,
    publicHost: publicHost ?? null, environmentPath: servicePath(env), ...(mcp ? { mcp: true } : {}) } }, store.path);
}

/** Explicit setup saves its approved definition before any registration/start. Does not claim OS success.
 * `replaces` is the recorded definition the terminal approved replacing; without it a recorded service is only confirmed. */
export async function recordInstallationService(releases: string, workspace: string, approved: ServiceDefinition,
  env: Readonly<Record<string, string | undefined>> = process.env, replaces: ServiceDefinition | null = null) {
  const store = new InstallationStore(installationPath(env));
  assertProductDirectory(dirname(store.path), userHome(env)); assertProductDirectory(releases, userHome(env));
  return store.locked(async (record, publish) => {
    if (!record || record.workspace !== workspace || record.releases !== releases || record.home !== userHome(env))
      throw new Error('Service installation record is missing or differs; run alpacawork setup from a terminal');
    if (realpathSync(releases) !== releases) throw new Error('Service releases path is not canonical');
    const saved = record.service ? serviceDefinition(record, store.path) : null;
    const port = servicePort(approved);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Approved service port must be 1..65535');
    const nodeExecutable = absolutePath(realpathSync(process.execPath));
    const environmentPath = approved.environment.PATH;
    if (typeof environmentPath !== 'string') throw new Error('Approved service PATH is missing');
    const installation: Installation = { ...record, nodeExecutable, service: {
      name: approved.name, port, publicHost: servicePublicHost(approved) ?? null, environmentPath, ...(serviceMcp(approved) ? { mcp: true } : {}),
    } };
    const expected = serviceDefinition(installation, store.path);
    if (!isDeepStrictEqual(approved, expected) || (saved ? saved.name !== approved.name || !isDeepStrictEqual(saved, replaces ?? approved) : replaces !== null))
      throw new Error('Approved service definition differs from the installation; retained');
    publish(installation);
    return installation;
  });
}

/** Normal update/setup reads also prove the current DB identity; a supplied name only checks the saved name. */
export function readInstallationService(input: { workspace: string; releases?: string; env?: Readonly<Record<string, string | undefined>>; name?: string }) {
  const result = checkedInstallationService(input);
  assertInstallationIdentity(result.installation);
  return result;
}

/** Validate the saved service facts without opening a workspace; maintenance must reach damaged DBs.
 * Only setup's terminal confirmation approves another Node path, so every other reader refuses it and names that fix. */
export function checkedInstallationService(input: { workspace: string; releases?: string; env?: Readonly<Record<string, string | undefined>>; name?: string }) {
  const env = input.env ?? process.env, store = new InstallationStore(installationPath(env)), record = store.read();
  if (!record || !record.service || !record.releases)
    throw new Error('Service installation record is missing; run alpacawork setup from a terminal');
  const service = record.service, releases = record.releases;
  if (input.name !== undefined && service.name !== input.name) throw new Error('Managed service name differs from its installation record; retained');
  if (record.workspace !== input.workspace || input.releases !== undefined && input.releases !== releases || realpathSync(releases) !== releases)
    throw new Error('Service installation record differs from workspace or releases; retained');
  const nodeExecutable = realpathSync(process.execPath);
  if (record.nodeExecutable !== nodeExecutable)
    throw new Error(`Node.js is now ${nodeExecutable}, but this installation approved ${record.nodeExecutable}; run alpacawork setup again from a terminal to approve the change`);
  if (!statSync(releases).isDirectory()) throw new Error('Recorded service releases directory is missing; retained');
  return { installation: { ...record, releases, service }, definition: serviceDefinition(record, store.path), port: service.port };
}

/** Ask the OS once; close before confirmation. A later race is an ordinary startup failure.
 * Without a port the OS selects a free one; with one, the probe fails when that port is taken. */
export async function probeServicePort(port = 0): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else if (!address || typeof address === 'string' || address.port < 1) reject(new Error('Could not select a service port'));
        else resolve(address.port);
      });
    });
  });
}

export function serviceDefinition(record: Pick<Installation, 'home' | 'nodeExecutable' | 'releases' | 'workspace' | 'service'>, path: string): ServiceDefinition {
  const { releases, workspace, service } = record;
  if (!releases || !service) throw new Error('Service installation settings are missing');
  const { name, port, publicHost, environmentPath, mcp } = service;
  const config = dirname(dirname(path));
  const definition: ServiceDefinition = { name, executable: record.nodeExecutable,
    args: ['--', backendEntry('backend', join(releases, 'current')), '--workspace', workspace, 'workspace', 'serve', ...(publicHost ? ['--public-host', publicHost] : []), ...(mcp ? ['--mcp'] : []), '--port', String(port)],
    workingDirectory: record.home,
    environment: { HOME: record.home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(record.home, '.local/share'),
      XDG_STATE_HOME: join(record.home, '.local/state'), XDG_CACHE_HOME: join(record.home, '.cache'),
      ALPACAWORK_MANAGED_RELEASES: releases, PATH: environmentPath } };
  validateService(definition);
  return definition;
}

/** Service startup cannot fall back to discovery when its installation record was removed/replaced. */
export function managedInstallation(env: Readonly<Record<string, string | undefined>>): Installation | null {
  if (!env.ALPACAWORK_MANAGED_RELEASES) return null;
  const record = new InstallationStore(installationPath(env)).read();
  if (!record || record.releases !== env.ALPACAWORK_MANAGED_RELEASES || record.home !== env.HOME)
    throw new Error('Managed service installation record is missing or differs; startup refused. Run alpacawork setup again from a terminal');
  return checkedInstallationService({ workspace: record.workspace, releases: env.ALPACAWORK_MANAGED_RELEASES, env }).installation;
}

/** One destination rule shared by public setup and the thin skills-only CLI. */
export function installationSkillsRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return managedSkillsRoot(userHome(env));
}

export function serviceMcp(definition: ServiceDefinition): boolean {
  return definition.args.includes('--mcp');
}

export function servicePublicHost(definition: ServiceDefinition): string | undefined {
  const at = definition.args.indexOf('--public-host');
  const host = at < 0 ? undefined : definition.args[at + 1];
  if (at >= 0 && (!host || !PUBLIC_HOST_PATTERN.test(host))) throw new Error('Recorded public-host is invalid');
  return host;
}
export function servicePath(env: Readonly<Record<string, string | undefined>>): string {
  return [...new Set([dirname(realpathSync(process.execPath)), ...(env.PATH ?? '/usr/bin:/bin').split(':').filter(Boolean)])].join(':');
}

export function servicePort(definition: ServiceDefinition): number {
  const at=definition.args.indexOf('--port'), port=Number(at < 0 ? NaN : definition.args[at+1]);
  if (!Number.isInteger(port)||port<1||port>65535)throw new Error('Service port must be 1..65535');
  return port;
}
