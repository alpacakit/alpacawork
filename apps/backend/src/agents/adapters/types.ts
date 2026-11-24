import type { AgentUsage } from '@alpacawork/contract/agent-bridge';
import type { LimitsReport } from '@alpacawork/contract/agent-limits';
import type { AgentExit, ReaderResult } from '../../runs/readers/result.js';
import type { RunFailure } from '@alpacawork/contract/run-failure';
import type { ActivityEvent } from '../../runs/activity-events.js';
import type { CatalogInput } from '../../coordinator/skill-catalog/context.js';

export type AdapterInvocation = { mode: 'start' | 'resume'; session: string | null };
/** Translation only. Input identity, attempt uniqueness and retry policy stay in runs/input. */
export type InputProtocol = {
  encode(id: string, text: string): unknown;
  receipt(value: unknown, session: string | null): { id: string; outcome: 'taken' | 'not_sent' | 'uncertain' } | null;
  turnEnded(value: unknown, session: string | null): boolean;
};
export type AdapterObservation = { outcome: ReaderResult; session: string | null; usage: AgentUsage | null; failure?: RunFailure; toolsSettled?: boolean };
export type SkillCatalogContext = Pick<CatalogInput, 'env' | 'session'> & { kind: 'claude' | 'codex' };
/**
 * How an agent reports its account's plan limits and who it is signed in as, without a conversation or a model call: the
 * arguments after the agent's launch prefix, what to write to its stdin, and the translation of what it prints (null when
 * it gave no answer; the limits monitor checks every answer against the contract). An adapter without one reports none.
 */
export type LimitsProbe = { args: readonly string[]; input: string | null; read(stdout: string): LimitsReport | null };
export type AgentAdapter = {
  input: InputProtocol;
  read(invocation: AdapterInvocation, folder: string, exit: AgentExit): AdapterObservation;
  earlySession(invocation: AdapterInvocation, folder: string): string | null;
  activity(value: unknown, received: string): ActivityEvent[];
  skillCatalogContext(input: Pick<CatalogInput, 'argv' | 'env' | 'session'>): SkillCatalogContext;
  limits: LimitsProbe | null;
};
