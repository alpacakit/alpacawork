import { readPayload } from '../src/data/read-json';
/** Transactional two-store IDB double; payload/selection/qualification stay production code. */
export function checkpointFixture() {
  const stores = new Map<string, Map<unknown, unknown>>();
  let initialized = false, transactions = Promise.resolve(), writeFault: Error | undefined, nextCommitFault: Error | undefined;
  let nextRead: Promise<void> | undefined, nextCommit: Promise<void> | undefined, started = 0, committed = 0, puts = 0;
  const clone = (value: any): any => value === undefined ? undefined : structuredClone(value);
  const readRaw = () => clone({ control: stores.get('control')?.get('current'), slots: [...(stores.get('slots')?.values() ?? [])] }) as any;
  const replaceRaw = (value: any) => { stores.set('control', new Map([['current', clone(value.control)]])); stores.set('slots', new Map(value.slots.map((slot: any) => [slot.hash, clone(slot)]))); };
  const starts: { at: number; durability?: string }[] = [];
  const db = {
    close() {}, onversionchange: null,
    get objectStoreNames() { return [...stores.keys()]; },
    createObjectStore(name: string) { stores.set(name, new Map()); },
    deleteObjectStore(name: string) { stores.delete(name); },
    transaction(_stores?: unknown, _mode?: unknown, options?: { durability?: string }) {
      started++; starts.push({ at: performance.now(), durability: options?.durability });
      const gate = nextRead, commitGate = nextCommit, commitFault = nextCommitFault; nextRead = undefined; nextCommit = undefined; nextCommitFault = undefined;
      const tx: any = { oncomplete: null, onerror: null, onabort: null };
      const reads: (() => void)[] = [];
      let aborted = false, pending: Map<string, Map<unknown, unknown>>;
      tx.abort = () => { if (!aborted) { aborted = true; tx.onabort?.(); } };
      tx.objectStore = (name: string) => ({
        get(key: unknown) { const request: any = {}; reads.push(() => { request.result = clone(pending.get(name)?.get(key)); request.onsuccess?.(); }); return request; },
        getAll() { const request: any = {}; reads.push(() => { request.result = clone([...pending.get(name)!.values()]); request.onsuccess?.(); }); return request; },
        put(value: any, key?: unknown) {
          if (writeFault) { const error = writeFault; writeFault = undefined; throw error; }
          puts++;
          pending.get(name)!.set(key ?? value.hash, clone(value));
        },
        delete(key: unknown) { pending.get(name)!.delete(key); },
        clear() { pending.get(name)!.clear(); },
      });
      transactions = transactions.then(async () => {
        if (gate) await gate;
        pending = clone(stores);
        for (const read of reads) { if (aborted) break; read(); }
        if (commitGate) await commitGate;
        await Promise.resolve();
        if (!aborted && commitFault) { tx.error = commitFault; tx.abort(); }
        if (!aborted) { stores.clear(); for (const [name, values] of pending) stores.set(name, values); committed++; tx.oncomplete?.(); }
      });
      return tx;
    },
  };
  return {
    factory: { open() { const request: any = { result: db }; queueMicrotask(() => {
      if (!initialized) { initialized = true; request.onupgradeneeded?.(); } request.onsuccess?.();
    }); return request; } },
    readRaw, replaceRaw,
    read: () => { const raw = readRaw(); return { ...raw, slots: raw.slots.map(({ payload, ...slot }: any) => ({ ...slot, query: { ...slot.query, state: { ...slot.query.state, data: JSON.parse(payload) } } })) }; },
    replace: (value: any) => replaceRaw({ ...value, slots: value.slots.map((slot: any) => {
      const { data, ...state } = slot.query.state;
      return { ...slot, payload: readPayload(data).text, query: { ...slot.query, state } };
    }) }),
    starts: () => [...starts],
    versionChange: () => (db.onversionchange as (() => void) | null)?.(),
    holdNextCommit: () => { let release!: () => void; nextCommit = new Promise<void>(resolve => { release = resolve; }); return release; },
    abortNextCommit: (error: Error) => { nextCommitFault = error; },
    failNextWrite: (error: Error) => { writeFault = error; },
    counts: () => ({ started, committed, puts }),
    holdNextRead: () => { let release!: () => void; nextRead = new Promise<void>(resolve => { release = resolve; }); return release; },
  };
}
