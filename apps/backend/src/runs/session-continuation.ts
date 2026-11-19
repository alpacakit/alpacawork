import { isDeepStrictEqual } from 'node:util';
import type { RuntimeRunRecord } from '@alpacawork/contract/run';

/** Walk only actual resume ancestors; a broken or cyclic chain ends without inventing a session. */
function* ancestors(runs: readonly RuntimeRunRecord[], from: RuntimeRunRecord): Generator<RuntimeRunRecord> {
  const seen = new Set<string>();
  let current: RuntimeRunRecord | undefined = from;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    yield current;
    current = current.resumes ? runs.find(run => run.id === current!.resumes) : undefined;
  }
}

/** Resolve continuation sessions from the resume chain for launch and live input alike. */
export function continuationSession(runs: readonly RuntimeRunRecord[], from: RuntimeRunRecord,
  purpose: { kind: 'launch'; coordinator: boolean } | { kind: 'input'; working: RuntimeRunRecord }): RuntimeRunRecord['session'] {
  if (purpose.kind === 'launch' && !purpose.coordinator) return from.session;
  const working = purpose.kind === 'input' ? purpose.working : null;
  const session = working?.session;
  if (working && (working.state !== 'running' || !session ||
      !isDeepStrictEqual(from.launch.values, working.launch.values))) return null;
  for (const current of ancestors(runs, from)) {
    // A failed coordinator turn establishes no session; its earlier successful turn still stands.
    if (!working) { if (current.state === 'succeeded') return current.session; continue; }
    if (current.agent !== working.agent || current.launch.adapter !== working.launch.adapter ||
        current.session && !isDeepStrictEqual(current.session, session)) return null;
    if (current.id === working.id) return session ?? null;
    if (current.state === 'running') return null;
  }
  return null;
}
