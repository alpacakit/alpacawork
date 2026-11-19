/** Read the existing installation facts for the public local command. No second record or saved endpoint. */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot } from '../app-paths.js';
import { loadJournal, stoppedContinuationTarget } from '../release/journal.js';
import { InstallationStore, installationPath } from './store.js';

export function localCli(env: Readonly<Record<string, string | undefined>> = process.env, intent: 'client' | 'deploy' = 'client'): { release: string; server?: string } {
  const record = new InstallationStore(installationPath(env)).read();
  let release = appRoot(import.meta.url);
  if (record?.releases) {
    try { release = realpathSync(join(record.releases, 'current')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (intent==='deploy' && record && record.releases) {
    const continuation=stoppedContinuationTarget(loadJournal({releases:record.releases,workspace:record.workspace}));
    if (continuation) release=realpathSync(continuation);
  }
  return {
    release,
    ...record && record.service ? { server: `http://127.0.0.1:${record.service.port}` } : {},
  };
}
