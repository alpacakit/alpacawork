import { createServer } from 'node:http';
import { once } from 'node:events';

// Real loopback HTTP, carrying only fixture server DTOs. The product's resources
// still own parsing, Query writes, proofs and eligibility; no index injection.
const transport = globalThis.fetch;
export async function receiptHttp(answer: (url: URL) => unknown | Promise<unknown>) {
  const requests: { method: string; path: string; status: number }[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fixture');
    try {
      const value = await answer(url);
      requests.push({ method: request.method!, path: url.pathname + url.search, status: 200 });
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    } catch (error) {
      requests.push({ method: request.method!, path: url.pathname + url.search, status: 500 });
      response.writeHead(500).end(String(error));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing receipt fixture port');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    requests,
    fetch: ((input, init) => transport(new URL(String(input), origin), init)) as typeof fetch,
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections(); await closed;
      console.info('receipt HTTP', JSON.stringify(requests));
    },
  };
}
