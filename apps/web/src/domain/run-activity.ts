/** A quiet output is an observation about stdout, never evidence that a Run has stopped. */
const QUIET_OUTPUT_MS = 10 * 60_000;
export const outputIsQuiet = (lastOutput: number | null, now: number): lastOutput is number =>
  lastOutput !== null && now - lastOutput >= QUIET_OUTPUT_MS;
