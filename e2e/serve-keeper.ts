/**
 * Cleans up one served copy once the process that started it lets go, however that process ends.
 * The starter holds this keeper's stdin: `stop()` closes it, and so does the starter's exit (a test
 * timeout that abandons setup, a stopped or killed worker). Then every process naming the root
 * (serve, its run managers and agents) is stopped and the root removed.
 */
import { rmSync } from "node:fs";
import { cleanupGroups } from "../tests/acceptance/processes.ts";

// Passed in the environment, not argv: cleanupGroups stops every process whose command line names the root.
const root = process.env.ALPACAWORK_E2E_KEEPER_ROOT!;
process.stdin.resume().once("end", async () => {
  await cleanupGroups(root);
  if (process.env.ALPACAWORK_E2E_KEEPER_RETAIN !== '1') rmSync(root, { recursive: true, force: true });
});
