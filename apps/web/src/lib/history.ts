/**
 * The browser's history has one writer and one order: every change of what the URL shows is an intent given
 * here (`navigate`), and only this module writes a step (`pushStep`, `replaceStep`), moves to one (`traverse`, `goBack`)
 * or tells a person's Back from the page's own move. The screen that shows the URL attaches itself (`attachScreen`,
 * state/bootstrap.ts): it makes an intent's changes into the URL (`change`) and shows the URL where the browser is
 * (`show`). One rule for every intent:
 * - Settled, it applies at once, and the URL and the screen are one when it returns.
 * - While the page's own move is under way (a surface's ×, `traverse`), intents wait in the order they came, each with
 *   what it was given, and apply once the browser is there, to what is shown there.
 * - One that acts on what the reader shows (`bound`: its ×, a tab, a row, the move on after an answer) does nothing
 *   when the reader shows another task by then; one naming where to go (a row, a reference, a link, a search, a setting)
 *   always applies.
 * - What it changes is a step of its own or written over the current one as the screen decides (`change`), unless the
 *   intent says which (`write`): a link pressed is always a step of its own, the reader's Back with nothing behind
 *   it always writes over the current one.
 * - The move is there at the popstate that finds the browser on its entry (its key, by the Navigation API), whether
 *   the move's `finished` came before it or not; `finished` only says when the browser gave the move up. A popstate
 *   anywhere else is a person's own Back or Forward: where it went stands, the move and the intents waiting on it are
 *   dropped, and what is open for a moment closes (`onPersonMove`).
 */

/**
 * The part of the browser's Navigation API the page uses: the entry it stands on and those of this page it keeps, each
 * by its key, and a move to one by its key. Missing it (an old browser), the page has none of that to go by.
 */
type Navigation = {
  currentEntry: { key: string } | null;
  entries: () => { key: string }[];
  traverseTo: (key: string) => { finished: Promise<unknown> };
};
const navigationApi = (): Navigation | null => {
  const navigation = (globalThis as { navigation?: Partial<Navigation> }).navigation;
  return navigation && typeof navigation.entries === "function" && typeof navigation.traverseTo === "function" ? navigation as Navigation : null;
};

/** The key of the step the page stands on, or null without the Navigation API. */
export const currentStepKey = () => navigationApi()?.currentEntry?.key ?? null;

export type Screen = {
  /** Runs an intent's changes of the screen and writes what it then shows into the URL (as `write` says, if it says). */
  change: (run: () => void, write?: Write) => void;
  /** Shows the URL where the browser is. */
  show: () => void;
  /**
   * What the reader shows (its task, or the address it waits for): until the browser's move there is shown (its
   * popstate), still what it stood on.
   */
  shown: () => string | null;
};
let screen: Screen | null = null;
/** The screen showing the URL, while it is up. */
export function attachScreen(next: Screen) {
  screen = next;
  listen();
  // Gone, it has nothing to show a move under way or the intents waiting on it.
  return () => { if (screen !== next) return; screen = null; move = null; waiting.length = 0; };
}

/** Shows the URL where the browser is, on the screen showing it. */
export const showScreen = () => screen?.show();

/** How an intent's change is written: a step of its own, or over the current step. */
export type Write = "step" | "over";
type Intent = { run: () => void; on?: string | null; write?: Write };
type Move = { target: string; source: string | null; landed?: () => void; failed?: () => void };
/** The page's own move under way, one at a time, and the intents given meanwhile. */
let move: Move | null = null;
const waiting: Intent[] = [];
/** An intent applying: what it calls of the others is part of it. */
let depth = 0;

/** What the reader shows: what a `bound` intent acts on. Without a screen, the task the URL names. */
const shownTask = () => screen ? screen.shown() : new URLSearchParams(location.search).get("task");

/**
 * What the reader shows now, for an action on it that ends later (a page of results still to come): given as its
 * `from`, the intent then acts on the reader as it was when the action began.
 */
export const readerNow = () => ({ from: shownTask() });

/** Gives an intent: now, or once the page's own move under way is there. */
export function navigate(run: () => void, { bound = false, from, write }: { bound?: boolean; from?: string | null; write?: Write } = {}) {
  if (depth) { run(); return; }
  const on = from !== undefined ? from : bound ? shownTask() : undefined;
  const intent: Intent = { run, ...on !== undefined ? { on } : {}, ...write ? { write } : {} };
  if (move) waiting.push(intent);
  else apply(intent);
}

function apply({ run, on, write }: Intent) {
  if (on !== undefined && shownTask() !== on) return;
  depth++;
  try { if (screen) screen.change(run, write); else run(); } finally { depth--; }
}

function drain() {
  while (!move && waiting.length) apply(waiting.shift()!);
}

/** Writes a step of its own over the current one, or writes over the current one. */
export function pushStep(state: unknown, url: string | URL) { history.pushState(state, "", url); }
export function replaceStep(state: unknown, url: string | URL) { history.replaceState(state, "", url); }
/** The browser's own Back, asked for by the page (the reader's Back to the place it left). */
export function goBack() { history.back(); }

/**
 * Goes to the step `key` as the page's own move (a surface closing), then `landed` applies there: what is open for a
 * moment stays. When the browser cannot (no Navigation API, that step no longer kept, the move given up while the page
 * still stands where it was), `failed` applies where the page is instead.
 */
export function traverse(key: string, landed?: () => void, failed?: () => void) {
  const navigation = navigationApi();
  if (move || !navigation?.entries().some((entry) => entry.key === key)) { failed?.(); return; }
  const current: Move = move = { target: key, source: currentStepKey(), landed, failed };
  listen();
  navigation.traverseTo(key).finished.catch(() => {
    // Given up. Moved on meanwhile, the popstate says where to (a person's own move); still here, `failed` applies.
    if (move !== current || currentStepKey() !== current.source) return;
    move = null;
    if (current.failed) apply({ run: current.failed });
    drain();
  });
}

function arrive(done: Move) {
  move = null;
  screen?.show();
  // The move's own outcome first (a URL opened straight on the surface written without it), then the intents given
  // meanwhile, in turn.
  if (done.landed) apply({ run: done.landed });
  drain();
}

const personMoves = new Set<() => void>();
/** Calls `listener` on every move of a person's own (Back, Forward), not on the page's own. */
export function onPersonMove(listener: () => void) {
  listen();
  personMoves.add(listener);
  return () => { personMoves.delete(listener); };
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  addEventListener("popstate", () => {
    const done = move;
    if (done && currentStepKey() === done.target) { arrive(done); return; }
    move = null;
    waiting.length = 0;
    screen?.show();
    for (const listener of [...personMoves]) listener();
  });
}
