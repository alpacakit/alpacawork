/** A failed Run decode makes execution unknown while independent Task facts remain readable. */
import { deepFreeze, faultReason, Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { ControlTreeDTO } from '@alpacawork/contract/control';
import { runsUnavailable } from '@alpacawork/runs';
import type { RecordsReader } from './projection-contract.js';

export function runRecordReadError(cause: unknown): ControlTreeDTO['errors'][number] {
  const error = cause instanceof Problem ? cause : runsUnavailable(cause);
  return deepFreeze({ code: PROBLEM_CODE.runsUnavailable, message: error.message,
    reason: error.reason ?? faultReason(error), path: '.alpacawork/alpacawork.sqlite' });
}

export function runRecordsAvailable(records: RecordsReader): boolean {
  return !records.environment().errors.some(error => error.code === PROBLEM_CODE.runsUnavailable);
}
