import type { HostKind } from '@alpacawork/contract';
import type { HostPressureObservation } from '../host/monitor.js';
import type { BundleAutomation } from './bundle-store.js';

type HostPressureCursor = NonNullable<BundleAutomation['hostPressureCursor']>;

const FRESH_MS = 30_000;
const REPEAT_MS = 60 * 60_000;

export type HostPressureWindow = {
  observation: HostPressureObservation;
  enteredAt: ReadonlyMap<HostKind, number>;
};

type HostPressureMatch = {
  key: string;
  episodeStart: number;
  observation: HostPressureObservation;
  kinds: HostKind[];
  cursor: HostPressureCursor;
};

type PressureSubscription = Pick<BundleAutomation, 'enabled' | 'hostPressureAfter' | 'hostPressureCursor'>;
export function matchHostPressure(automation: PressureSubscription, subscription: readonly HostKind[],
  window: HostPressureWindow | null,
  now: Date): HostPressureMatch | null {
  if (!automation.enabled || automation.hostPressureAfter === null || !window) return null;
  const { observation, enteredAt } = window;
  const { at, episodeStart } = observation;
  const after = Date.parse(automation.hostPressureAfter);
  const age = now.getTime() - at;
  if (episodeStart === null || at <= after || age < 0 || age > FRESH_MS) return null;
  const previous = automation.hostPressureCursor?.episodeStart === episodeStart ? automation.hostPressureCursor : null;
  if (previous && at < previous.observedAt) return null;
  const kinds = observation.kinds.filter(kind => subscription.includes(kind));
  if (!kinds.length) return null;

  // A sample can add multiple measures; they are one trigger for each subscribed automation.
  const entries = new Map<number, HostKind[]>();
  for (const kind of kinds) {
    const entered = enteredAt.get(kind);
    if (entered === undefined || entered <= Math.max(after, previous?.entryThrough ?? after) ||
        entered > at || now.getTime() - entered > FRESH_MS) continue;
    if (!entries.has(entered)) entries.set(entered, []);
    entries.get(entered)!.push(kind);
  }
  const entry = [...entries].sort(([a], [b]) => a - b)[0];
  if (entry) {
    const [entered, matched] = entry;
    return { key: `entry:${episodeStart}:${entered}`, episodeStart, observation, kinds: matched,
      cursor: { episodeStart, entryThrough: entered, observedAt: at } };
  }
  if (previous && at - previous.observedAt < REPEAT_MS) return null;
  return { key: `continuation:${episodeStart}:${at}`, episodeStart, observation, kinds,
    cursor: { episodeStart, entryThrough: previous?.entryThrough ?? null, observedAt: at } };
}
