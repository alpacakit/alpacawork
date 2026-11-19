import { countUse } from '@/features/telemetry/count';
import { i18n } from "@alpacawork/i18n";
import { useUndoOffers, type UndoOffer } from "@/data/undo-offers";
import { notify, surfaceOf, useToasts } from "@/lib/notify";

/**
 * The undo toast: one frame a window, drawn from the offers data/undo-offers holds. It shows the newest offer
 * pressed in that window in one line, and how many more there are to take back when there are more; its line runs
 * out at the offer's own time, which nothing here extends. This module ends no offer and keeps no clock of the grace:
 * the delivery owner ends offers, and the frame goes when none is left. Closing it (×, Escape, a swipe) only puts away
 * the offers that were in it; they still go on time, and only a later offer opens it again.
 *
 * While the window is held (pointed at or focused, lib/notify), the frame keeps the offer it shows, so a press lands on
 * what was pointed at: only the count moves, and an offer whose time ends there loses its button. What a press came
 * to is said in its place, without a button, while the window is held and for SAID_FOR at least (a finger or a key
 * lets go before its press is answered), so a second press never takes back a second offer.
 */
export type Said = { text: string; kind: "success" | "info"; until: number };
/** What one window's frame shows: an offer (with its button while it can still be pressed), or what a press came to. */
export type Frame = { offer: UndoOffer; open: boolean; others: number } | { said: Said; others: number } | null;
/** What a window's frame holds on to: the offer kept while held, a press under way, and what a press came to. */
type Kept = { shown?: UndoOffer; pressing?: string; said?: Said };

/** How long what a press came to stands in the frame's place at least, so a quick second press finds no button. */
export const SAID_FOR = 1000;

/** What a press came to stands while the window is held and until its time. */
const saidStands = (said: Said, held: boolean, now: number) => held || now < said.until;

/** The one rule for a window's frame, from its offers (oldest first), whether it is held, and what it holds on to. */
export function frameOf(live: readonly UndoOffer[], held: boolean, kept: Kept, now: number): Frame {
  if (kept.said && saidStands(kept.said, held, now)) return { said: kept.said, others: live.length };
  const offer = held && kept.shown ? kept.shown : live.at(-1);
  if (!offer) return null;
  const others = live.filter(each => each.id !== offer.id).length;
  return { offer, open: others < live.length && !kept.pressing, others };
}

/**
 * One window's frame between changes. `id`: its slot in notify, a new one once it is closed. `closed`: the offers it
 * was closed on; `answered`: those pressed and answered. Neither is shown again, though their owner has not ended them.
 */
type View = Kept & { id: string; closed: Set<string>; answered: Set<string>; drawn?: string };
const views = new Map<Document, View>();
let slots = 0, wake: ReturnType<typeof setTimeout> | undefined;
const newSlot = () => `undo:${++slots}`;
/** The frame goes on in a slot of its own, holding on to nothing the old one showed. */
const toNewSlot = (view: View) => Object.assign(view, { id: newSlot(), shown: undefined, said: undefined, drawn: undefined });

/** Every window's frame, again: on each change of the offers, of a window held or let go, and of a frame closed. */
function settle() {
  clearTimeout(wake);
  const toasts = useToasts.getState(), now = Date.now(), windows = new Map<Document, UndoOffer[]>();
  for (const offer of useUndoOffers.getState().offers) {
    const at = surfaceOf(offer.from);
    windows.set(at, [...windows.get(at) ?? [], offer]);
  }
  let next = Infinity;
  for (const at of new Set([...views.keys(), ...windows.keys()])) {
    const here = windows.get(at) ?? [], held = toasts.held.has(at);
    let view = views.get(at);
    if (view && surfaceOf(at) !== at) {
      // Its window went: its offers are drawn in the app's window now.
      if (view.drawn) notify.dismiss(view.id);
      views.delete(at);
      continue;
    }
    if (!view) {
      if (!here.length) continue;
      view = { id: newSlot(), closed: new Set(), answered: new Set() };
      views.set(at, view);
    }
    if (toasts.hidden.has(view.id)) {
      for (const offer of here) view.closed.add(offer.id);
      notify.dismiss(view.id);
      toNewSlot(view);
    }
    for (const set of [view.closed, view.answered]) for (const id of set) if (!here.some(offer => offer.id === id)) set.delete(id);
    const live = here.filter(offer => !view.closed.has(offer.id) && !view.answered.has(offer.id));
    if (!held) view.shown = undefined;
    if (view.said && !saidStands(view.said, held, now)) {
      if (!live.length) {
        // The last one taken back: what it came to stays where it is for its reading time, as a notice the frame
        // leaves behind; a later offer opens the frame in a new slot.
        notify[view.said.kind](view.said.text, { id: view.id, from: at });
        toNewSlot(view);
      }
      view.said = undefined;
    } else if (view.said && !held) next = Math.min(next, view.said.until);
    const frame = frameOf(live, held, view, now);
    if (held && frame && "offer" in frame) view.shown = frame.offer;
    draw(at, view, frame);
    if (!here.length && !view.drawn && !view.pressing) views.delete(at);
  }
  if (next !== Infinity) wake = setTimeout(settleOnce, next - now);
}

