import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';

const requestedTtl = process.env.ALPACAWORK_TEST_SERVER_TTL_MS;
const ttl = requestedTtl === undefined ? 5 * 60_000 : Number(requestedTtl);
if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 60 * 60_000)
  throw new Error('Invalid test server lifetime');
const server = await startServer(process.argv[2]!, 0,
  process.env.ALPACAWORK_TEST_PUBLIC_HOST ? { publicHost: process.env.ALPACAWORK_TEST_PUBLIC_HOST } : {});
const expiry = setTimeout(() => void server.close().then(() => process.exit(0)), ttl);
process.on('SIGTERM', () => void server.close().then(() => process.exit(0)));
console.log(JSON.stringify({ url: server.url, connection: server.connection, generation: server.generation }));
process.on('exit', () => clearTimeout(expiry));
