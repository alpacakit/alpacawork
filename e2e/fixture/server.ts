/** E2E server composition: workflow and layout cases do not depend on the test machine's load. */
import { startServer as startMeasuredServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import type { HostSource } from '@alpacawork/backend/test-dist/host/measure.js';
import { syntheticStatusBridge } from '../../tests/helpers/agent-inspection.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const GB = 1024 ** 3;
const calmHost: HostSource = {
  supported: true,
  facts: { hostname: 'fixture-host', os: 'Fixture OS', cores: 4, memoryBytes: 16 * GB },
  sample: (_runs, at) => ({ at, cpu: 20,
    memory: { totalBytes: 16 * GB, availableBytes: 8 * GB, swapUsedBytes: 0 }, load: [1, 1, 1],
    disk: { freeBytes: 100 * GB, totalBytes: 200 * GB }, gpus: [], runs: [],
    outside: { cpu: 20, memoryBytes: GB, names: [] } }),
};

// Host-specific cases can still supply their own readings through the existing server option.
export const startServer: typeof startMeasuredServer = (root, port, options) => {
  const home = join(root, '.home'); mkdirSync(home, { recursive: true });
  return startMeasuredServer(root, port, { hostSource: calmHost,
    agentInspection: { cwd: root, env: { HOME: home, PATH: join(root, 'agent-bin'),
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share') }, bridge: syntheticStatusBridge(home) }, ...options });
};
