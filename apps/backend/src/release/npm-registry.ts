import { npmArguments, npmEnvironment, runNpmProcess } from './npm-process.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Installation facts belong to the caller. No discovery, domain comparison or persistence here. */
export interface NpmMetadataRequest {
  nodeExecutable: string;
  npmCli: string;
  packageName: string;
  selector: string; // latest or a canonical exact version, never a general npm spec
  userConfig: string;
  globalConfig: string;
  homeDirectory: string;
  /** Approved installation environment, including proxy and ${TOKEN} substitutions in npmrc. */
  environment: Readonly<NodeJS.ProcessEnv>;
  signal?: AbortSignal;
  deadlineMs?: number;
  fetchTimeoutMs?: number;
  maxStdoutBytes?: number;
  temporaryDirectory?: string;
}

export interface NpmMetadataIdentity {
  registryOrigin: string;
  packageName: string;
  selector: string;
}
export type NpmMetadataFailureKind =
  | 'invalid_input' | 'aborted' | 'deadline'
  | 'spawn_failed' | 'process_failed' | 'output_limit' | 'invalid_json'
  | 'invalid_metadata' | 'io_failed' | 'cleanup_failed';
export type NpmMetadataPhase = 'input' | 'configuration' | 'metadata' | 'cleanup';
export type NpmMetadataResult = {
  ok: true;
  identity: NpmMetadataIdentity;
  metadata: Record<string, unknown> & { name: string; version: string };
} | {
  ok: false;
  error: {
    kind: NpmMetadataFailureKind;
    phase: NpmMetadataPhase;
    /** Present only after validation; never echo invalid inputs or npm diagnostic text. */
    identity?: NpmMetadataIdentity;
    exitCode?: number;
    npmCode?: string;
    httpStatus?: number;
  };
};

type Failure = Extract<NpmMetadataResult, { ok: false }>;
const fail = (kind: NpmMetadataFailureKind, phase: NpmMetadataPhase,
  identity?: NpmMetadataIdentity): Failure => ({ ok: false, error: { kind, phase, ...(identity && { identity }) } });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
// Canonical SemVer syntax only. Ordering, engine and prerelease policy belong to release.
const number = '(?:0|[1-9][0-9]*)';
const pre = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const exactVersion = new RegExp(`^${number}\\.${number}\\.${number}(?:-${pre}(?:\\.${pre})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const validVersion = (s: unknown): s is string => typeof s === 'string' && s.length <= 256 && s === s.trim() && exactVersion.test(s);
const packagePart = '[a-z0-9][a-z0-9._-]*';
const packageName = new RegExp(`^(?:@${packagePart}/)?${packagePart}$`);
const positiveInteger = (n: number, max: number) => Number.isSafeInteger(n) && n > 0 && n <= max;

function registryUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
  } catch { return; }
}

/** One fresh, bounded npm view. Failures never contain stdout/stderr, paths or environment secrets. */
export async function fetchNpmMetadata(request: NpmMetadataRequest): Promise<NpmMetadataResult> {
  const deadline = request.deadlineMs ?? 20_000;
  const fetchTimeout = request.fetchTimeoutMs ?? 10_000;
  const limit = request.maxStdoutBytes ?? 8 * 1024 * 1024;
  if (request.packageName.length > 214 || request.packageName !== request.packageName.trim() || !packageName.test(request.packageName) ||
    (request.selector !== 'latest' && !validVersion(request.selector)) ||
    ![request.nodeExecutable, request.npmCli, request.userConfig, request.globalConfig,
      request.homeDirectory, request.temporaryDirectory ?? tmpdir()].every(p => isAbsolute(p) && !p.includes('\0')) ||
    request.userConfig === request.globalConfig || !positiveInteger(deadline, 300_000) ||
    !positiveInteger(fetchTimeout, 300_000) || !positiveInteger(limit, 64 * 1024 * 1024)) {
    return fail('invalid_input', 'input');
  }
  let identity: NpmMetadataIdentity | undefined;
  let phase: NpmMetadataPhase = 'configuration';
  let root: string | undefined;
  let stopped: 'aborted' | 'deadline' | undefined;
  const cancel = new AbortController();
  const abort = () => { stopped ??= 'aborted'; cancel.abort(); };
  const timeout = setTimeout(() => { stopped ??= 'deadline'; cancel.abort(); }, deadline);
  request.signal?.addEventListener('abort', abort, { once: true });
  if (request.signal?.aborted) abort();
  let result: NpmMetadataResult = fail('io_failed', phase, identity);
  try {
    if (stopped) return fail(stopped, phase, identity);
    root = await mkdtemp(join(request.temporaryDirectory ?? tmpdir(), 'alpacawork-npm-metadata-'));
    const cwd = join(root, 'cwd');
    await mkdir(cwd);
    // A package root prevents npm's ancestor search from reaching an arbitrary repository .npmrc.
    // cwd itself is private and has no project .npmrc.
    await mkdir(join(cwd, 'node_modules'));
    const env = npmEnvironment(request.environment, request.homeDirectory);
    const common = npmArguments(request, root);
    const run = async (args: string[]) => {
      const output = await runNpmProcess({ nodeExecutable: request.nodeExecutable, npmCli: request.npmCli,
        args: [...common, ...args], cwd, environment: env, signal: cancel.signal, maxStdoutBytes: limit });
      if (output.ok === true) return output;
      const { ok: _ok, kind, ...details } = output;
      return { ok: false as const, error: { ...details, kind: kind === 'cleanup_failed' ? kind : stopped ?? kind,
        phase: kind === 'cleanup_failed' ? 'cleanup' as const : phase, identity } };
    };
    result = await (async (): Promise<NpmMetadataResult> => {
      const scope = request.packageName.startsWith('@') ? request.packageName.split('/')[0] : undefined;
      let effective: string | undefined;
      if (scope) {
        const configured = await run(['config', 'get', `${scope}:registry`]);
        if (configured.ok === false) return configured;
        effective = configured.stdout.trim();
      }
      if (!effective || effective === 'undefined' || effective === 'null') {
        const configured = await run(['config', 'get', 'registry']);
        if (configured.ok === false) return configured;
        effective = configured.stdout.trim();
      }
      const registry = registryUrl(effective);
      if (!registry) return fail('invalid_input', phase);
      identity = { registryOrigin: registry.origin, packageName: request.packageName, selector: request.selector };
      phase = 'metadata';
      // Pin routing even if a config file changes after the preflight. Scoped config wins over registry.
      const output = await run([`--registry=${registry.href}`, ...(scope ? [`--${scope}:registry=${registry.href}`] : []),
        '--json', 'view', `${request.packageName}@${request.selector}`]);
      if (output.ok === false) return output;
      let metadata: unknown;
      try { metadata = JSON.parse(output.stdout); }
      catch { return fail('invalid_json', phase, identity); }
      if (!record(metadata) || metadata.name !== request.packageName || !validVersion(metadata.version) ||
        (request.selector !== 'latest' && metadata.version !== request.selector)) {
        return fail('invalid_metadata', phase, identity);
      }
      return { ok: true, identity, metadata: metadata as Record<string, unknown> & { name: string; version: string } };
    })();
  } catch {
    result = fail('io_failed', phase, identity);
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', abort);
    if (root) {
      try { await rm(root, { recursive: true, force: true }); }
      catch { result = fail('cleanup_failed', 'cleanup', identity); }
    }
  }
  return result;
}
