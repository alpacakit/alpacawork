/** Stands in for the SDK's own wait before it spawns its runtime, whose real form may download. Everything else stays the real SDK. */
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const { CopilotClient } = await import(process.env.COPILOT_SDK_ENTRY);
const spawnRuntime = CopilotClient.prototype.startCLIServer;
CopilotClient.prototype.startCLIServer = async function () {
  while (!existsSync(process.env.COPILOT_SPAWN_GATE)) await delay(5);
  return spawnRuntime.call(this);
};
