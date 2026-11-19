import { i18n } from "@alpacawork/i18n";
import type { Issue } from "@alpacawork/contract/problem";
import { ApiError, retryOf, problemCodeText } from "@/data/client";

/**
 * A refusal this screen decides itself, already in the person's words (the task is no longer there, the draft cannot
 * be stored): said as it is, as serve's refusals are.
 */
export class SaidFailure extends Error {}

/** Codes that name a fault on the way (no answer, an answer this screen cannot read), not a reason serve gave. */
const FAULT = new Set(["network_error", "http_error", "invalid_response"]);

/**
 * A failure in the person's words, where it is said (a toast, a form's error). `title` says what happened and what to
 * do next, by the code or the next step (`retry`). `detail` is serve's own reason for a refusal (it names what to
 * change), never a fault's technical words: those stay with the cause, which the one reporting it keeps for the
 * console. A failure that is not serve's (a fault in this screen) is said as one, not as "fix the input". `refusal`:
 * an expected outcome (serve said no), as against a fault or an unknown result.
 */
export function describeProblem(error: unknown): { title: string; detail: string; refusal: boolean } {
  if (error instanceof SaidFailure) return { title: error.message, detail: "", refusal: true };
  if (!(error instanceof ApiError)) return { title: i18n.t("problem.unexpected"), detail: "", refusal: false };
  const key = `problem.code.${error.code}`, next = i18n.t(`problem.retry.${retryOf(error)}`);
  // Connection status has one shared surface. Here keep only the operation guidance:
  // a read can wait for recovery; a lost write reply still requires checking its result.
  if (error.code === "network_error") return { title: next, detail: "", refusal: false };
  // No answer, or one this screen cannot read: its own words (already the person's) say which, then what to do next.
  const title = i18n.exists(key, { ns: "translation" }) ? problemCodeText(error.code, error.retry, error.detail)
    : error.code === "network_error" || error.code === "invalid_response" ? i18n.t("problem.fault", { what: error.displayMessage, next }) : next;
  // A refusal: serve answered, nothing was written, and its words say why. Anything else is a fault or unknown.
  const refusal = !FAULT.has(error.code) && error.retry !== "check";
  // serve's words say what to change in what was written (fix) or what changed (reread); "try later" says it all.
  const said = error.reason || refusal && error.retry !== "later" ? error.displayMessage : "";
  return { title, detail: said === title ? "" : said, refusal };
}

/**
 * Not about what was written, so not said by it: no answer to try again later, or a fault in this screen (neither
 * serve's nor one this screen said). The one rule for where a failure of a form's save goes: the app's toast for
 * these, the form for the rest (a field, serve's refusal of what was written, a change to read, a result to check).
 */
export function isAppFailure(error: unknown) {
  return !(error instanceof ApiError || error instanceof SaidFailure) || error instanceof ApiError && error.retry === "later";
}

/** Retained form results obey the same placement rule as a live save: app failures belong to the global notice. */
export function formProblemText(error: unknown): string | undefined {
  return isAppFailure(error) ? undefined : problemText(error);
}

/** The same, on one line, for a place that shows a failure where it happened (a file's card, a form's foot). */
export function problemText(error: unknown): string {
  const { title, detail } = describeProblem(error);
  // serve's issues name what is wrong in what was asked (a folder that is not one), in the person's words: they are
  // the whole answer (a form puts them by its fields instead).
  const issues = error instanceof ApiError ? error.issues.map(issueText) : [];
  return issues.length ? issues.join(" ") : detail ? `${title} ${detail}` : title;
}

export function issueText(issue: Issue): string {
  const validationKey = `validation.${issue.code}`;
  return i18n.exists(validationKey, { ns: "translation" })
    ? i18n.t(validationKey, issue.params ?? {}) : i18n.t("validation.invalid_format");
}
