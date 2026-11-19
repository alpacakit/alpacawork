import { create } from 'zustand';

/**
 * The presses this page can still take back: each is a saved operation that waits out its grace before it is
 * sent (send-grace.ts, with the sender’s saved deadline). Only the page the press was made in holds its offer, from the moment
 * the operation was admitted; it is never made again when the operation is later taken from the queue, resent or seen
 * from another tab. The delivery owner adds and ends offers; the toast only draws them (features/undo).
 */
export type UndoOffer = {
  /** The saved operation's ID. */
  id: string;
  /** What the press did, said as done ("Put T416 on hold") or, for words not yet sent, as sent ("Sent"). */
  text: string;
  /** success: the screen already shows it (a card left); info: nothing has gone yet (a message). */
  mark: 'success' | 'info';
  /** Where it was pressed: the window the toast is drawn in (lib/notify's `from`). */
  from?: Document | Window | Element | string | null;
  /** Epoch ms: admitted, and when its grace ends and it goes. Never extended. */
  at: number;
  until: number;
  /** Said once it is taken back: what was undone ("Send cancelled"). */
  undone?: string;
  /** Takes it back if it has not started to go. */
  undo: () => Promise<'cancelled' | 'already_dispatched' | 'gone'>;
};

/** Oldest first. An offer leaves when its grace ends, it starts to go, it is taken back, or the page is hidden. */
export const useUndoOffers = create<{ offers: readonly UndoOffer[] }>(() => ({ offers: [] }));

export function offerUndo(offer: UndoOffer) {
  useUndoOffers.setState(state => ({ offers: [...state.offers.filter(each => each.id !== offer.id), offer] }));
}
export function endUndoOffer(id: string) {
  useUndoOffers.setState(state => state.offers.some(each => each.id === id) ? { offers: state.offers.filter(each => each.id !== id) } : state);
}
