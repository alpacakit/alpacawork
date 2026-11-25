/** Events emitted by an adapter for the activity projection. */
import type { RunActivity, RunStepLine } from '@alpacawork/contract/run';
export type ActivityEvent = {
  at: string; kind: RunActivity['kind']; toolName?: unknown; id?: unknown;
  command?: NonNullable<RunActivity['doing']>['command']; text?: unknown;
  /** A display name when the bridge uses a generic name for its rounded label. */
  stepTool?: unknown;
  /** The tool input and the agent's description. Some tools report their input only on completion. */
  detail?: RunStepLine; about?: string | null;
  /** The tool input as written, where the output holds it whole (a bridge's own events carry the preview alone). */
  input?: string;
  /** A tool end: what came back, as a preview and, where the output holds it, as written. */
  outcome?: { result: RunStepLine; failed: boolean; output?: string };
};
