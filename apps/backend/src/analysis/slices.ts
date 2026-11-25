import { performance } from 'node:perf_hooks';

/**
 * Long counting work in serve gives the event loop back every slice (about 50 ms of work), so serve answers while the
 * analysis reads its facts or makes its days: no request waits behind more than one slice. 50 ms keeps a slice short
 * against a person's sense of a pause and the work's own cost of resuming small (measured: work/perf/README.md).
 */
export const SLICE_MS = 50;
export class Slices {
  private until = performance.now() + SLICE_MS;
  /** Whether this slice is spent: the caller gives the loop back (`pause`) at a point where its state is whole. */
  get due() { return performance.now() >= this.until; }
  async pause() {
    await new Promise(resolve => setImmediate(resolve));
    this.until = performance.now() + SLICE_MS;
  }
}

/** A few of the latest values by key: reading one makes it the latest; past `size` the least recent goes. */
export class Kept<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly size: number) {}
  get(key: K) {
    const value = this.map.get(key);
    if (value !== undefined) { this.map.delete(key); this.map.set(key, value); }
    return value;
  }
  set(key: K, value: V) {
    this.map.delete(key); this.map.set(key, value);
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value!);
  }
  delete(key: K) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get count() { return this.map.size; }
  values() { return this.map.values(); }
}
