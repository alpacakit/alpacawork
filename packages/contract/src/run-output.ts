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

/** Sum measured Runs in the same second windows, oldest bar first. The latest bar is the displayed rate. */
export function runOutputSpeed(outputs: Iterable<RunOutput | null | undefined>, now: number): RunOutputSpeed | null {
  const bars = Array<number>(SAMPLE_COUNT).fill(0);
  let latest = -1;
  for (const output of outputs) {
    if (!output) continue;
    latest = Math.max(latest, output.lastActivityAt);
    for (const [second, tokens] of output.buckets) {
      const age = now - second;
      if (age >= 0 && age < OUTPUT_WINDOW_SECONDS) bars[SAMPLE_COUNT - 1 - Math.floor(age / SAMPLE_SECONDS)]! += tokens;
    }
  }
  if (latest < 0) return null;
  for (let index = 0; index < SAMPLE_COUNT; index++) bars[index]! /= SAMPLE_SECONDS;
  return { rate: bars[SAMPLE_COUNT - 1]!, bars, idleSeconds: Math.max(0, now - latest) };
}
