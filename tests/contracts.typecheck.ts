// Compile-only assertions: persistence, view results, and Run read boundaries reach their callers.
import type { Database } from '@alpacawork/db';
import { episodes } from '@alpacawork/db/host/schema';
import type { DatabaseSync } from 'node:sqlite';
import type { ReadRunRecord, RunRecord } from '@alpacawork/contract/run';
import type { ReadRunSnapshot, ReturnDelivery } from '@alpacawork/runs';
import { ownerHead, ownerHeadsOf, seatRunBefore, seatSourceOf } from '../apps/backend/src/control/wake.ts';
import { returnReceipt } from '../apps/backend/src/control/return-lifecycle.ts';
import { takesInput } from '../apps/backend/src/runs/execution-control.ts';
import { controlRuns } from '../apps/backend/src/control/tree.ts';
import { readControlTree } from './helpers/control-tree.ts';

export async function verifyContracts(db: Database, root: string) {
  // @ts-expect-error Renamed/nonexistent columns must fail at compile time.
  db.select({missing: episodes.missingColumn}).from(episodes);
  const tree = await readControlTree(root);
  const title: string = tree.tasks[0]!.title;
  const parentId: string | null = tree.tasks[0]!.parentId;
  const requestBody: string | undefined = tree.requests[0]?.body;
  // @ts-expect-error Format 2 view results cannot silently decay to any.
  const wrong: number = tree.tasks[0]!.title;
  return {title, parentId, requestBody, wrong};
}

/** Checked by the normal Node type stage, without executing invalid writes. */
export function verifyRunReadContracts(input: ReadRunRecord, mutable: RunRecord, snapshot: ReadRunSnapshot,
  db: DatabaseSync, delivery: ReturnDelivery) {
  controlRuns('/tmp', [input]);
  seatRunBefore([input], input);
  seatSourceOf([], snapshot, { profiles: new Set(), automaticLimit: 1 });
  const mutableHead: RunRecord | null = ownerHead([mutable]);
  const mutableHeads: ReadonlyMap<string, RunRecord> = ownerHeadsOf([mutable], []);
  const mutableActual: RunRecord | null = returnReceipt(db, [mutable], delivery).actual;
  const readonlyActual: ReadRunRecord | null = returnReceipt(db, [input], delivery).actual;
  if (takesInput(mutable, false)) mutable.session.id = 'still-mutable';
  if (takesInput(input, false)) {
    // @ts-expect-error A narrowed read input still has an immutable session.
    input.session.id = 'forbidden';
  }
  // @ts-expect-error Nested Run arrays are immutable at a pure reader boundary.
  input.launch.argv.push('forbidden');
  // @ts-expect-error Generic ownerHead preserves the readonly input's nested shape.
  ownerHead([input])!.launch.argv.push('forbidden');
  return { mutableHead, mutableHeads, mutableActual, readonlyActual };
}
