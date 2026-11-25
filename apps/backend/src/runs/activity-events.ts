/** Events emitted by an adapter for the activity projection. */
import type { RunActivity, RunStepLine, RunStepText } from '@alpacawork/contract/run';
/** A tool call's input as given: its tool and its fields as written (put together from its start and end, then said). */
/**
 * A tool call's input as given: its tool and its fields as written (put together from its start and end, then said).
 * `clipped`: characters the bridge cut from it, by the input's field ("" for an input cut whole).
 */
export type StepCall = { tool: string; input: unknown; clipped?: Record<string, number> };
export type ActivityEvent = {
  at: string; kind: RunActivity['kind']; toolName?: unknown; id?: unknown;
  command?: NonNullable<RunActivity['doing']>['command']; text?: unknown;
  /** A display name when the bridge uses a generic name for its rounded label. */
  stepTool?: unknown;
  /** The tool input and the agent's description. Some tools report their input only on completion. */
  detail?: RunStepLine; about?: string | null;
  /** The tool input as given, where the output holds it so: a step's start and end records are put together field by field. */
  call?: StepCall;
  /** The tool input as a bridge wrote it (already one text, bounded), where there is no `call`. */
  input?: RunStepText;
  /** A tool end: what came back, as a preview and as written. */
  outcome?: { result: RunStepLine; failed: boolean; output?: RunStepText; /** Nothing says how it went. */ unknown?: true };
  /** The bridge could not keep this record's details (its line was too long even cut): only its type, ID and command came. */
  dropped?: true;
};
