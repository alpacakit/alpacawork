/**
 * Which session a coordinator message to an agent goes on in, and the conversation's previous values for it. One rule
 * for admission (conversation.ts) and for the screen's previousValues (conversation-view.ts), so what the screen shows
 * as the conversation's values is what an omitted choice keeps.
 */
import type { Selection } from '@alpacawork/contract/agent-settings';
import type { CoordinatorRunRecord } from '@alpacawork/contract/run';
import { isUnfinished } from '@alpacawork/runs';

export type Continuation = {
  continued: CoordinatorRunRecord;
  /** The continued Run's own values, a waiting one's included: the conversation's latest choice. */
  previous: { adapter: string; values: Selection };
};
/**
 * What the conversation goes on from: its last Run that got going (succeeded, or not yet ended) and has a session or
 * will have one. A failed or stopped Run establishes no session, so the one before it stands. Null: the next message
 * starts a new session with a new selection. The screen's agent and previous values (conversation-view.ts) and
 * admission (conversation.ts) both read this one answer, so the screen offers to go on exactly when serve would.
 */
export function resumable(runs: readonly CoordinatorRunRecord[]): Continuation | null {
  const last = runs.filter(run => run.state === 'succeeded' || isUnfinished(run)).at(-1);
  if (!last || last.session === null && !isUnfinished(last)) return null;
  const { adapter, values } = last.launch;
  return { continued: last, previous: { adapter, values: { ...values } } };
}
/** The continuation a message to `agent` goes on in: a session never crosses agents. */
export function continuation(runs: readonly CoordinatorRunRecord[], agent: string): Continuation | null {
  const resumed = resumable(runs);
  return resumed?.continued.agent === agent ? resumed : null;
}
