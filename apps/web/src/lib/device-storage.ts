import { useSyncExternalStore } from "react";

/** A browser preference: one registered owner for decoding, caching, I/O and change notification. */
export type DeviceValue<T> = {
  get: () => T;
  /** A denied write still holds for this visit. Callers may distinguish it from a durable write. */
  set: (value: T) => "stored" | "memory";
  remove: () => "stored" | "memory";
  subscribe: (notify: () => void) => () => void;
};
type Codec<T> = { read: (raw: string) => T | null; write: (value: T) => string };
const entries = new Map<string, { refresh: () => void }>();

export function deviceValue<T>(key: `alpacawork.${string}`, codec: Codec<T>, fallback: T): DeviceValue<T> {
  if (entries.has(key)) throw new Error(`Device preference already registered: ${key}`);
  let initialized = false, raw: string | null = null, value = fallback, memory = false;
  const listeners = new Set<() => void>();
  // A read can expose an intermediate value to one subscriber. Keep that observation pending
  // until publication, even if the value returns to its original value in the meantime.
  let pending = false;
  const adopt = (next: T) => {
    if (Object.is(value, next)) return;
    value = next;
    if (listeners.size > 0) pending = true;
  };
  const decode = (next: string | null): T => {
    if (next === null) return fallback;
    try { return codec.read(next) ?? fallback; } catch { return fallback; }
  };
  const read = () => {
    let next: string | null;
    try { next = localStorage.getItem(key); } catch { return; }
    // Keep a refused write in memory until another writer changes the durable value.
    if (!initialized || next !== raw) {
      adopt(decode(next)); raw = next; initialized = true; memory = false;
    }
    if (listeners.size === 0) pending = false;
  };
  const publish = () => {
    if (!pending) return;
    pending = false;
    for (const listener of listeners) listener();
  };
  const refresh = () => { read(); publish(); };
  const write = (next: string | null): "stored" | "memory" => {
    read();
    // Decoding our own encoding keeps this visit and a reload on the same contract.
    const kept = initialized && !memory && raw === next ? value : decode(next);
    let result: "stored" | "memory" = "stored";
    try {
      if (next === null) localStorage.removeItem(key); else localStorage.setItem(key, next);
      raw = next; memory = false;
    } catch { memory = true; result = "memory"; }
    adopt(kept); initialized = true;
    publish();
    return result;
  };
  entries.set(key, { refresh });
  return { get: () => { read(); return value; }, set: (next) => write(codec.write(next)), remove: () => write(null),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

export function jsonCodec<T>(check: (value: unknown) => T | null): Codec<T> {
  return { read: (raw) => check(JSON.parse(raw)), write: JSON.stringify };
}
export const useDeviceValue = <T,>(setting: DeviceValue<T>): T => useSyncExternalStore(setting.subscribe, setting.get, setting.get);

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    // Accessing the storage property itself can be denied, too.
    try { if (event.storageArea !== null && event.storageArea !== localStorage) return; } catch { return; }
    if (event.key === null) for (const entry of entries.values()) entry.refresh();
    else entries.get(event.key)?.refresh();
  });
  const refresh = () => { for (const entry of entries.values()) entry.refresh(); };
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
}
