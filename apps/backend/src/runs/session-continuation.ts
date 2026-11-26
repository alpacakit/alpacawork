import { isDeepStrictEqual } from 'node:util';
import type { Selection } from '@alpacawork/contract';
import { appliedAgentLaunchValues, carriedAgentLaunchValues, type AppliedLaunchChoices } from '@alpacawork/contract/agent-launch';
import type { RunRecord, RuntimeRunRecord } from '@alpacawork/contract/run';

/** A session belongs to its agent profile. Model and effort are chosen for each launch. */
export function isConversationAgent(sessionRun: Pick<RuntimeRunRecord, 'agent'>, agent: string): boolean {
  return sessionRun.agent === agent;
}

/** Walk only actual resume ancestors; a broken or cyclic chain ends without inventing a session. */
function* ancestors<T extends Pick<RuntimeRunRecord, 'id' | 'resumes'>>(from: T, get: (id: string) => T | undefined): Generator<T> {
  const seen = new Set<string>();
  let current: T | undefined = from;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    yield current;
    current = current.resumes ? get(current.resumes) : undefined;
  }
}

export function appliedSessionValues(launch: RunRecord['launch'], previous?: AppliedLaunchChoices): Selection {
  const supplied = appliedAgentLaunchValues(launch);
  return previous ? { ...carriedAgentLaunchValues(launch.values, previous), ...supplied } : supplied;
}

/** Reconstruct effective choices from frozen invocations in the resume chain. */
export function appliedConversationValues(head: RunRecord, runs: readonly RunRecord[]): Selection {
  const applied = appliedSessionValues(head.launch);
  if (Object.entries(head.launch.values).every(([key, value]) => value === null || Object.hasOwn(applied, key))) return applied;
  const byId = new Map(runs.map(run => [run.id, run]));
  const chain: RunRecord[] = [];
  for (const run of ancestors(head, id => byId.get(id))) {
    if (!isConversationAgent(run, head.agent) || run.launch.adapter !== head.launch.adapter ||
        run.launch.values.model !== head.launch.values.model) break;
    chain.push(run);
  }
  let previous: AppliedLaunchChoices | undefined;
  for (const { launch } of chain.reverse()) previous = { values: launch.values, applied: appliedSessionValues(launch, previous) };
  return previous?.applied ?? applied;
}

/** A Task message can join only the live invocation in its compatible resume chain. */
export function taskInputSession(runs: readonly RuntimeRunRecord[], from: RuntimeRunRecord,
  working: RuntimeRunRecord): RuntimeRunRecord['session'] {
  const session = working.session;
  if (working.state !== 'running' || !session || !isDeepStrictEqual(from.launch.values, working.launch.values)) return null;
  for (const current of ancestors(from, id => runs.find(run => run.id === id))) {
    if (!isConversationAgent(current, working.agent) || current.launch.adapter !== working.launch.adapter ||
        current.session && !isDeepStrictEqual(current.session, session)) return null;
    if (current.id === working.id) return session;
    if (current.state === 'running') return null;
  }
  return null;
}
