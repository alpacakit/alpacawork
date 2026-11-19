/** Persistent AVL index: edits copy a search path, so published frames keep their old values. */
interface Branch<K, V> {
  readonly key: K; readonly value: V; readonly left?: Branch<K, V>; readonly right?: Branch<K, V>;
  readonly height: number; readonly size: number;
}
const height = <K, V>(node?: Branch<K, V>) => node?.height ?? 0;
function branch<K, V>(key: K, value: V, left?: Branch<K, V>, right?: Branch<K, V>): Branch<K, V> {
  return { key, value, left, right, height: 1 + Math.max(height(left), height(right)), size: 1 + (left?.size ?? 0) + (right?.size ?? 0) };
}
function balance<K, V>(node: Branch<K, V>): Branch<K, V> {
  const { key, value, left, right } = node;
  if (height(left) > height(right) + 1) {
    const l = left!;
    if (height(l.left) < height(l.right)) {
      const pivot = l.right!;
      return branch(pivot.key, pivot.value, branch(l.key, l.value, l.left, pivot.left), branch(key, value, pivot.right, right));
    }
    return branch(l.key, l.value, l.left, branch(key, value, l.right, right));
  }
  if (height(right) > height(left) + 1) {
    const r = right!;
    if (height(r.right) < height(r.left)) {
      const pivot = r.left!;
      return branch(pivot.key, pivot.value, branch(key, value, left, pivot.left), branch(r.key, r.value, pivot.right, r.right));
    }
    return branch(r.key, r.value, branch(key, value, left, r.left), r.right);
  }
  return node;
}
export class AggregateIndex<K, V> {
  constructor(readonly compare: (a: K, b: K) => number, private readonly root?: Branch<K, V>) {}
  get size(): number { return this.root?.size ?? 0; }
  get(key: K): V | undefined {
    let node = this.root;
    while (node) { const order = this.compare(key, node.key); if (!order) return node.value; node = order < 0 ? node.left : node.right; }
    return undefined;
  }
  set(key: K, value: V): AggregateIndex<K, V> {
    const put = (node?: Branch<K, V>): Branch<K, V> => {
      if (!node) return branch(key, value);
      const order = this.compare(key, node.key);
      return balance(order < 0 ? branch(node.key, node.value, put(node.left), node.right)
        : order > 0 ? branch(node.key, node.value, node.left, put(node.right)) : branch(key, value, node.left, node.right));
    };
    return new AggregateIndex(this.compare, put(this.root));
  }
  delete(key: K): AggregateIndex<K, V> {
    const remove = (node?: Branch<K, V>): Branch<K, V> | undefined => {
      if (!node) return undefined;
      const order = this.compare(key, node.key);
      if (order < 0) return balance(branch(node.key, node.value, remove(node.left), node.right));
      if (order > 0) return balance(branch(node.key, node.value, node.left, remove(node.right)));
      if (!node.left) return node.right;
      if (!node.right) return node.left;
      let next = node.right;
      while (next.left) next = next.left;
      const dropFirst = (n: Branch<K, V>): Branch<K, V> | undefined => n.left ? balance(branch(n.key, n.value, dropFirst(n.left), n.right)) : n.right;
      return balance(branch(next.key, next.value, node.left, dropFirst(node.right)));
    };
    return new AggregateIndex(this.compare, remove(this.root));
  }
  /** Visit changed keys, skipping shared subtrees even when an AVL rotation changed their root. */
  changes(next: AggregateIndex<K, V>, visit: (key: K, before: V | undefined, after: V | undefined) => void): void {
    const split = (node: Branch<K, V> | undefined, key: K): [Branch<K, V> | undefined, V | undefined, Branch<K, V> | undefined] => {
      if (!node) return [undefined, undefined, undefined];
      const order = this.compare(key, node.key);
      if (!order) return [node.left, node.value, node.right];
      if (order < 0) { const [left, value, right] = split(node.left, key); return [left, value, branch(node.key, node.value, right, node.right)]; }
      const [left, value, right] = split(node.right, key); return [branch(node.key, node.value, node.left, left), value, right];
    };
    const diff = (before?: Branch<K, V>, after?: Branch<K, V>): void => {
      if (before === after) return;
      if (!before) { if (after) { diff(undefined, after.left); visit(after.key, undefined, after.value); diff(undefined, after.right); } return; }
      if (!after) { diff(before.left); visit(before.key, before.value, undefined); diff(before.right); return; }
      if (!this.compare(before.key, after.key)) {
        diff(before.left, after.left); if (before.value !== after.value) visit(before.key, before.value, after.value); diff(before.right, after.right); return;
      }
      const [left, value, right] = split(before, after.key);
      diff(left, after.left); if (value !== after.value) visit(after.key, value, after.value); diff(right, after.right);
    };
    diff(this.root, next.root);
  }
  first(): readonly [K, V] | undefined {
    let node = this.root; if (!node) return undefined;
    while (node.left) node = node.left;
    return [node.key, node.value];
  }
  neighbor(key: K, direction: 'before' | 'after'): readonly [K, V] | undefined {
    let node = this.root, found: Branch<K, V> | undefined;
    while (node) {
      const order = this.compare(node.key, key);
      if (direction === 'before' ? order < 0 : order > 0) { found = node; node = direction === 'before' ? node.right : node.left; }
      else node = direction === 'before' ? node.left : node.right;
    }
    return found && [found.key, found.value];
  }
  *entries(): IterableIterator<readonly [K, V]> {
    const stack: Branch<K, V>[] = []; let node = this.root;
    while (node || stack.length) {
      while (node) { stack.push(node); node = node.left; }
      node = stack.pop()!; yield [node.key, node.value]; node = node.right;
    }
  }
}
export const compareKey = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const keyedIndex = <V>() => new AggregateIndex<string, V>(compareKey);
