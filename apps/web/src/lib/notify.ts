import { countUse } from '@/features/telemetry/count';
import type { ReactNode } from "react";
import { create } from "zustand";
import { describeProblem } from "@/features/forms/problem-text";
import { ApiError } from "@/data/client";

/**
 * The one owner of the screen's toasts: what an operation came to, or a failure the person did not see happen.
 * A caller says what happened (the kind and the words) and where it was done; this module alone decides how long each
 * stands, which one gives way when too many come, what replaces what, and which window shows it. components/ui/toaster
 * only draws what is here. What lasts (the connection, a read-only workspace, a draft that cannot be stored) is said by
 * the places that show that state (ProgressLine, WorkspaceNotice, the input's own line), not here.
 *
 * - success: a change the screen does not show by itself (saved where nothing on screen moved, copied, undoable).
 * - error: it failed, or its result is not known (said as unknown: never as failed when it may have been written).
 * - info: neither (a limit was met, nothing was heard).
 * - pending: a check under way that will be replaced in place by its result.
 *
 * The one rule for how long a toast stands is its kind, never the caller: what leaves the person something still
 * to do or to find out (error: redo it, check it; pending: wait for its result) stays until × or its owner ends it;
 * what is only to be read (success, info, a way back such as Undo while it is offered) goes by itself, after the
 * time it takes to read (see lifeOf), and shows the time it has left as a line at its foot that stops while it is
 * pointed at, focused or its window hidden.
 *
 * One toast is its owner's to keep (`kept`): a way back open only until a time the owner holds (an undo offer).
 * Nothing here takes it away (its owner republishes and dismisses it), nothing crowds it out, holds it back under a
 * dialog or keeps it out of a hold, and its line (`line`) runs out at its owner's time, which nothing here stops: the
 * same line as a clock's, run by another time.
 */
export type ToastKind = "success" | "error" | "info" | "pending";
type ToastAction = { label: string; run: () => void };
export type ToastOptions = {
  /** Replacement slot. Reusing a slot for a new one-off notice does not inherit a previous dismissal. */
  id?: string;
  /** An owner will republish this same event until it ends. Supply its event ID; finish without ongoing, or dismiss. */
  ongoing?: boolean;
  /** A second, smaller line: what to change, a refusal's own reason. */
  detail?: ReactNode;
  action?: ToastAction;
  /**
   * Where the press was: the toast is shown in that window (the coordinator's own window, or the app's). A name is a
   * part that can move between windows (`coordinator`): the window it is drawn in now.
   */
  from?: Document | Window | Element | string | null;
  /** Its owner keeps it and takes it away (with `ongoing`), see above. */
  kept?: boolean;
  /** The time its owner's way back has left, drawn as its line: from `at` to `until` (epoch ms). */
  line?: ToastLine;
};
type ToastLine = { at: number; until: number };
export type Toast = {
  id: string; kind: ToastKind; text: ReactNode; detail?: ReactNode; action?: ToastAction;
  /**
   * Stays until hidden, replaced or ended (its kind says so, or its owner keeps it); otherwise it goes once its life
   * has run.
   */
  stays: boolean; kept: boolean; line?: ToastLine; ongoing: boolean; at: Document;
  /**
   * `order`: where it stands, kept when it is replaced. `came`: when what it says came, new with each new event in its
   * slot, kept only while its owner republishes the same ongoing event.
   */
  order: number; came: number;
};
/**
 * The time a toast has left, as drawn (TimeLeft): its whole life, what is left, whether it runs, and `drawn`, a mark of
 * its own that changes each time it is drawn again. A clock's runs only while its toast is read undisturbed; an owner's
 * line always runs.
 */
export type ToastTime = { life: number; left: number; running: boolean; drawn: number };

const staysOf = (kind: ToastKind) => kind === "error" || kind === "pending";
/**
 * How long what goes by itself stands, one rule from what it is and how much it says, never set by a caller:
 * - at least, by what it asks of the person: a success confirms what they just did and is only glanced at (4s); a
 *   notice tells what they did not expect (6s); a way back (Undo, Try again) needs time to decide and reach (8s).
 * - and longer with more to read, counted on the words drawn (text and detail, not its buttons): a second to look up
 *   at it and about 100ms a character (some 10 a second, reading Japanese), up to 15s.
 * Pointed at, focused or hidden, it does not run, so a slow reader is never cut off: these are the least, not a limit.
 */
const LEAST = { success: 4000, info: 6000 } as const;
const WAY_BACK = 8000, LOOK = 1000, PER_CHAR = 100, MOST = 15_000;
/**
 * Shown at once in one window, besides what stays: what stays (a way back) is always shown, and at least one of the
 * rest besides it, so news never hides behind it.
 */
