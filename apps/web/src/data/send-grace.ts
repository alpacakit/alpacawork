import { create } from 'zustand';
import { endUndoOffer, offerUndo, type UndoOffer } from './undo-offers';
import { recordFailure } from '@/lib/notify';

export const WRITE_GRACE_MS = 3000;
declare global { interface Window { __ALPACAWORK_WRITE_GRACE_MS__?: number } }
export const writeGraceMs = () => typeof window === 'undefined' ? 0 : window.__ALPACAWORK_WRITE_GRACE_MS__ ?? WRITE_GRACE_MS;
export type CancelResult = 'cancelled' | 'already_dispatched' | 'gone';
type Grace = { id: string; until: number; document: Document; start: (keepalive: boolean, leaving: boolean) => void; cancel: () => CancelResult };
const waiting = new Map<string, Grace>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** A deadline changes delivery eligibility even when no React input or saved request changes. */
export const useSendGrace = create(() => ({ revision: 0 }));
export const graceReady = (until: number | undefined) => until === undefined || until <= Date.now();
export function endSendGrace(id: string) {
  waiting.delete(id); endUndoOffer(id); schedule();
}
function release(grace: Grace, keepalive: boolean, leaving = false) {
  // End the offer before calling a sender, which may synchronously publish its next state.
  waiting.delete(grace.id); endUndoOffer(grace.id);
  try { grace.start(keepalive, leaving); } catch (error) { recordFailure(error, 'start admitted write'); }
}
function schedule() {
  clearTimeout(timer);
  const until = Math.min(...[...waiting.values()].map(each => each.until));
  if (Number.isFinite(until)) timer = setTimeout(expire, Math.max(0, until - Date.now()));
}
function expire() {
  for (const grace of [...waiting.values()]) if (graceReady(grace.until)) release(grace, false);
  useSendGrace.setState(state => ({ revision: state.revision + 1 }));
  schedule();
}
/** One lifecycle rule for both senders. Hidden time never holds a request on the device. */
export function flushSendGrace(document: Document, keepalive = false, leaving = false) {
  for (const grace of [...waiting.values()]) if (grace.document === document) release(grace, keepalive, leaving);
  useSendGrace.setState(state => ({ revision: state.revision + 1 }));
  schedule();
}
const attached = new WeakSet<Document>();
function attach(document: Document) {
  if (attached.has(document)) return;
  attached.add(document);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSendGrace(document, true); });
  document.defaultView?.addEventListener('pagehide', () => flushSendGrace(document, true, true));
}
/** Resuming registers a clock but never creates a new offer. Only a local successful press supplies `offer`. */
export function holdSendGrace(grace: Grace, offer?: Omit<UndoOffer, 'undo'>) {
  attach(grace.document);
  waiting.set(grace.id, grace);
  if (offer) offerUndo({ ...offer, undo: async () => {
    // What can be taken back is what is still waiting here, the same fact that keeps its offer (and its button) up:
    // release ends both at once. The clock only says when release runs, so a press that lands past `until` before it
    // does (a tap queued behind a busy page goes ahead of the overdue timer) still finds nothing sent.
    const current = waiting.get(grace.id);
    if (!current) return 'already_dispatched';
    const result = current.cancel();
    if (result === 'cancelled' || result === 'gone') endSendGrace(grace.id);
    return result;
  } });
  schedule();
  if (grace.document.hidden) flushSendGrace(grace.document, true);
}
