import { runStepsReadSchema } from "@alpacawork/contract/run";
import { createApi } from "./client";

const api = createApi();
/** Every step of one Run, read from its output: only when someone opens them. */
export const readRunSteps = (run: string, signal?: AbortSignal) => api.request(`runs/${encodeURIComponent(run)}/steps`, runStepsReadSchema, signal);
