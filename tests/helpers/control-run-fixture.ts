import { controlRunSchema, type ControlRunDTO } from '@alpacawork/contract/control';
import { runRecordSchema, type RunRecord } from '@alpacawork/contract/run';
import { controlRuns } from '@alpacawork/backend/test-dist/control/tree.js';
import { record } from '../runs-fixtures.ts';

/** Synthetic persisted facts projected by the same boundary as a real control-tree read. */
export function controlRunFixture(id: string, fields: Partial<RunRecord> = {}): ControlRunDTO {
  const run = runRecordSchema.parse(record(id, fields));
  return controlRunSchema.parse(controlRuns('/synthetic-control-run-fixture', [run])[0]);
}
