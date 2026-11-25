import { join } from 'node:path';
import { appRoot } from '../../../scripts/app-root.mjs';
export { appRoot };
export const BACKEND_ENTRIES = {
  backend: 'backend-entry',
  maintenance: 'maintenance-entry',
  'installation/skills-update': 'installation/skills-update',
  'installation/local-cli': 'installation/local-cli',
  'run-manager': 'run-manager',
  'receiver/read-thread-worker': 'receiver/read-thread-worker',
  'analysis/tally-worker': 'analysis/tally-worker',
  'receiver/workspace-file-worker': 'receiver/workspace-file-worker',
  'storage-format': 'storage-format',
  'schema-manifest': 'schema-manifest',
  'package-version': 'package-version',
  'release/distribution': 'release/distribution-entry',
  'release/npm-validate': 'release/npm-validate',
  'release/update-controller': 'release/update-controller-entry',
  'release/update-capabilities': 'release/update-capabilities-entry',
} as const;
export const backendEntry = (name: keyof typeof BACKEND_ENTRIES, root = appRoot(import.meta.url)) =>
  join(root, 'apps/backend/dist', name + '.js');
