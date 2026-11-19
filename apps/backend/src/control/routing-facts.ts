/** Read-only Task facts used by return and seat rules; this is never a document accepted by a Task writer. */
import type { ControlMetadata, TaskLog } from '@alpacawork/raw';

export type TaskDecisionFacts = {
  readonly id: string;
  readonly meta: Readonly<Pick<ControlMetadata,
    'id' | 'kind' | 'parentId' | 'lifecycle' | 'title' | 'baseState' | 'hold' | 'state' | 'userRequested'>> & {
      readonly log: readonly TaskLog[];
    };
};
/** A routing preparation also carries the current Task hash for admission's later compare-and-swap check. */
export type RoutingTask = TaskDecisionFacts & { readonly hash: string };
