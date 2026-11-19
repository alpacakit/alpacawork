/** A placement's initial choices are the immutable fact recorded by its creation, never a later role change. */
import type { TaskLog } from '@alpacawork/raw';
import type { Selection } from '@alpacawork/contract/agent-settings';
import { runsUnavailable } from '@alpacawork/runs';

export function placementLaunchValues(log: readonly TaskLog[], placementId: string): Selection {
  const creation = log.filter(entry => entry.placementId === placementId && entry.placementRevision === 1 &&
    (entry.kind === 'responsible_changed' || entry.kind === 'placement_changed') &&
    (entry.placementEffect === 'responsible' || entry.placementEffect === 'member'));
  if (creation.length > 1)
    throw runsUnavailable(new Error(`Placement ${placementId} has multiple creation records`));
  // Low-level placement fixtures and existing intervals legitimately have no creation choice record.
  return { ...creation[0]?.launchValues };
}

/** Initial selections apply only to an implicit first conversation, not an explicit fresh start. */
export function initialPlacementValues(log: readonly TaskLog[], placementId: string,
  runs: readonly { placementId: string }[], requestedMode?: 'new' | 'continue'): Selection | undefined {
  return requestedMode === 'new' || runs.some(run => run.placementId === placementId)
    ? undefined : placementLaunchValues(log, placementId);
}
