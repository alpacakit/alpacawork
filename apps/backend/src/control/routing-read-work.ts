import type { ControlReadContext } from './read-context.js';

/** Only database facts belong in a routing pass's read memo. */
export type RoutingReadContext = Pick<ControlReadContext, 'get' | 'many' | 'peek' | 'remember'>;

/** Routing readers expose checkpoints without choosing a scheduler or retaining a transaction handle. */
export type RoutingReadSteps<T> = Generator<void, T, void>;

/** Synchronous business reads consume the same work as a cooperatively scheduled preparation. */
export function finishRoutingRead<T>(steps: RoutingReadSteps<T>): T {
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
