export function failureJson(error: unknown): unknown {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack,
    cause: error.cause === undefined ? undefined : failureJson(error.cause),
    errors: error instanceof AggregateError ? error.errors.map(failureJson) : undefined } : String(error);
}
/** A deadline is failure, never cancellation/success. The outer CLI still owns recovery after a stuck syscall/kill. */
export function fixtureDeadline<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Fixture deadline ${ms}ms exceeded; underlying operation may still need outer recovery`)), ms);
    Promise.resolve().then(run).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
/** Error collection only; resource lifetimes remain with their existing fixture Owners. */
export async function withFixtureCleanup(use: () => Promise<void>, stages: { name: string; run: () => Promise<void>; timeoutMs?: number }[],
  record: (failures: { stage: string; error: unknown }[]) => void | Promise<void>) {
  const errors: { stage: string; error: unknown }[] = [];
  const save = async () => { try { await record(errors); } catch (error) { errors.push({ stage: 'record', error }); } };
  try { await use(); } catch (error) { errors.push({ stage: 'use', error }); }
  await save();
  for (const stage of stages) {
    try { await (stage.timeoutMs ? fixtureDeadline(stage.run, stage.timeoutMs) : stage.run()); } catch (error) { errors.push({ stage: stage.name, error }); }
    await save();
  }
  if (errors.length === 1) throw errors[0]!.error;
  if (errors.length > 1) throw new AggregateError(errors.map(each => each.error), errors.map(each =>
    `${each.stage}: ${each.error instanceof Error ? each.error.message : String(each.error)}`).join('\n'), { cause: errors[0]!.error });
}