function draw(at: Document, view: View, frame: Frame) {
  if (!frame) {
    if (view.drawn) notify.dismiss(view.id);
    view.drawn = undefined;
    return;
  }
  const said = "said" in frame ? frame.said : undefined, offer = "offer" in frame ? frame.offer : undefined;
  const open = !!offer && "open" in frame && frame.open;
  const kind = said?.kind ?? offer!.mark, text = said?.text ?? offer!.text;
  const detail = said ? undefined : frame.others ? i18n.t("undo.toast.others", { count: frame.others }) : undefined;
  const drawn = JSON.stringify([kind, text, detail, open, offer?.id]);
  if (drawn === view.drawn) return;
  view.drawn = drawn;
  notify[kind](text, {
    id: view.id, ongoing: true, kept: true, from: at,
    detail: detail && <span className="line-clamp-2">{detail}</span>,
    action: open ? { label: i18n.t("undo.toast.undo"), run: () => { countUse('undo'); void press(at, offer!); } } : undefined,
    line: open ? { at: offer!.at, until: offer!.until } : undefined,
  });
}

/** Takes back the offer shown; the frame shows no button until it is known what that came to. */
async function press(at: Document, offer: UndoOffer) {
  const view = views.get(at);
  if (!view || view.pressing) return;
  view.pressing = offer.id;
  settleOnce();
  try {
    const result = await offer.undo();
    const [text, kind] = result === "cancelled" ? [offer.undone ?? i18n.t("undo.toast.undone"), "success" as const]
      : result === "already_dispatched" ? [i18n.t("undo.toast.sent"), "info" as const] : [i18n.t("undo.toast.gone"), "info" as const];
    view.said = { text, kind, until: Date.now() + SAID_FOR };
    view.answered.add(offer.id);
  } catch (error) {
    notify.failure(error, { about: "undo", from: at, text: i18n.t("undo.toast.failed") });
  } finally {
    view.pressing = undefined;
    // Settled only while this window's frame is still the one drawn (its window may have gone, or every toaster).
    if (watching && views.get(at) === view) settleOnce();
  }
}

/** Settles one at a time: what changes while settling (a frame dismissed) settles again after. */
let settling = false, again = false;
function settleOnce() {
  if (settling) { again = true; return; }
  settling = true;
  try { do { again = false; settle(); } while (again); } finally { settling = false; }
}

/**
 * The frames are drawn for the page's life (main.tsx starts them), in the window each offer was pressed in (lib/notify's
 * windows); stopped, they go and what they held on to with them.
 */
let watching = 0, unwatch: (() => void) | undefined;
export function watchUndoOffers() {
  if (!watching++) {
    const offers = useUndoOffers.subscribe(settleOnce);
    // A hold, a frame closed, or the toasts moved (a window gone takes its toasts to the app's): settled again, which
    // draws nothing new when nothing changed.
    const toasts = useToasts.subscribe((state, was) => {
      if (state.held !== was.held || state.hidden !== was.hidden || state.toasts !== was.toasts) settleOnce();
    });
    unwatch = () => { offers(); toasts(); clearTimeout(wake); };
  }
  settleOnce();
  return () => {
    if (--watching) { settleOnce(); return; }
    unwatch?.(); unwatch = undefined;
    for (const view of views.values()) if (view.drawn) notify.dismiss(view.id);
    views.clear();
  };
}
