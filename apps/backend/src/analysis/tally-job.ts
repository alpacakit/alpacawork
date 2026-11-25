import { Worker } from 'node:worker_threads';
import type { ChangeLog } from '@alpacawork/db';
import { backendEntry } from '../app-paths.js';
import type { Tally } from '../agents/adapters/tally.js';

export function startTallyJob(root: string, tallySince: number, changes: ChangeLog, onTallies: (batch: [string, Tally][]) => void) {
  const worker = new Worker(backendEntry('analysis/tally-worker'), { workerData: { root, tallySince } });
  const release = changes.register('analysis-tally');
  const unsubscribe = changes.subscribe(() => {
    const read = changes.read('analysis-tally');
    if (read.kind === 'overflow') worker.postMessage({ rescan: true });
    else {
      const ids = [...new Set(read.batches.flatMap(batch => batch.keys.filter(key => key.kind === 'run').map(key => key.id)))];
      if (ids.length) worker.postMessage({ ids });
    }
    changes.acknowledge('analysis-tally', read.through);
  });
  let exited = false;
  const closed = new Promise<void>(resolve => worker.once('exit', () => {
    exited = true; unsubscribe(); release(); resolve();
  }));
  worker.on('error', error => console.error('Analysis tally worker failed', error));
  worker.on('message', ({ batch, issue }: { batch?: [string, Tally][]; issue?: string }) => {
    if (batch) onTallies(batch);
    if (issue) console.error('Analysis tally could not read Run', issue);
  });
  worker.postMessage({ rescan: true });
  return async () => {
    if (!exited) worker.postMessage({ stop: true });
    await closed;
  };
}
