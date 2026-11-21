import type { TFunction } from "i18next";
import type { RunFailure } from "@alpacawork/contract/run-failure";

/** What the backend read in a failed Run's own error words (its errorCause); a failure without one is said in general. */
export type ErrorCause = NonNullable<RunFailure["cause"]>;
/** The one place a failure's known cause has words: the sentence said for the user's turn on that failure. */
const causeKey: Record<ErrorCause, string> = { model_capacity: "modelCapacity", weekly_limit: "weeklyLimit", model_limit: "modelLimit" };
export const causeSentence = (cause: ErrorCause, t: TFunction<"ui">) => t(`ui:run.cause.${causeKey[cause]}`);
/** The same cause as a short reason, said where a failure's line already says that it failed (the coordinator's turn). */
export const causeReason = (cause: ErrorCause, t: TFunction<"ui">) => t(`ui:run.causeReason.${causeKey[cause]}`);
