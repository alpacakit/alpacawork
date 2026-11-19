/** Owned test-only server: stdin closes it; TTL also bounds abnormal parent termination. */
import { start } from '../../e2e/server.ts';
import { configureCoordinator } from '../../e2e/coordinator-fixture.ts';
const runtime = await start(undefined, configureCoordinator);
let closed = false;
async function close() { if (closed) return; closed = true; clearTimeout(ttl); await runtime.stop(); }
const ttl = setTimeout(() => void close(), 120_000);
process.stdin.resume(); process.stdin.once('end', () => void close());
process.once('SIGTERM', () => void close());
console.log(JSON.stringify({ origin: runtime.origin, root: runtime.root }));
