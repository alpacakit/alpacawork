import { main } from './cli.js';

export { main };

// Kept only in the executable entry; importing main through the launcher is inert.
if (import.meta.main) process.exitCode = await main();