export const SHOWN = 3;

/** `life`: all it stands; `left`: what it has left; `since`: when it last began to run (null: not running). */
type Clock = { life: number; left: number; since: number | null };
const clocks = new Map<string, Clock>();
const attached = new Map<Document, { count: number; name?: string }>();
let order = 0, drawn = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * `held`: the windows whose toasts are pointed at or have the focus (components/ui/toaster.tsx says which), with the
 * toasts shown there when the hold began. `covered`: the windows a dialog is open in (components/ui/dialog.tsx says
 * so), counted, with the newest toast's order when the first of them opened. `time`: each clock as last drawn.
 */
type State = { toasts: Toast[]; held: ReadonlyMap<Document, ReadonlySet<string>>;
  covered: ReadonlyMap<Document, { count: number; order: number }>; time: ReadonlyMap<string, ToastTime>;
  /** Hidden ongoing event IDs only, released when their owner ends the event; never persisted. */
  hidden: ReadonlySet<string> };
export const useToasts = create<State>(() => ({ toasts: [], held: new Map(), covered: new Map(), time: new Map(), hidden: new Set() }));

/** `chars`: the characters its words are drawn in (components/ui/toaster reads them), 0 before they are drawn. */
function lifeOf(toast: Toast, chars: number) {
  if (toast.stays) return Infinity;
  return Math.max(LEAST[toast.kind as keyof typeof LEAST], toast.action ? WAY_BACK : 0, Math.min(MOST, LOOK + chars * PER_CHAR));
}
/** A window this module draws in; any other (closed, or never drawn in) is the app's own. */
export function surfaceOf(from: ToastOptions["from"]): Document {
  if (typeof from === "string") return [...attached].find(([, surface]) => surface.name === from)?.[0] ?? document;
  const at = !from ? document : "document" in from ? from.document : "ownerDocument" in from && from.ownerDocument ? from.ownerDocument : from as Document;
  return attached.has(at) ? at : document;
}
/**
 * The one rule for what a window shows, in the order they came. Every toast that has not been hidden and stays is
 * shown, except that while a dialog or the image viewer covers the window, what stayed from before it opened waits for
 * it to close, kept, so the page's leftovers never stand over a dialog's fields; what comes while it is open (a new
 * event, even in an old slot or in the same words) is about what is done there, and is shown over it. Of the rest, the
 * newest first, as many as leave SHOWN in all, and never fewer than one. While the window is held nothing moves: what
 * was shown when the hold began is shown still (what it says may be replaced in place), nothing is taken away, and
 * nothing else comes in until it is let go, whatever it is and wherever it stood (a toast coming in would move the one
 * under the pointer, and a press meant for it would land on another). What its owner keeps is shown however it stands:
 * its way back is open only until its owner's time (while held, it comes in under the rest, so nothing there moves).
 * The clocks run only for what is shown, and what would go by itself and is not shown goes once the window is not
 * held (see tick).
 */
export function shownOf(state: State, at: Document): Toast[] {
  const covered = state.covered.get(at)?.order;
  const here = state.toasts.filter(toast => toast.at === at && (toast.kept || !(covered !== undefined && toast.stays && toast.came <= covered)));
  const held = state.held.get(at);
  if (held) return here.filter(toast => held.has(toast.id) || toast.kept);
  const staying = here.filter(toast => toast.stays);
  const rest = here.filter(toast => !toast.stays).sort((a, b) => b.order - a.order)
    .slice(0, Math.max(1, SHOWN - staying.length));
  return here.filter(toast => staying.includes(toast) || rest.includes(toast));
}
/**
 * One timer for all: what is not shown goes, every clock that should run runs, and it wakes at the next end. A clock
 * is drawn again (`time`) only when it starts or stops: while it runs, its line runs out by itself at the same end.
 */
