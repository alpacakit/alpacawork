/** Path-copying AVL map: a publication shares every branch that its changes did not touch. */
type Node<V> = { readonly key: string; readonly value: V; readonly left?: Node<V>; readonly right?: Node<V>; readonly height: number; readonly size: number };
const height = <V>(node: Node<V> | undefined) => node?.height ?? 0;
const size = <V>(node: Node<V> | undefined) => node?.size ?? 0;
const node = <V>(key: string, value: V, left?: Node<V>, right?: Node<V>): Node<V> =>
  ({ key, value, left, right, height: 1 + Math.max(height(left), height(right)), size: 1 + size(left) + size(right) });
function balance<V>(root: Node<V>): Node<V> {
  if (height(root.left) - height(root.right) > 1) {
    let left = root.left!;
    if (height(left.right) > height(left.left)) {
      const middle = left.right!;
      left = node(middle.key, middle.value, node(left.key, left.value, left.left, middle.left), middle.right);
    }
    return node(left.key, left.value, left.left, node(root.key, root.value, left.right, root.right));
  }
  if (height(root.right) - height(root.left) > 1) {
    let right = root.right!;
    if (height(right.left) > height(right.right)) {
      const middle = right.left!;
      right = node(middle.key, middle.value, middle.left, node(right.key, right.value, middle.right, right.right));
    }
    return node(right.key, right.value, node(root.key, root.value, root.left, right.left), right.right);
  }
  return root;
}
function put<V>(root: Node<V> | undefined, key: string, value: V): Node<V> {
  if (!root) return node(key, value);
  if (key === root.key) return value === root.value ? root : node(key, value, root.left, root.right);
  return balance(key < root.key ? node(root.key, root.value, put(root.left, key, value), root.right)
    : node(root.key, root.value, root.left, put(root.right, key, value)));
}
function remove<V>(root: Node<V> | undefined, key: string): Node<V> | undefined {
  if (!root) return undefined;
  if (key < root.key) return balance(node(root.key, root.value, remove(root.left, key), root.right));
  if (key > root.key) return balance(node(root.key, root.value, root.left, remove(root.right, key)));
  if (!root.left) return root.right;
  if (!root.right) return root.left;
  let next = root.right;
  while (next.left) next = next.left;
  return balance(node(next.key, next.value, root.left, remove(root.right, next.key)));
}
function* entries<V>(root: Node<V> | undefined): Generator<[string, V]> {
  if (!root) return;
  yield* entries(root.left); yield [root.key, root.value]; yield* entries(root.right);
}
export class RecordsMap<V> implements Iterable<[string, V]> {
  constructor(private readonly root?: Node<V>) {}
  get size() { return size(this.root); }
  get(key: string): V | undefined {
    let current = this.root;
    while (current) {
      if (key === current.key) return current.value;
      current = key < current.key ? current.left : current.right;
    }
    return undefined;
  }
  has(key: string) { return this.get(key) !== undefined; }
  set(key: string, value: V): RecordsMap<V> { return new RecordsMap(put(this.root, key, value)); }
  delete(key: string): RecordsMap<V> { return this.has(key) ? new RecordsMap(remove(this.root, key)) : this; }
  [Symbol.iterator]() { return entries(this.root); }
  *keys() { for (const [key] of this) yield key; }
  *values() { for (const [, value] of this) yield value; }
}
/** A relation keeps contributors distinct, so removing one reference cannot remove another's identical edge. */
export class RecordsIndex {
  constructor(private readonly rows = new RecordsMap<RecordsMap<ReadonlySet<string>>>()) {}
  values(key: string): readonly string[] { return [...(this.rows.get(key)?.keys() ?? [])]; }
  change(key: string, value: string, source: string, add: boolean): RecordsIndex {
    const group = this.rows.get(key) ?? new RecordsMap<ReadonlySet<string>>();
    const sources = new Set(group.get(value) ?? []);
    if (add) sources.add(source); else sources.delete(source);
    const next = sources.size ? group.set(value, sources) : group.delete(value);
    return new RecordsIndex(next.size ? this.rows.set(key, next) : this.rows.delete(key));
  }
}
