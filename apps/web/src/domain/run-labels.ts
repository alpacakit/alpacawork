import type { TFunction } from "i18next";
import type { RunAvailability } from "@alpacawork/contract/run-failure";
import { resetWords } from "./limits";

/** What the backend read in a failed Run's own error words (its errorCause): the cause, and for a limit when it lifts. */
export type ErrorCause = RunAvailability;
type CauseKind = ErrorCause["cause"];
/** The one place a failure's known cause has words. */
const causeKey: Record<CauseKind, string> = { model_capacity: "modelCapacity", weekly_limit: "weeklyLimit", session_limit: "sessionLimit", model_limit: "modelLimit" };
/**
 * The sentence said for the user's turn on that failure. While a limit's reset is still ahead it says when, so the
 * person can tell whether waiting for the same AI is worth it; a reset already past is not said.
 */
export const causeSentence = (error: ErrorCause, t: TFunction<"ui">, now: number, locale: string) => {
  const reset = resetWords(error.resetsAt ?? null, now, locale, t as (key: string, options?: Record<string, unknown>) => string);
  return reset ? t("ui:run.causeWithReset", { reason: causeReason(error.cause, t), reset }) : t(`ui:run.cause.${causeKey[error.cause]}`);
};
/** The same cause as a short reason, said where a failure's line already says that it failed (the coordinator's turn). */
export const causeReason = (cause: CauseKind, t: TFunction<"ui">) => t(`ui:run.causeReason.${causeKey[cause]}`);
/** The same cause as a short name, said where the AI stack carried the work on ("stopped on <name>") and on a stopped row. */
export const limitName = (cause: CauseKind, t: TFunction<"ui">) => t(`ui:run.limitName.${causeKey[cause]}`);
