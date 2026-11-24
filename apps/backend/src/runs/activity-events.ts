/** Events emitted by an adapter for the activity projection. */
import type { RunActivity } from '@alpacawork/contract/run';
export type ActivityEvent = {
  at: string; kind: RunActivity['kind']; toolName?: unknown; id?: unknown;
  command?: NonNullable<RunActivity['doing']>['command']; text?: unknown;
  /** A display name when the bridge uses a generic name for its rounded label. */
  stepTool?: unknown;
  /** The tool input and the agent's description. Some tools report their input only on completion. */
  detail?: unknown; about?: unknown;
  /** A tool end: what came back. */
  outcome?: { text: unknown; failed: boolean };
};
