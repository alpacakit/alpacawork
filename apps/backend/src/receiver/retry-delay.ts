/** Shared bounded retry delay; the first failed attempt waits 250 ms. */
export const retryDelay = (failures: number): number => Math.min(30_000, 250 * 2 ** Math.min(Math.max(0, failures - 1), 7));
