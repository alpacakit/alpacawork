/** The common delivery backoff; attempts starts at zero before any retry. */
export function deliveryRetryDelay(attempts: number, retryAfterSeconds = 0): number {
  return Math.max(30_000 * 2 ** attempts, retryAfterSeconds * 1000);
}