function tick() {
  clearTimeout(timer);
  const now = performance.now(), state = useToasts.getState();
  const shown = new Set([...new Set(state.toasts.map(toast => toast.at))].flatMap(at => shownOf(state, at)).map(toast => toast.id));
  const going: string[] = [];
  const time = new Map<string, ToastTime>();
  let next = Infinity;
  for (const toast of state.toasts) {
    if (toast.line) {
      // Its owner's time: drawn once from where it stands now, and it runs whatever happens here.
      const was = state.time.get(toast.id);
      time.set(toast.id, was ?? { life: toast.line.until - toast.line.at, left: Math.max(0, toast.line.until - Date.now()), running: true, drawn: ++drawn });
      continue;
    }
    const clock = clocks.get(toast.id);
    if (!clock || clock.life === Infinity) continue;
    if (clock.since !== null) { clock.left -= now - clock.since; clock.since = null; }
    if (clock.left <= 0 || !shown.has(toast.id) && !state.held.has(toast.at)) { going.push(toast.id); continue; }
    const running = shown.has(toast.id) && !state.held.has(toast.at) && !toast.at.hidden;
    if (running) { clock.since = now; next = Math.min(next, clock.left); }
    const was = state.time.get(toast.id);
    const same = was && was.life === clock.life && was.running === running && (running || was.left === clock.left);
    time.set(toast.id, same ? was : { life: clock.life, left: clock.left, running, drawn: ++drawn });
  }
  if (going.length) { remove(going); return; }
  if (time.size !== state.time.size || [...time].some(([id, each]) => state.time.get(id) !== each)) useToasts.setState({ time });
  if (next !== Infinity) timer = setTimeout(tick, next);
}
/**
 * The one way a toast goes: its clock, and its place in what a hold keeps shown, go with it, so a new one in the same
 * slot is new to a hold that began before it.
 */
function remove(ids: string[]) {
  if (!ids.length) return;
  for (const id of ids) clocks.delete(id);
  useToasts.setState(state => ({ toasts: state.toasts.filter(toast => !ids.includes(toast.id)),
    held: new Map([...state.held].map(([at, shown]) => [at, new Set([...shown].filter(id => !ids.includes(id)))])) }));
  tick();
}

function release(id: string) {
  if (!useToasts.getState().hidden.has(id)) return;
  useToasts.setState(state => { const hidden = new Set(state.hidden); hidden.delete(id); return { hidden }; });
}

/** Returns the accepted notification id, or undefined when this ongoing event was hidden. */
function show(kind: ToastKind, text: ReactNode, options: ToastOptions = {}) {
  const id = options.id ?? (typeof text === "string" ? `${kind}:${text}` : `toast:${++order}`);
  const state = useToasts.getState();
  const ongoing = !!options.ongoing;
  if (state.hidden.has(id)) {
    // A final result consumes the hidden event too, without bringing its card back.
    if (!ongoing) release(id);
    return;
  }
  const was = state.toasts.find(toast => toast.id === id);
  const came = was?.ongoing && ongoing ? was.came : ++order;
  const kept = !!options.kept, line = options.line;
  const toast: Toast = { id, kind, text, detail: options.detail, action: options.action, stays: kept || staysOf(kind), kept, line,
    ongoing, at: surfaceOf(options.from), order: was?.order ?? came, came };
  const life = lifeOf(toast, 0);
  clocks.set(id, { life, left: life, since: null });
  // Replaced, its clock begins again: what was drawn of the one before is not this one's, unless it is the same owner's
  // time going on.
  const time = new Map(state.time);
  if (!(line && was?.line?.at === line.at && was.line.until === line.until)) time.delete(id);
  // Drawn newest first: what is kept and comes while the window is held goes under the rest, so nothing there moves.
  const under = !was && kept && state.held.has(toast.at);
  useToasts.setState(state => ({ time,
    toasts: was ? state.toasts.map(other => other.id === id ? toast : other) : under ? [toast, ...state.toasts] : [...state.toasts, toast] }));
  tick();
  return id;
}

/**
 * The one record of a failure: a refusal (serve answered: an expected outcome) as a warning, anything else (no answer,
 * a fault in this screen) as an error, with its cause chain as it was thrown. Every place that says a failure (a toast
 * here, a form's or a list's own line, a reader's recovery) records it, and a failure passed on from one to the next
 * (rethrown, wrapped as another's cause, read again) is recorded once: the first place's words for it (`about`) stand.
 */
const recorded = new WeakSet<object>();
export function recordFailure(error: unknown, about: string) {
  const chain: object[] = [];
  for (let at: unknown = error; typeof at === "object" && at !== null && !chain.includes(at); at = (at as { cause?: unknown }).cause) chain.push(at);
  if (chain.some(each => recorded.has(each))) return;
  for (const each of chain) recorded.add(each);
  const refusal = describeProblem(error).refusal;
  (refusal ? console.warn : console.error)(`[${about}]`, error);
  // Counted as the screen said it; a failure to record usage is not counted again.
  if (about !== 'record usage') countUse(refusal ? 'error.refused' : 'error.failed');
}

/**
 * A failure said as a toast. `text` names the operation that failed (Could not undo); it is said for a refusal or
 * a fault, but never for a result that is not known (the answer was lost after it may have landed): that is said as
 * unknown, by describeProblem, whatever the caller expected.
 */
