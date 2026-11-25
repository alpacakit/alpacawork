/** Events emitted by an adapter for the activity projection. */
import type { RunActivity, RunStepLine, RunStepText } from '@alpacawork/contract/run';
export type ActivityEvent = {
  at: string; kind: RunActivity['kind']; toolName?: unknown; id?: unknown;
  command?: NonNullable<RunActivity['doing']>['command']; text?: unknown;
  /** A display name when the bridge uses a generic name for its rounded label. */
  stepTool?: unknown;
  /** The tool input and the agent's description. Some tools report their input only on completion. */
  detail?: RunStepLine; about?: string | null;
  /** The tool input as written, to read in full when the step is opened (a bridge's own events bound it). */
  input?: RunStepText;
  /** A tool end: what came back, as a preview and as written. */
  outcome?: { result: RunStepLine; failed: boolean; output?: RunStepText };
};
