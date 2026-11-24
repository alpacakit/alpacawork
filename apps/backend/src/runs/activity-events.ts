/** Events emitted by an adapter for the activity projection. */
import type { RunActivity } from '@alpacawork/contract/run';
export type ActivityEvent = {
  at: string; kind: RunActivity['kind']; toolName?: unknown; id?: unknown;
  command?: NonNullable<RunActivity['doing']>['command']; text?: unknown;
  /** A tool start: what the tool was given, as the agent wrote it, and the agent's own words for it. */
  detail?: unknown; about?: unknown;
  /** A tool end: what came back. */
  outcome?: { text: unknown; failed: boolean };
};
