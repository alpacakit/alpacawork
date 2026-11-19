/** One agent process launch for a Run, inside its manager's unit. Run ownership stays with the caller. */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { platform, releaseForEntry } from '@alpacawork/core';
import { join } from 'node:path';
import { RUN_FILES, type RunRecord } from '@alpacawork/contract/run';
import { agentLaunchSchema, resolveAgentLaunchArgv, type AgentLaunch } from '@alpacawork/contract/agent-launch';
import { requireRuntimeAdapter } from '../agents/registry.js';
import { agentEnvironment } from './env.js';
import { openRunFile } from './files.js';
import { fileURLToPath } from 'node:url';
import { AgentInputChannel } from './input.js';
import type { AgentExit } from './readers/result.js';

/**
 * The unit name a Run's manager gets apart from serve (platform `spawnDetached`). A Run's own agent, a coordinator
 * turn's included, is launched without one and stays in its manager's unit.
 */
const unitPrefix = (root: string, id: string) => `alpacawork-run-${createHash('sha256').update(root).digest('hex').slice(0, 8)}-${id}-`;
export const processUnit = (root: string, id: string) => `${unitPrefix(root, id)}${randomBytes(3).toString('hex')}`;
/** Whether `unit` is a name `processUnit` gives Run `id`'s manager, so recovery stops that unit and no other. */
export const isProcessUnit = (root: string, id: string, unit: string) =>
  unit.startsWith(unitPrefix(root, id)) && /^[0-9a-f]{6}$/.test(unit.slice(unitPrefix(root, id).length));

/** Only this Run's dedicated scope can be inspected; inherited terminal scopes contain unrelated work. */
export function runScope(root: string, id: string, scope: string | null): string | null {
  const unit = scope && /^0::.*\/([^/]+)\.scope$/m.exec(scope)?.[1];
  return unit && isProcessUnit(root, id, unit) ? scope : null;
}

export type AgentInvocation = Pick<RunRecord, 'session'> & { launch: AgentLaunch; mode: 'start' | 'resume' };
export const invocationForRun = (run: Pick<RunRecord, 'launch' | 'session' | 'resumes'>): AgentInvocation =>
  ({ launch: agentLaunchSchema.parse(run.launch), session: run.session, mode: run.resumes === null ? 'start' : 'resume' });

export function launchArgv(invocation: Pick<AgentInvocation, 'launch' | 'session'>, folder: string): string[] {
  return resolveAgentLaunchArgv(invocation.launch, {
    session: invocation.session?.id, result: join(folder, RUN_FILES.resultTemp),
  });
}

/** An agent this process started: its child, its exit, and its stdin when the agent takes input. */
type LaunchedAgent<Id extends string = string> =
  { child: ChildProcess; exited: Promise<AgentExit>; channel: AgentInputChannel<Id>; spawnedAt: number };

export async function launchAgent<Id extends string>(input: {
  invocation: AgentInvocation; folder: string; root: string; cwd: string;
  env?: Record<string, string>; release?: string | null;
}): Promise<LaunchedAgent<Id>> {
  const { invocation, folder, root, cwd } = input;
  const argv = launchArgv(invocation, folder);
  const adapter = requireRuntimeAdapter(invocation.launch.adapter);
  const stdout = openRunFile(folder, RUN_FILES.stdout, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);
  let stderr = -1;
  const entry = fileURLToPath(import.meta.url);
  const release = input.release === undefined ? releaseForEntry(entry) : input.release;
  const entries: Record<string, string> = release ? {
    alpacawork: join(release, 'apps/cli/dist/cli.js'), 'alpacawork-agent': join(release, 'bin/agent.mjs'),
  } : {};
  const command = entries[argv[0]!] ?? argv[0]!;
  const effectivePath = release ? join(release, 'bin') + ':' + invocation.launch.path : invocation.launch.path;
  try {
    stderr = openRunFile(folder, RUN_FILES.stderr, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);
    const child = platform.run.spawnDetached(command, argv.slice(1), {
      stdio: ['pipe', stdout, stderr], cwd,
      env: { ...agentEnvironment(process.env, effectivePath, process.env.ALPACAWORK_SERVER, invocation.launch.env),
        ALPACAWORK_WORKSPACE: root, ...input.env,
        ...(release ? { ALPACAWORK_RUN_CLI: entries.alpacawork! } : {}) },
    });
    const exited = new Promise<AgentExit>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    if (child.pid === undefined) throw new Error('Agent did not receive a pid');
    const channel = new AgentInputChannel<Id>(child.stdin!, adapter.input);

    return { child, exited, channel, spawnedAt: performance.now() };
  } finally { closeSync(stdout); if (stderr >= 0) closeSync(stderr); }
}
