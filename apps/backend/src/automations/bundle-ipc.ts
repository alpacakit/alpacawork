import { z } from 'zod';
import {
  automationOperationErrorCodes, automationRunResultSchema, automationTriggerResultSchema,
  type AutomationOperation, type ProgramAutomationEvent,
} from '@alpacawork/contract/automation-program';

export const BUNDLE_TRIGGER_MS = 60_000;
export const BUNDLE_STOP_GRACE_MS = 5_000;

export type BundlePhase = 'trigger' | 'run';
export type TriggerResult = z.infer<typeof automationTriggerResultSchema>;
export type RunResult = z.infer<typeof automationRunResultSchema>;
export type BundleOperationErrorCode = typeof automationOperationErrorCodes[number];
export type BundleError = { message: string; file: string | null; line: number | null };
export type BundleOutput = { stream: 'stdout' | 'stderr'; text: string };

export class AlpacaworkError extends Error {
  readonly name = 'AlpacaworkError';
  constructor(readonly code: BundleOperationErrorCode, readonly operation: string, message: string) {
    super(message);
  }
}
export type OperationFailure = Pick<AlpacaworkError, 'code' | 'operation' | 'message'>;
export type BundleOutcome = {
  state: 'done' | 'skipped' | 'stopped' | 'failed';
  trigger: TriggerResult | null;
  result: RunResult | null;
  reason?: string;
  error: BundleError | null;
  limit?: string;
};
export type BundleLaunch = {
  entry: string;
  cwd: string;
  event: ProgramAutomationEvent;
  preview: boolean;
  previewRun?: boolean;
  timeoutMinutes: number;
  token?: string;
  server?: string;
  restoreId?: string;
};
export type RunPermission = { allowed: boolean; reason?: string };

export type BundleControl =
  | { type: 'launch'; launch: BundleLaunch }
  | { type: 'operate-result'; id: number; value: unknown }
  | { type: 'operate-error'; id: number; error: OperationFailure }
  | { type: 'run-permission'; permission: RunPermission }
  | { type: 'abort' };

export type BundleMessage =
  | { type: 'ready' }
  | { type: 'operate'; id: number; phase: BundlePhase; name: AutomationOperation; input: unknown }
  | { type: 'before-run'; trigger: TriggerResult | null }
  | { type: 'outcome'; outcome: BundleOutcome }
  | { type: 'timeout'; phase: BundlePhase };

export function bundleReply<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
