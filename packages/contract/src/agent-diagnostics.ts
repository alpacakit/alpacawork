import { RUN_FAILURE_MESSAGE_LIMIT, type RunAvailability, type RunFailure } from './run-failure.js';
import { redactSecrets } from '@alpacawork/core';
type Cause = NonNullable<RunFailure['cause']>;
/**
 * Claude says a usage limit as "You've hit your <scope> limit · resets <when>. …" (earlier "You've reached your <scope>
 * limit. Switch to another model, …"): a weekly or 5-hour session scope, or a model by its name ("Fable"). Other limits
 * ("context window", lowercase) and other endings are not a usage limit.
 */
const LIMIT = /^You've (?:hit|reached) your (weekly|session|[A-Z][\w.\- ]{0,40}?) limit(?: · resets [^\r\n]+|\. Switch to another model\b[^\r\n]*)?$/;
function causeOf(message: unknown): Cause | undefined {
  if (message === 'Selected model is at capacity. Please try a different model.' ||
    message === 'Error running remote compact task: Selected model is at capacity. Please try a different model.')
    return 'model_capacity';
  const scope = typeof message === 'string' ? LIMIT.exec(message)?.[1] : undefined;
  if (scope === undefined) return undefined;
  return scope === 'weekly' ? 'weekly_limit' : scope === 'session' ? 'session_limit' : 'model_limit';
}

/** A failure read from an agent's error words; `resetsAt` is when the provider said its usage limit lifts, kept only for a limit. */
export function diagnosticFailure(value: unknown, resetsAt?: string): RunFailure | undefined {
  if (typeof value !== 'string' || !value.trim()) return;
  const cause = causeOf(value);
  // Redact the complete diagnostic before bounding it; truncation must not cut a credential before recognition.
  const message = redactSecrets(value).trim().slice(0, RUN_FAILURE_MESSAGE_LIMIT);
  return { ...cause ? { cause } : {}, ...cause && cause !== 'model_capacity' && resetsAt ? { resetsAt } : {}, message };
}

/**
 * A Run's recognized failure for the screen: what its end recorded (`availability`), with the reset its own output says
 * when the record has the same cause without one; else what its output says.
 */
export function runErrorCause(recorded: RunAvailability | undefined, read: RunAvailability | undefined): RunAvailability | undefined {
  if (!recorded) return read;
  return !recorded.resetsAt && read?.cause === recorded.cause && read.resetsAt ? { ...recorded, resetsAt: read.resetsAt } : recorded;
}

/** The recognized part of a failure: its cause and, for a limit, when it lifts; undefined when the cause is not known. */
export const failureAvailability = (failure: RunFailure | undefined): RunAvailability | undefined =>
  failure?.cause ? { cause: failure.cause, ...failure.resetsAt ? { resetsAt: failure.resetsAt } : {} } : undefined;
