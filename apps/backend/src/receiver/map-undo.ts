/** A synchronous memo update records only changed entries and can restore them if its caller throws. */
export class MapUndo {
  private readonly steps: (() => void)[] = [];

  set<K, V>(map: Map<K, V>, key: K, value: V): void {
    const had = map.has(key), previous = map.get(key);
    if (had && previous === value) return;
    this.steps.push(() => { if (had) map.set(key, previous!); else map.delete(key); });
    map.set(key, value);
  }

  delete<K, V>(map: Map<K, V>, key: K): void {
    if (!map.has(key)) return;
    const previous = map.get(key)!;
    this.steps.push(() => { map.set(key, previous); });
    map.delete(key);
  }

  rollback(): void {
    for (let index = this.steps.length - 1; index >= 0; index--) this.steps[index]!();
    this.steps.length = 0;
  }
}
