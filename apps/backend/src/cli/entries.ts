import { accessHelp, accessHelpPointer } from '@alpacawork/contract/access-help';
/** The `alpacawork` command tree. Task operations and the local screen. */
import { defineCliRoot, policyIndex, withCliHelp } from '@alpacawork/cli-kit';
import { adminNodes, serve } from '../receiver/entries.js';
import { environmentFileHelp } from '../environment-file.js';
import { recoveryAccessHelp } from '../release/maintenance-authorization.js';
import { operationReadHelp } from '@alpacawork/contract/access-boundaries';
import { deployNode } from '../installation/deploy-entry.js';
import { serviceCommandNodes, serviceCommandPolicies } from '../installation/service-commands.js';
import { setupNode, uninstallNode } from '../installation/entries.js';
import { releaseNode } from '../release/entries.js';
import { telemetryNode } from '../telemetry/entries.js';

// Bind each local command to the same access view as its actual admin/release action.
for (const group of [...adminNodes, releaseNode]) for (const node of group.children ?? [])
  for (const endpoint of node.endpoints ?? [])
    withCliHelp(endpoint, () => [accessHelp(`${group.name}.${node.name}`).trim(),
      ...group === releaseNode && ['recover', 'operation'].includes(node.name) ? [recoveryAccessHelp] : [],
      ...group === releaseNode && node.name === 'operation' ? [operationReadHelp] : [],
      ...endpoint === serve ? [environmentFileHelp] : []]);

export const { tree, workspaceTree } = defineCliRoot(
  'alpacawork-backend',
  `Local workspace initialization and HTTP server.\n\n${accessHelpPointer}`,
  'Server data directory (existing installation or unambiguous cwd ancestor; new workspace init defaults to ~/alpacawork)',
  [...adminNodes, releaseNode, setupNode, uninstallNode, deployNode, telemetryNode, ...serviceCommandNodes],
);

for (const endpoint of deployNode.endpoints ?? []) withCliHelp(endpoint, () => [accessHelp('deploy')]);

export const policyFor = policyIndex(serviceCommandPolicies);
