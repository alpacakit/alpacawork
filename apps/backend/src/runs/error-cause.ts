/** Optional display enrichment only; never changes the stored Run or its outcome. */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_FILES, runFolder, type ReadRunRecord } from '@alpacawork/contract/run';
import type { RunFailure } from '@alpacawork/contract/run-failure';
import { runtimeAdapter } from '../agents/registry.js';

const observed = new Map<string, { file: string; failure: RunFailure | undefined }>();
const OBSERVED_LIMIT = 1024;

export function readRunFailure(root: string, run: Pick<ReadRunRecord, 'id' | 'state' | 'reason' | 'session' | 'launch' | 'resumes'>): RunFailure | undefined {
  if (run.state !== 'failed' || (run.reason !== 'exit' && run.reason !== 'output') || !run.session) return;
  const folder = runFolder(root, run.id), key = `${root}\0${run.id}\0${run.session.id}`;
  let file: string;
  try {
    const stat = statSync(join(folder, RUN_FILES.stdout), { bigint: true });
    file = `${stat.dev}:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeNs}`;
  } catch { return; }
  const known = observed.get(key);
  if (known?.file === file) return known.failure;
  const adapter = runtimeAdapter(run.launch.adapter);
  if (!adapter) return;
  const read = adapter.read({ mode: run.resumes === null ? 'start' : 'resume', session: run.session.id, compaction: null }, folder,
    { code: null, signal: null });
  observed.delete(key);
  if (read.failure) {
    observed.set(key, { file, failure: read.failure });
    if (observed.size > OBSERVED_LIMIT) observed.delete(observed.keys().next().value!);
  }
  return read.failure;
}
