import type { ReadAssessment } from "@/data/read-model";

/** Content held for a task known to have changed is kept in place (its drafts, folds and scroll), unseen. */
export const hidesHeldContent = (assessment: ReadAssessment, fetching: boolean, held: boolean) =>
  held && !assessment.display && !fetching;
