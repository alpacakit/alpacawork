import { RETRY, type Retry } from '@alpacawork/core/codes';
export const CLI_STREAM = { stdout: 'stdout', stderr: 'stderr' } as const;

/** CLI exit codes: success (0), command failure (2), and service unavailable (3). */
export const CLI_EXIT_CODE = { success: 0, failure: 2, unavailable: 3, partial: 4 } as const;
/** A refused Problem exits 2; one that may have been written (`check`) exits 3. */
export function failureExitCode(retry: Retry) {
  return retry === RETRY.check ? CLI_EXIT_CODE.unavailable : CLI_EXIT_CODE.failure;
}

/** How a command's result reaches the process: which stream, and which exit code. */
export interface CliPolicy {
  readonly stream: (typeof CLI_STREAM)[keyof typeof CLI_STREAM];
  readonly errorExitCode?: number;
  readonly exitCode: (value: unknown) => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const defaultPolicy: CliPolicy = {
  stream: CLI_STREAM.stdout,
  exitCode: (value) =>
    isRecord(value) && Array.isArray(value.errors) && value.errors.length > 0
      ? CLI_EXIT_CODE.partial
      : CLI_EXIT_CODE.success,
};

/** Bind process policy to the registered handler, never to argv strings or a second command switch. */
export function policyIndex(entries: readonly (readonly [object, CliPolicy])[]) {
  const policies = new Map<object, CliPolicy>(entries);
  return (handler: object): CliPolicy => policies.get(handler) ?? defaultPolicy;
}
