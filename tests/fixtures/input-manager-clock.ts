/** Launch the real manager with a clock controlled by this fixture's workspace. */
import { platform } from '@alpacawork/core';
import { fileURLToPath } from 'node:url';

export function installInputManagerClock() {
  const spawn = platform.run.spawnDetached;
  platform.run.spawnDetached = (command, args, options) => spawn(command,
    args[0]?.endsWith('/run-manager.js')
      ? [fileURLToPath(new URL('./input-clock-manager.ts', import.meta.url)), ...args.slice(1)] : args,
    options);
  return () => { platform.run.spawnDetached = spawn; };
}
