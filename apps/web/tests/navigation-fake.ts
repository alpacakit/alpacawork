import { vi } from "vitest";

/**
 * The part of the browser's Navigation API the page uses (lib/history.ts), over jsdom's own session history, which has
 * none, as the standard says it goes: each entry's key; the entries kept; a move to an entry by its key, which finds the
 * entry when it runs (not when asked), is the same move when asked again for the same key while under way, and whose
 * `finished` settles once the browser stands there (its popstate has come). A move of the person's own meanwhile (a
 * popstate the move did not make) gives it up. `delay` holds the move back, as a slow browser does; `refuse` gives the
 * move up; `abortPending` gives up the one under way. `held` leaves each move to the test (`moves`, `arrive`):
 * `finishedFirst` there says `finished` once the browser stands on the entry and before its popstate, as Chromium may.
 * A page outside the app is an entry with no state of the page's.
 */
export function fakeNavigation({ delay = 0, refuse = false, held = false } = {}) {
  const session = (window as unknown as { _sessionHistory: { _entries: object[]; _currentIndex: number;
    traverseHistory: (entry: object, flags: { nonBlockingEvents: boolean }) => void } })._sessionHistory;
  const keys = new WeakMap<object, string>();
  let next = 0;
  const keyOf = (entry: object) => { if (!keys.has(entry)) keys.set(entry, `k${next++}`); return keys.get(entry)!; };
  type Move = { key: string; finished: Promise<void>; resolve: () => void; reject: (error: Error) => void };
  let pending: Move | null = null;
  let going = false;
  const moves: Move[] = [];
  addEventListener("popstate", () => {
    if (going || !pending) return;
    const move = pending;
    pending = null;
    move.reject(new DOMException("a move of the person's own", "AbortError"));
  });
  /** Moves to the entry `move` names now: its popstate, and then its `finished` (or first, with `finishedFirst`). */
  const go = (move: Move, finishedFirst = false) => {
    if (pending === move) pending = null;
    const at = session._entries.findIndex((entry) => keyOf(entry) === move.key);
    if (at < 0) { move.reject(new DOMException("gone", "InvalidStateError")); return Promise.resolve(); }
    const delta = at - session._currentIndex;
    if (!delta) { move.resolve(); return Promise.resolve(); }
    going = true;
    return new Promise<void>((done) => {
      addEventListener("popstate", () => { going = false; if (!finishedFirst) setTimeout(move.resolve); setTimeout(done, 1); }, { once: true });
      // The browser stands on the entry (its URL, state and key) and says finished before the popstate's task comes.
      if (finishedFirst) { session.traverseHistory(session._entries[at]!, { nonBlockingEvents: true }); move.resolve(); }
      else history.go(delta);
    });
  };
  const navigation = {
    get currentEntry() { return { key: keyOf(session._entries[session._currentIndex]!), index: session._currentIndex }; },
    entries: () => session._entries.map((entry, index) => ({ key: keyOf(entry), index })),
    traverseTo(key: string) {
      if (pending?.key === key) return { finished: pending.finished };
      let resolve!: () => void, reject!: (error: Error) => void;
      const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const move: Move = { key, finished, resolve, reject };
      if (refuse) { reject(new DOMException("refused", "AbortError")); return { finished }; }
      pending = move;
      moves.push(move);
      if (!held) setTimeout(() => { if (pending === move) void go(move); }, delay);
      return { finished };
    },
    abortPending() {
      const move = pending;
      pending = null;
      move?.reject(new DOMException("aborted", "AbortError"));
    },
    moves,
    arrive: (move: Move, { finishedFirst = false } = {}) => go(move, finishedFirst),
  };
  vi.stubGlobal("navigation", navigation);
  return navigation;
}

/** jsdom's session history from one entry, keeping at most `limit` (Chromium: 50), the oldest dropped on a push. */
export function sessionHistory(limit = Infinity) {
  const session = (window as unknown as { _sessionHistory: { _entries: object[]; _currentIndex: number; currentEntry: object } })._sessionHistory;
  session._entries = [session.currentEntry];
  session._currentIndex = 0;
  if (limit === Infinity) return session;
  const push = history.pushState.bind(history);
  vi.spyOn(history, "pushState").mockImplementation((...args) => {
    push(...args);
    while (session._entries.length > limit) { session._entries.shift(); session._currentIndex--; }
  });
  return session;
}
