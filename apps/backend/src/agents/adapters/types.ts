import type { AgentUsage } from '@alpacawork/contract/agent-bridge';
import type { LimitsReport } from '@alpacawork/contract/agent-limits';
import type { ContextUpdate } from '@alpacawork/contract/agent-context';
import type { AgentExit, ReaderResult } from '../../runs/readers/result.js';
import type { RunFailure } from '@alpacawork/contract/run-failure';
import type { ActivityEvent } from '../../runs/activity-events.js';
import type { CatalogInput } from '../../coordinator/skill-catalog/context.js';
import type { CompactionLaunch, CompactionOutcome } from '@alpacawork/contract/run-protocol';

/** `compaction`: the ID of the compaction the launch asked for before its initial input (runs/compactions). */
export type AdapterInvocation = { mode: 'start' | 'resume'; session: string | null; compaction: string | null };
/** Translation only. Input identity, attempt uniqueness and retry policy stay in runs/input. */
export type InputProtocol = {
  /** The lines that give the agent one instruction; with `compaction`, the agent compacts its conversation first. */
  encode(id: string, text: string, compaction: CompactionLaunch | null): unknown[];
  receipt(value: unknown, session: string | null): { id: string; outcome: 'taken' | 'not_sent' | 'uncertain' } | null;
  turnEnded(value: unknown, session: string | null): boolean;
};
/** `compaction`: what the agent said of the compaction its invocation asked for; null when it said nothing. */
export type AdapterObservation = { outcome: ReaderResult; session: string | null; usage: AgentUsage | null; failure?: RunFailure;
  toolsSettled?: boolean; compaction: CompactionOutcome | null };
export type SkillCatalogContext = Pick<CatalogInput, 'env' | 'session'> & { kind: 'claude' | 'codex' };
/**
 * How an agent reports its account's plan limits and who it is signed in as, without a conversation or a model call: the
 * arguments after the agent's launch prefix, what to write to its stdin, and the translation of what it prints (null when
 * it gave no answer; the limits monitor checks every answer against the contract). An adapter without one reports none.
 */
export type LimitsProbe = { args: readonly string[]; input: string | null; read(stdout: string): LimitsReport | null };
/** A cumulative model update can revise a previous count for the same call. Bridges send new calls. */
export type ModelOutputEvent =
  | { kind: 'turn_started' }
  | { kind: 'turn_ended' }
  | { kind: 'call'; tokens: number; id?: string; startedSecond?: number };
export type AgentAdapter = {
  input: InputProtocol;
  read(invocation: AdapterInvocation, folder: string, exit: AgentExit): AdapterObservation;
  earlySession(invocation: Pick<AdapterInvocation, 'mode' | 'session'>, folder: string): string | null;
  activity(value: unknown, received: string): ActivityEvent[];
  modelOutputReader(): (value: unknown, observedSecond: number) => ModelOutputEvent | null;
  /** Optional fast skips for ordinary readers and for the live reader that also needs model events. */
  skipOutputLine?(line: Buffer): boolean;
  skipActivityLine?(line: Buffer): boolean;
  /** What one output row says of how full the main conversation is; null when it says nothing of it. */
  context(value: unknown): ContextUpdate | null;
  skillCatalogContext(input: Pick<CatalogInput, 'argv' | 'env' | 'session'>): SkillCatalogContext;
  limits: LimitsProbe | null;
};
