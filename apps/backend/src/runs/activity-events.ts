/** Events emitted by an adapter for the activity projection. */
import type { InputParts, RunActivity, RunStepLine, RunStepText } from '@alpacawork/contract/run';
export type ActivityEvent = {
  at: string; kind: RunActivity['kind']; toolName?: unknown; id?: unknown;
  command?: NonNullable<RunActivity['doing']>['command']; text?: unknown;
  /** A display name when the bridge uses a generic name for its rounded label. */
  stepTool?: unknown;
  /** The tool input and the agent's description. Some tools report their input only on completion. */
  detail?: RunStepLine; about?: string | null;
  /** The tool input by field, where the output holds it so: a step's start and end records are put together field by field. */
  call?: InputParts;
  /** The tool input as a bridge wrote it (already one text, bounded), where there is no `call`. */
  input?: RunStepText;
  /** A tool end: what came back, as a preview and as written. */
  outcome?: { result: RunStepLine; failed: boolean; output?: RunStepText };
};
