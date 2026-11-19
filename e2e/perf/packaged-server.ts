/** Start the packaged CLI boundary; published images contain no test-dist modules. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export async function startPackagedServer(release: string, root: string, port = 0, inspect = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_')));
  Object.assign(env, { HOME: root, XDG_CONFIG_HOME: join(root, '.config'), XDG_CACHE_HOME: join(root, '.cache') });
  const child = spawn(process.execPath, [...inspect ? ['--inspect=127.0.0.1:0'] : [], join(release, 'apps/backend/dist/backend.js'), '--workspace', root,
    'workspace', 'serve', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', url: string | undefined;
  child.stdout.on('data', bytes => {
    output += bytes;
    for (const line of output.split('\n')) {
      try { const value = JSON.parse(line); if (typeof value.url === 'string') url = value.url; } catch {}
    }
  });
  child.stderr.on('data', bytes => { errors += bytes; });
  const exited = new Promise<void>((done, fail) => { child.once('exit', () => done()); child.once('error', fail); });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise<void>(done => { timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000); })]); await exited; }
    finally { clearTimeout(timer); }
  };
  for (let n = 0; n < 300; n++) {
    if (url) return { url, close, pid: child.pid!, inspectorUrl: /ws:\/\/127\.0\.0\.1:[^\s]+/.exec(errors)?.[0] };
    if (child.exitCode !== null || child.signalCode !== null) break;
    await delay(100);
  }
  await close();
  throw new Error('Packaged server did not become ready: ' + errors);
}