/** Shared classification for both a single failure and a group of failed background reads. */
export const shouldNotifyFailure = (error: unknown) =>
  !(error instanceof ApiError && error.code === "network_error" && error.retry === "later");

function failure(error: unknown, options: ToastOptions & { about: string; text?: ReactNode }) {
  recordFailure(error, options.about);
  // A read with no reply has no operation result to announce. The shared connection
  // surface owns reachability; feed recovery rereads failed active resources.
  if (!shouldNotifyFailure(error)) {
    if (options.id) notify.dismiss(options.id);
    return;
  }
  const { title, detail } = describeProblem(error);
  const unknown = error instanceof ApiError && error.retry === "check";
  return show("error", unknown ? title : options.text ?? title, { ...options, detail: options.detail ?? (detail || undefined) });
}

export const notify = {
  success: (text: ReactNode, options?: ToastOptions) => show("success", text, options),
  info: (text: ReactNode, options?: ToastOptions) => show("info", text, options),
  error: (text: ReactNode, options?: ToastOptions) => show("error", text, options),
  pending: (text: ReactNode, options: ToastOptions & { id: string }) => show("pending", text, options),
  failure,
  /** Hide this event. Only owner-held events need a hidden mark retained against republication. */
  hide(id: string) {
    const state = useToasts.getState();
    const toast = state.toasts.find(toast => toast.id === id);
    if (!toast) return;
    if (toast.ongoing) useToasts.setState({ hidden: new Set([...state.hidden, id]) });
    remove([id]);
  },
  /**
   * The characters a toast's words are drawn in (components/ui/toaster), each time they change: what goes by itself
   * stands as long as they take to read (lifeOf), from when it came, so what is left grows by what they add.
   */
  read(id: string, chars: number) {
    const clock = clocks.get(id), toast = useToasts.getState().toasts.find(each => each.id === id);
    if (!clock || !toast || clock.life === Infinity) return;
    const life = lifeOf(toast, chars);
    if (life === clock.life) return;
    clock.left += life - clock.life; clock.life = life;
    tick();
  },
  /** Temporarily said elsewhere (for example a form's own Check); the event is still ongoing. */
  suspend: (id: string) => remove([id]),
  /** End the event while leaving a final, already drawn confirmation to finish its reading time. */
  end(id: string) {
    release(id);
    useToasts.setState(state => ({ toasts: state.toasts.map(toast => toast.id === id ? { ...toast, ongoing: false } : toast) }));
  },
  /** The owner has ended this event. Both its card and any hidden mark are released. */
  dismiss(id: string) { release(id); remove([id]); },
  /** Pointed at, focused or pressed: that window's clocks stop (and go on from where they were), and nothing goes. */
  hold(at: Document, on: boolean) {
    const state = useToasts.getState(), { held } = state;
    if (on === held.has(at)) return;
    const next = new Map(held);
    if (on) next.set(at, new Set(shownOf(state, at).map(toast => toast.id))); else next.delete(at);
    useToasts.setState({ held: next });
    tick();
  },
  /**
   * A dialog or the image viewer opens over a window (until the returned function): what stayed from before waits for
   * it to close (shownOf); what goes by itself, and what comes while it is open, stands over it, at its top (styles.css).
   */
  cover(at: Document) {
    const change = (by: number) => {
      const covered = new Map(useToasts.getState().covered), was = covered.get(at), count = (was?.count ?? 0) + by;
      if (count > 0) covered.set(at, { count, order: was?.order ?? order }); else covered.delete(at);
      useToasts.setState({ covered });
      tick();
    };
    change(1);
    return () => change(-1);
  },
  /**
   * A window starts drawing toasts (the app's at start, the coordinator's own while it is open). When it goes, what
   * must not be missed moves to the app's window; the rest goes with it.
   */
  attach(at: Document, name?: string) {
    attached.set(at, { count: (attached.get(at)?.count ?? 0) + 1, name });
    const visibility = () => tick();
    at.addEventListener("visibilitychange", visibility);
    tick();
    return () => {
      at.removeEventListener("visibilitychange", visibility);
      const count = (attached.get(at)?.count ?? 1) - 1;
      if (count) { attached.set(at, { count, name }); return; }
      attached.delete(at);
      if (useToasts.getState().held.has(at)) notify.hold(at, false);
      if (at === document) return;
      remove(useToasts.getState().toasts.filter(toast => toast.at === at && !toast.stays).map(toast => toast.id));
      useToasts.setState(state => ({ toasts: state.toasts.map(toast => toast.at === at ? { ...toast, at: document } : toast) }));
      tick();
    };
  },
};
