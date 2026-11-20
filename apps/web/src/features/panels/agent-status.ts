import { AGENT_ADAPTERS, type BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
import type { AgentAvailability, ServerSettings } from '@alpacawork/contract';
import { draftAdapter, type AgentDraft } from './agent-settings-draft';

export type AgentObservations = Pick<ServerSettings, 'availability' | 'detected'>;

/**
 * What the server last saw for a card. A saved profile has its own observation (its own `command`, its own
 * environment); an unsaved one without a `command` runs what the kind finds on the server PATH.
 */
export function agentObservation(agent: AgentDraft, observations: AgentObservations | undefined): AgentAvailability | undefined {
  const saved = agent.originalName === undefined ? undefined : observations?.availability?.[agent.originalName];
  if (saved) return saved;
  const adapter = draftAdapter(agent);
  return adapter && agent.command === undefined ? observations?.detected?.[adapter] : undefined;
}

/** The one line a closed card adds, only when the agent is known not to start: signed out, or no executable. */
export type AgentNotice = { kind: 'signedOut'; action: string } | { kind: 'notFound'; executable: string };
export function agentNotice(adapter: BuiltinAdapterId | null, observation: AgentAvailability | undefined): AgentNotice | null {
  if (!observation) return null;
  if (observation.status === 'signed_out' && observation.nextAction) return { kind: 'signedOut', action: observation.nextAction };
  if (observation.status === 'not_found') return { kind: 'notFound', executable: observation.command ?? (adapter && AGENT_ADAPTERS[adapter].command) ?? '' };
  return null;
}

/**
 * What the add control says under a chosen kind, from what the server saw of it: where this PC has it (nothing for a
 * bundled kind), and how to sign in. Known ready: nothing. Known signed out: its next step alone. Otherwise, or before
 * the status arrives: the general words.
 */
export type AddAgentGuide = { place: { path: string; version: string | null } | 'missing' | null; signIn: 'signedOut' | 'general' | null };
export function addAgentGuide(adapter: BuiltinAdapterId, detected: AgentAvailability | undefined): AddAgentGuide {
  const place = !detected || AGENT_ADAPTERS[adapter].command === null ? null
    : detected.command ? { path: detected.command, version: detected.version } : 'missing';
  const signIn = detected?.status === 'ready' ? null : detected?.status === 'signed_out' && detected.nextAction ? 'signedOut' : 'general';
  return { place, signIn };
}

export type ExecutableCandidate = { path: string; version: string | null };
/**
 * The choices of the executable row. "Automatic" is what the server PATH finds first; the other same-named commands on
 * it follow. A saved path that is not on the PATH is the typed one. Pinning the automatic one keeps it as a choice.
 */
export function executableChoices(command: string | undefined, detected: AgentAvailability | undefined): {
  automatic: ExecutableCandidate | null; others: ExecutableCandidate[]; selected: 'automatic' | 'other' | string;
} {
  const candidates = detected?.candidates ?? [];
  const automatic = candidates[0] ?? null;
  const others = candidates.filter(candidate => candidate !== automatic || candidate.path === command);
  const selected = command === undefined ? 'automatic' : candidates.some(candidate => candidate.path === command) ? command : 'other';
  return { automatic, others, selected };
}

/** Choosing "automatic" removes `command`; any path (a candidate or a typed one) is written as it is. */
export function withCommand(agent: AgentDraft, command: string | undefined): AgentDraft {
  const { command: _command, ...rest } = agent;
  return command === undefined ? rest : { ...rest, command };
}

/** Whether a typed path is worth asking the server about: only an absolute one can be run. */
export const inspectablePath = (text: string) => text.startsWith('/') && text.trim() === text && text.length > 1;
