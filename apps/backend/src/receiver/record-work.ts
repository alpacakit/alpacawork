/** Record assembly has one implementation; its caller chooses whether checkpoints can yield to other work. */
export type RecordWork<T> = Generator<void, T, void>;
export function finishRecords<T>(work: RecordWork<T>): T {
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}
