import { assertPortFree, start } from "./server.ts";

export default async function globalSetup() {
  // Every isolated case serves on this one port; a holder stops the run here rather than failing each case.
  if (process.env.ALPACAWORK_E2E_ISOLATED_PORT) assertPortFree(process.env.ALPACAWORK_E2E_ISOLATED_PORT);
  if (process.env.ALPACAWORK_E2E_ONLY_ISOLATED === "1") return;
  const runtime = await start();
  process.env.ALPACAWORK_E2E_RUNTIME = JSON.stringify(runtime);
  return runtime.stop;
}
