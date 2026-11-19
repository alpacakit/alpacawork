/** Persistent binary trie with additive summaries. Replacing a contribution recomputes the path's totals from its
 * children, so repairing a bad cached total does not subtract from that bad value or scan a scope's members. */
interface Entry {
  readonly own?: readonly number[];
  readonly zero?: Entry;
  readonly one?: Entry;
  readonly total: readonly number[];
}
export class AggregateTotals {
  constructor(private readonly root?: Entry) {}
  get total(): readonly number[] { return this.root?.total ?? []; }
  set(key: string, value: readonly number[] | undefined): AggregateTotals {
    const put = (entry: Entry | undefined, bit: number): Entry | undefined => {
      let { own, zero, one } = entry ?? {};
      if (bit === key.length * 16) own = value;
      else if ((key.charCodeAt(bit >>> 4) >>> (15 - (bit & 15))) & 1) one = put(one, bit + 1);
      else zero = put(zero, bit + 1);
      if (!own && !zero && !one) return undefined;
      const size = Math.max(own?.length ?? 0, zero?.total.length ?? 0, one?.total.length ?? 0);
      const total = Array.from({ length: size }, (_, index) => (own?.[index] ?? 0) + (zero?.total[index] ?? 0) + (one?.total[index] ?? 0));
      return { own, zero, one, total };
    };
    return new AggregateTotals(put(this.root, 0));
  }
}
