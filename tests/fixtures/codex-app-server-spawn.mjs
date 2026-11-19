/** This dependency never delegates a provider command. Real process creation remains under the common guard. */
import { spawn as guardedSpawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertGuardLoaded } from '../../e2e/guard.ts';
export const fixtureServer = fileURLToPath(new URL('./fake-codex-app-server.mjs', import.meta.url));
assertGuardLoaded('bridge-fixture-dependency');
export function spawn(command, args, options) {
  if (command !== process.execPath || args[0] !== 'app-server') throw new Error('Unexpected bridge fixture dependency');
  assertGuardLoaded('bridge-fixture-spawn');
  return guardedSpawn(process.execPath, [fixtureServer, ...args], options);
}

export { spawnSync };
