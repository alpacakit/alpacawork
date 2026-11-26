import { z } from 'zod';

const SAMPLE_SECONDS = 5;
const SAMPLE_COUNT = 12;
export const OUTPUT_WINDOW_SECONDS = SAMPLE_SECONDS * SAMPLE_COUNT;
export const runOutputSchema = z.object({
  buckets: z.array(z.tuple([z.int().nonnegative(), z.int().positive()])).max(OUTPUT_WINDOW_SECONDS),
  lastActivityAt: z.int().nonnegative(),
}).strict();
export type RunOutput = z.infer<typeof runOutputSchema>;
export type RunOutputSpeed = { rate: number; bars: number[]; idleSeconds: number };

/**
 * Sum measured Runs in the same second windows, oldest bar first. The latest bar is the displayed rate. `now` is the
 * reader's clock; one behind the newest observed second (a reader's clock behind the server's) is read as that second,
 * so the newest counts are not dropped as future ones.
 */
export function runOutputSpeed(outputs: Iterable<RunOutput | null | undefined>, now: number): RunOutputSpeed | null {
  const measured = [...outputs].filter((output): output is RunOutput => !!output);
  if (!measured.length) return null;
  const latest = Math.max(...measured.map((output) => output.lastActivityAt));
  const at = Math.max(now, latest);
  const bars = Array<number>(SAMPLE_COUNT).fill(0);
  for (const output of measured) for (const [second, tokens] of output.buckets) {
    const age = at - second;
    if (age >= 0 && age < OUTPUT_WINDOW_SECONDS) bars[SAMPLE_COUNT - 1 - Math.floor(age / SAMPLE_SECONDS)]! += tokens;
  }
  for (let index = 0; index < SAMPLE_COUNT; index++) bars[index]! /= SAMPLE_SECONDS;
  return { rate: bars[SAMPLE_COUNT - 1]!, bars, idleSeconds: at - latest };
}
