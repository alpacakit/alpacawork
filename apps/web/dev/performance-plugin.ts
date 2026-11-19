import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { createPerformanceReceiver } from '../../backend/src/diagnostics/receiver.ts';
import { ENDPOINT } from '../../backend/src/diagnostics/protocol.ts';

const ownOrigin = (origin: string | undefined, host: string | undefined) =>
  !!origin && ['http:', 'https:'].some(protocol => origin === `${protocol}//${host}`);

/** A dev adapter only: protocol, receiver, writer and failure policy belong to backend diagnostics. */
export function devPerformance(): Plugin {
  const bootstrap = `${ENDPOINT}/bootstrap.ts`;
  return {
    name: 'alpacawork-dev-performance',
    apply: (_config, env) => env.command === 'serve' && !env.isPreview && env.mode !== 'test',
    config() {
      const backend = process.env.ALPACAWORK_DEV_BACKEND;
      if (backend && !/^https?:\/\//.test(backend)) throw new Error('ALPACAWORK_DEV_BACKEND must be an http(s) URL');
      return backend ? { server: { proxy: { '/api': { target: backend, changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, request) => {
            if (ownOrigin(request.headers.origin, request.headers.host)) outgoing.setHeader('origin', new URL(backend).origin);
          });
        },
      } } } } : {};
    },
    resolveId(id) { if (id === bootstrap) return '\0performance-bootstrap'; },
    load(id) {
      if (id === '\0performance-bootstrap') return `import { startPerformance } from ${JSON.stringify(fileURLToPath(new URL('./performance-client.ts', import.meta.url)))};
startPerformance({buildId:'development',componentNames:true}); void import('/src/main.tsx');`;
    },
    transformIndexHtml: { order: 'pre', handler(html, context) {
      return context.filename?.endsWith('/index.html') || context.path === '/'
        ? html.replace('/src/main.tsx', bootstrap) : html;
    } },
    configureServer(server) {
      const receiver = createPerformanceReceiver(resolve(server.config.root, '../../.local/dev-performance'), 'development', message => server.config.logger.warn(message));
      server.httpServer?.once('close', () => { void receiver.close(); });
      server.middlewares.use((request, response, next) => {
        const origin = request.headers.origin;
        if (!receiver.handle(request, response, ownOrigin(origin, request.headers.host) ? origin! : '')) next();
      });
    },
  };
}
