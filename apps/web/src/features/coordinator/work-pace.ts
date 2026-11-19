/**
 * The one pace of the coordinator's work words. Serve says which recent work applies now (its name, or none; its count is
 * not shown, so a repeat of the same work is no change);
 * this alone decides when the screen changes to it: whatever is on screen stays for HOLD_MS from when it reached the
 * DOM, values that come meanwhile are dropped for the latest, and a turn that ends, work of another turn or
 * conversation, or a lost connection goes back to the turn's own words at once. Every place that shows the words reads one pacer per
 * workspace store, so opening or folding the conversation neither restarts nor splits the hold.
 */
import type { WorkName } from '@alpacawork/contract/run';
import type { WorkspaceStore } from '@/data/workspace-store';
import { useConnection } from '@/data/connection';
import { useConversation } from './coordinator';

export const HOLD_MS = 2_000;

/** `key` names the running turn the words belong to (null: none, or offline); `label` null is the turn's own words. */
export type Pace = { readonly key: string | null; readonly label: WorkName | null; readonly version: number };
export const paceKey = (conversation: string, turn: string) => `${conversation}\u0000${turn}`;

export class WorkPacer {
  private pace: Pace = { key: null, label: null, version: 0 };
  /** When the shown pace first reached the DOM; null until a place showing it commits. */
  private shownAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private stopSources: (() => void) | undefined;

  constructor(private readonly store: WorkspaceStore, private readonly now: () => number = () => Date.now()) {}

  readonly snapshot = (): Pace => this.pace;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.stopSources) {
      const unsubscribers = [this.store.subscribe(this.evaluate), useConversation.subscribe(this.evaluate), useConnection.subscribe(this.evaluate)];
      this.stopSources = () => unsubscribers.forEach(stop => stop());
      this.evaluate();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      // Nobody shows the words: stop listening and waking, but keep what is shown and since when for the next place.
      this.stopSources?.(); this.stopSources = undefined;
      clearTimeout(this.timer); this.timer = undefined;
    };
  };

  /** A place drew `version` into the DOM: the hold of that pace starts at the first such commit. */
  committed(version: number): void {
    if (version !== this.pace.version || this.shownAt !== null) return;
    this.shownAt = this.now();
    this.evaluate();
  }

  private readonly evaluate = (): void => {
    // The feed says online only with a current snapshot (a resumed stream is live once open): that is trusted as is.
    const { offline } = useConnection.getState();
    const conversation = useConversation.getState().conversation;
    const turn = offline ? undefined : conversation?.turns.filter(turn => turn.status === 'running').at(-1);
    const key = conversation && turn ? paceKey(conversation.id, turn.id) : null;
    if (key !== this.pace.key) { this.show(key, null); return; }
    if (key === null) return;
    const work = this.store.getState().info.coordinatorWork;
    // Work of another turn or conversation says nothing of this one: like an ending, it is not held.
    if (work && paceKey(work.conversation, work.turn) !== key) { if (this.pace.label) this.show(key, null); return; }
    const target = work?.name ?? null;
    clearTimeout(this.timer); this.timer = undefined;
    if (target === this.pace.label || this.shownAt === null) return;
    const left = this.shownAt + HOLD_MS - this.now();
    if (left <= 0) this.show(key, target);
    else this.timer = setTimeout(this.evaluate, left);
  };

  private show(key: string | null, label: WorkName | null): void {
    clearTimeout(this.timer); this.timer = undefined;
    this.pace = { key, label, version: this.pace.version + 1 };
    this.shownAt = null;
    for (const listener of this.listeners) listener();
  }
}

const pacers = new WeakMap<WorkspaceStore, WorkPacer>();
/** One pacer per workspace store: a new workspace starts its own, and the old one goes with its store. */
export function workPacer(store: WorkspaceStore): WorkPacer {
  let pacer = pacers.get(store);
  if (!pacer) pacers.set(store, pacer = new WorkPacer(store));
  return pacer;
}
