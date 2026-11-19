/** Finite HTTP work across JSON, file, upload and voice adapters; streams such as SSE stay outside. */
let pending = 0;
const listeners = new Set<() => void>();
export const requestsPending = () => pending > 0;
export function onRequestActivity(changed: () => void) {
  listeners.add(changed);
  return () => { listeners.delete(changed); };
}
export async function withRequestActivity<T>(send: () => Promise<T>): Promise<T> {
  pending++; listeners.forEach(changed => changed());
  try { return await send(); }
  finally { pending--; listeners.forEach(changed => changed()); }
}
/** Raw adapters share the same activity owner as createApi. */
export const trackedFetch: typeof fetch = (...args) => withRequestActivity(() => fetch(...args));
