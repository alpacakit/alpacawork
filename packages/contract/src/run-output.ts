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
 * Sum measured Runs in the same second windows, oldest bar first. `now` is the reader's clock; one behind the newest
 * observed second (a reader's clock behind the server's) is read as that second, so the newest counts are not dropped
 * as future ones.
 *
 * The rate is each Run's latest 5-second mean, ending at its newest counted second, summed. A model call's count
 * arrives when the call ends and is spread over the call, so a window ending now reads 0 for as long as the next call
 * runs and jumps when it ends; the latest measured mean holds instead, until the window's minute has passed.
 */
export function runOutputSpeed(outputs: Iterable<RunOutput | null | undefined>, now: number): RunOutputSpeed | null {
  const measured = [...outputs].filter((output): output is RunOutput => !!output);
  if (!measured.length) return null;
  const latest = Math.max(...measured.map((output) => output.lastActivityAt));
  const at = Math.max(now, latest);
  const bars = Array<number>(SAMPLE_COUNT).fill(0);
  let rate = 0;
  for (const output of measured) {
    const newest = output.buckets.reduce((max, [second]) => second <= at ? Math.max(max, second) : max, -Infinity);
    for (const [second, tokens] of output.buckets) {
      const age = at - second;
      if (age >= 0 && age < OUTPUT_WINDOW_SECONDS) bars[SAMPLE_COUNT - 1 - Math.floor(age / SAMPLE_SECONDS)]! += tokens;
      if (at - newest < OUTPUT_WINDOW_SECONDS && second <= newest && newest - second < SAMPLE_SECONDS) rate += tokens;
    }
  }
  for (let index = 0; index < SAMPLE_COUNT; index++) bars[index]! /= SAMPLE_SECONDS;
  return { rate: rate / SAMPLE_SECONDS, bars, idleSeconds: at - latest };
}
