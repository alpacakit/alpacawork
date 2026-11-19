/** On-demand host observations. One deadline and one probe per target/operation for a whole inspection. */
import { spawn } from 'node:child_process';
import { setMaxListeners } from 'node:events';
import { join } from 'node:path';
import { AGENT_ADAPTERS, BUILTIN_ADAPTER_IDS, type BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
import { settingAdapter, type AgentSetting } from '@alpacawork/contract/agent-settings';
import { executableCandidates, executableIssue, resolveExecutable } from '@alpacawork/core';
import { AGENT_CHECK_MS, type AgentAvailability } from '@alpacawork/contract';
import { agentEnvironment } from '../runs/env.js';
import { appRoot } from '../app-paths.js';
export type InspectionEnvironment = { cwd: string; env: Readonly<Record<string, string | undefined>>; bridge?: readonly string[] };
const host = (): InspectionEnvironment => ({ cwd: process.cwd(), env: process.env });
type Probe = { status: number | null; stdout: string; failed: boolean };
function probe(argv: readonly string[], environment: InspectionEnvironment, names: readonly string[], signal: AbortSignal): Promise<Probe> {
  if (signal.aborted) return Promise.resolve({ status: null, stdout: '', failed: true });
  return new Promise(resolve => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: environment.cwd,
      env: agentEnvironment(environment.env, environment.env.PATH ?? '', undefined, names),
      detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', size = 0, failed = false;
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } } };
    const abort = () => { failed = true; stop(); };
    signal.addEventListener('abort', abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data: Buffer) => {
      size += data.length;
      if (size > 64 * 1024) abort();
      else if (stream === child.stdout) stdout += data.toString();
    });
    child.once('error', () => { failed = true; });
    child.once('close', (status, exitSignal) => {
      signal.removeEventListener('abort', abort); stop(); resolve({ status, stdout, failed: failed || exitSignal !== null });
    });
  });
}
/** The same admitted prefix for native and bridge commands; options remain separate. */
export function commandPrefix(id: BuiltinAdapterId, command: string | undefined): string[] {
  const adapter = AGENT_ADAPTERS[id];
  return command ? adapter.prefix.length === 1 ? [command] : [...adapter.prefix, '--command', command] : [...adapter.prefix];
}
export function launchCommand(id: BuiltinAdapterId, setting: AgentSetting, path: string): string | undefined {
  const name = AGENT_ADAPTERS[id].command;
  return name === null ? undefined : resolveExecutable(name, setting.command, path);
}

async function inspect<T>(environment: InspectionEnvironment, timeoutMs: number,
  operation: (observe: (id: BuiltinAdapterId, setting?: AgentSetting, versionOnly?: boolean) => Promise<AgentAvailability>) => Promise<T>): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  setMaxListeners(0, controller.signal); // One inspection can own more than ten concurrent probes.
  // Share observations only when the executable, arguments and forwarded names agree.
  const probes = new Map<string, Promise<Probe>>();
  const check = (id: BuiltinAdapterId, command: string | null, args: readonly string[], names: readonly string[]) => {
    const key = JSON.stringify([id, command, args, names]);
    if (!probes.has(key)) {
      const argv = command === null ? [...(environment.bridge ?? [process.execPath, join(appRoot(import.meta.url), 'apps/agent-cli/dist/cli.js')]), id] : [command];
      probes.set(key, probe([...argv, ...args], environment, names, controller.signal));
    }
    return probes.get(key)!;
  };
  const observe = async (id: BuiltinAdapterId, setting?: AgentSetting, versionOnly = false): Promise<AgentAvailability> => {
    const adapter = AGENT_ADAPTERS[id];
    const names = [...adapter.fixedEnv, ...(setting?.env ?? adapter.defaultEnv)].sort();
    const paths = adapter.command === null ? [] : executableCandidates(adapter.command, environment.env.PATH ?? '', environment.cwd);
    const command = setting?.command ?? paths[0] ?? null;
    const issue = adapter.command === null ? null : command ? executableIssue(command) : 'not_found';
    const versions = (versionOnly ? [] : paths).map(async path => {
      const result = await check(id, path, ['--version'], names);
      return { path, version: !result.failed && result.status === 0 ? result.stdout.trim().split('\n')[0]!.slice(0, 300) || null : null };
    });
    const [candidates, versionResult, authResult] = await Promise.all([
      Promise.all(versions),
      issue ? null : check(id, command, ['--version'], names),
      !issue && adapter.auth && !versionOnly ? check(id, command, adapter.auth.args, names) : null,
    ]);
    const version = versionResult && !versionResult.failed && versionResult.status === 0 ? versionResult.stdout.trim().split('\n')[0]!.slice(0, 300) || null : null;
    let status: AgentAvailability['status'] = issue ? 'not_found' : 'unknown';
    if (authResult && !authResult.failed && !versionResult?.failed && adapter.auth)
      status = authResult.status === adapter.auth.ready ? 'ready' : authResult.status === adapter.auth.signedOut ? 'signed_out' : 'unknown';
    return { command, version, candidates, status, nextAction: adapter.auth?.nextAction ?? null, issue };
  };
  try { return await operation(observe); }
  finally { clearTimeout(timer); controller.abort(); }
}
export function inspectAgent(id: BuiltinAdapterId, setting?: AgentSetting, environment = host(), versionOnly = false, timeoutMs = AGENT_CHECK_MS): Promise<AgentAvailability> {
  return inspect(environment, timeoutMs, observe => observe(id, setting, versionOnly));
}
export function inspectAgents(agents: Record<string, AgentSetting>, environment = host(), timeoutMs = AGENT_CHECK_MS) {
  return inspect(environment, timeoutMs, async observe => {
    const [detected, availability] = await Promise.all([
      Promise.all(BUILTIN_ADAPTER_IDS.map(async id => [id, await observe(id)])),
      Promise.all(Object.entries(agents).map(async ([key, setting]) => [key, await observe(settingAdapter(key, setting)!, setting)])),
    ]);
    return { detected: Object.fromEntries(detected) as Record<BuiltinAdapterId, AgentAvailability>,
      availability: Object.fromEntries(availability) as Record<string, AgentAvailability> };
  });
}
