/**
 * Which session a coordinator message to an agent goes on in, and the conversation's previous values for it. One rule
 * for admission (conversation.ts) and for the screen's previousValues (conversation-view.ts), so what the screen shows
 * as the conversation's values is what an omitted choice keeps.
 */
import type { Selection } from '@alpacawork/contract/agent-settings';
import type { CoordinatorRunRecord } from '@alpacawork/contract/run';
import { isUnfinished } from '@alpacawork/runs';

/**
 * The Run whose session a message to `agent` goes on in: the conversation's last Run that succeeded or has not ended,
 * when it is that agent's. A failed or stopped one establishes no session to resume, so the one before it stands;
 * a session never crosses agents.
 */
function sessionHead(runs: readonly CoordinatorRunRecord[], agent: string): CoordinatorRunRecord | null {
  const last = runs.filter(run => run.state === 'succeeded' || isUnfinished(run)).at(-1);
  return last?.agent === agent ? last : null;
}
export type Continuation = {
  continued: CoordinatorRunRecord;
  /** The continued Run's own values, a waiting one's included: the conversation's latest choice. */
  previous: { adapter: string; values: Selection };
};
/** null: the next message to `agent` starts a new session with a new selection. */
export function continuation(runs: readonly CoordinatorRunRecord[], agent: string): Continuation | null {
  const before = sessionHead(runs, agent);
  const continued = before !== null && (before.session !== null || isUnfinished(before)) ? before : null;
  if (!continued) return null;
  const { adapter, values } = continued.launch;
  return { continued, previous: { adapter, values: { ...values } } };
}
