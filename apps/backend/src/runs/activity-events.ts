/** Events emitted by an adapter for the activity projection. */
import type { RunActivity } from '@alpacawork/contract/run';
export type ActivityEvent = {
  at: string; kind: RunActivity['kind']; toolName?: unknown; id?: unknown;
  command?: NonNullable<RunActivity['doing']>['command']; text?: unknown;
};
