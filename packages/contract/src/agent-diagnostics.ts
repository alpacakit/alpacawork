import { RUN_FAILURE_MESSAGE_LIMIT, type RunFailure } from './run-failure.js';
import { redactSecrets } from '@alpacawork/core';
type Cause = NonNullable<RunFailure['cause']>;
function causeOf(message: unknown): Cause | undefined {
  if (message === 'Selected model is at capacity. Please try a different model.' ||
    message === 'Error running remote compact task: Selected model is at capacity. Please try a different model.')
    return 'model_capacity';
  if (typeof message === 'string' && /^You've hit your weekly limit(?: · resets [^\r\n]+)?$/.test(message))
    return 'weekly_limit';
  // A per-model usage limit ("You've reached your Fable limit. Switch to another model, …") names no period or reset time.
  if (typeof message === 'string' && /^You've reached your [^\r\n]+? limit\.(?: [^\r\n]*)?$/.test(message))
    return 'model_limit';
  return undefined;
}

export function diagnosticFailure(value: unknown): RunFailure | undefined {
  if (typeof value !== 'string' || !value.trim()) return;
  const cause = causeOf(value);
  // Redact the complete diagnostic before bounding it; truncation must not cut a credential before recognition.
  const message = redactSecrets(value).trim().slice(0, RUN_FAILURE_MESSAGE_LIMIT);
  return { ...cause ? { cause } : {}, message };
}
