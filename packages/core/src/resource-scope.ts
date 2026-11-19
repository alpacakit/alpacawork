/** Resource lifetime only. Domain owners decide how a failed cleanup affects publication. */
export class CleanupFailure extends AggregateError {
  constructor(readonly primary: readonly unknown[], cleanup: readonly unknown[]) {
    const errors = [...primary, ...cleanup];
    super(errors, 'Operation cleanup failed; causes are ordered primary first, then cleanup', { cause: errors[0] });
  }
}
class Resources {
  private readonly pending = new Set<() => void>();
  /** Cancel when ownership is transferred or the resource has been explicitly closed. */
  defer(cleanup: () => void): () => void {
    this.pending.add(cleanup);
    return () => { this.pending.delete(cleanup); };
  }
  finish(primary: readonly unknown[]): void {
    const failures: unknown[] = [];
    for (const cleanup of [...this.pending].reverse()) {
      this.pending.delete(cleanup);
      try { cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new CleanupFailure(primary, failures);
  }
}
export function withResources<T>(work: (resources: Resources) => T): T {
  const resources = new Resources(), primary: unknown[] = [];
  try { return work(resources); }
  catch (error) { primary.push(error); throw error; }
  finally { resources.finish(primary); }
}
export async function withResourcesAsync<T>(work: (resources: Resources) => Promise<T>): Promise<T> {
  const resources = new Resources(), primary: unknown[] = [];
  try { return await work(resources); }
  catch (error) { primary.push(error); throw error; }
  finally { resources.finish(primary); }
}
