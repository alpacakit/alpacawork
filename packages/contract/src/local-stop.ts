/** Local-human emergency command. No DB or remote authorization is inferred offline. */
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { publishImmutable, readImmutable, strictJson, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { z } from 'zod';
import { launchSchema, localStopSchema, PROTOCOL_LIMITS } from './run-protocol.js';
export const workspaceIdentitySchema = z.object({ protocol: z.literal(1), workspaceId: z.uuid() }).strict();
export const localStopCaller = {
  allows: (env: Readonly<Record<string, string | undefined>>): boolean =>
    !env.ALPACAWORK_RUN && !env.ALPACAWORK_RUN_TOKEN,
  help: 'Local human outside a Run only; ALPACAWORK_RUN and ALPACAWORK_RUN_TOKEN must both be absent or empty.',
};
export function stopLocal(root: string, run: string, opId: string, env: NodeJS.ProcessEnv = process.env) {
  if (!localStopCaller.allows(env)) throw new Problem(PROBLEM_CODE.forbidden, 'stop-local requires a local human outside a Run');
  if (!root.startsWith('/') || !/^R[1-9][0-9]*$/.test(run)) throw new Problem(PROBLEM_CODE.invalidInput, 'Absolute workspace and Run ID are required');
  const meta = join(root, '.alpacawork'), workspace = workspaceIdentitySchema.parse(strictJson(readImmutable(meta, 'execution-identity.json', 1024)));
  const protocol = join(meta, 'runs', run, 'protocol');
  const attempts = readdirSync(protocol).filter(name => /^[a-f0-9-]{36}$/.test(name));
  if (attempts.length !== 1) throw new Problem(PROBLEM_CODE.conflict, 'Run has no unique execution attempt');
  const launch = launchSchema.parse(strictJson(readImmutable(join(protocol, attempts[0]!), 'launch.json', PROTOCOL_LIMITS.launch)));
  if (launch.runId !== run || launch.workspaceId !== workspace.workspaceId) throw new Error('Local stop identity mismatch');
  const path = join(meta, 'local-stops'), name = `${opId}.json`;
  // requestedAt is fixed on replay, while target identity must still agree.
  let existing: ReturnType<typeof localStopSchema.parse> | undefined;
  try { existing = localStopSchema.parse(strictJson(readImmutable(path, name, PROTOCOL_LIMITS.command))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const stop = localStopSchema.parse({ protocol: 1, workspaceId: workspace.workspaceId, operationId: opId, targetRunId: run,
    scope: 'run-descendants', requestedAt: existing?.requestedAt ?? new Date().toISOString(), actor: 'local-human' });
  publishImmutable(path, name, JSON.stringify(stop));
  return { state: 'stop_request_saved', operationId: opId, run };
}
