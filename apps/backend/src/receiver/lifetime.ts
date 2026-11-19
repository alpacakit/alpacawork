import { startServer, type ServerOptions } from './server.js';

export async function serveUntilSignal(
  root: string,
  port: number,
  publish: (value: unknown) => void,
  options: ServerOptions = {},
): Promise<void> {
  const app = await startServer(root, port, options);
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    publish({ url: app.url, publicUrl: app.publicUrl, connection: app.connection, root });
    await stopped;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await app.close();
  }
}
