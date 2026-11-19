import type { TFunction } from "i18next";
import type { RunFailure } from "@alpacawork/contract/run-failure";

/** What the backend read in a failed Run's own error words (its errorCause); a failure without one is said in general. */
export type ErrorCause = NonNullable<RunFailure["cause"]>;
/** The one place a failure's known cause has words: the sentence said for the user's turn on that failure. */
export const causeSentence = (cause: ErrorCause, t: TFunction<"ui">) =>
  cause === "model_capacity" ? t("ui:run.cause.modelCapacity") : t("ui:run.cause.weeklyLimit");
/** The same cause as a short reason, said where a failure's line already says that it failed (the coordinator's turn). */
export const causeReason = (cause: ErrorCause, t: TFunction<"ui">) =>
  cause === "model_capacity" ? t("ui:run.causeReason.modelCapacity") : t("ui:run.causeReason.weeklyLimit");
