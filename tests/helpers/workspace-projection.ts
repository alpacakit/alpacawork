/** A real projection over a synthetic workspace, closed before returning its immutable reads. */
import { ChangeLog } from '@alpacawork/db';
import { projectedIndexSchema } from '@alpacawork/contract/control';
import { ProjectionOwner } from '@alpacawork/backend/test-dist/receiver/projection-owner.js';
import { ProjectedHistory, projectedView } from '@alpacawork/backend/test-dist/receiver/task-reads.js';
import { ProjectedPages } from '@alpacawork/backend/test-dist/receiver/index-pages.js';

export async function readWorkspaceProjection(root: string) {
  const owner = new ProjectionOwner({ root, generation: 'synthetic-projection', log: new ChangeLog(), locations: () => ({}),
    personal: async () => ({ notices: null, person: { settings: null, notices: null, coordinator: null },
      presence: { state: 'away', until: null }, host: null, coordinatorWork: null, launchMemory: { agent: null, values: {} } }), published: () => {} });
  try {
    await owner.start();
    const frame = owner.current!, index = projectedIndexSchema.parse(JSON.parse(owner.index()));
    const histories = new ProjectedHistory(), pages = new ProjectedPages();
    return { frame, index, view: (id: string) => projectedView(frame, id),
      history: (id: string) => histories.read(frame, id),
      finished: (parent: string | null, scope: string | null = null) => pages.page(frame, 'finished', parent, scope),
      search: (text: string, scope: string | null = null) => pages.search(frame, text, scope) };
  } finally { await owner.close(); }
}
