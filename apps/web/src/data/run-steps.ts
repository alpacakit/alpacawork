import { runStepDetailSchema, runStepsPageSchema } from "@alpacawork/contract/run";
import { createApi } from "./client";

const api = createApi();
/** A Run's steps, read from its output only when someone opens them: from step `from` on (else the latest), `limit` of them. */
export function readRunSteps(run: string, range: { from?: number; limit: number }, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: String(range.limit), ...range.from === undefined ? {} : { from: String(range.from) } });
  return api.request(`runs/${encodeURIComponent(run)}/steps?${query}`, runStepsPageSchema, signal);
}
/** What step `n` of a Run ran and got back, in full. */
export const readRunStep = (run: string, n: number, signal?: AbortSignal) =>
  api.request(`runs/${encodeURIComponent(run)}/steps/${n}`, runStepDetailSchema, signal);
