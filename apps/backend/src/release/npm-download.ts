/** npm owns credentials/proxy/CA/redirects. A private frozen packument prevents a second resolution.
 * cache add of a registry spec streams raw bytes with SRI; unlike a URL spec it never unpacks a manifest.
 * No npm private module or cache layout is imported: locate the verified content by its digest.
 */
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { npmArguments, npmEnvironment, runNpmProcess, type NpmProcessResult } from './npm-process.js';
import type { NpmMetadataRequest } from './npm-registry.js';

export async function downloadNpmTarball(request: NpmMetadataRequest, fixed: {
  packageName: string; exactVersion: string; tarball: string; integrity: string;
}, root: string, signal: AbortSignal, maxBytes: number): Promise<
  { ok: true; file: string; sha256: string; bytes: number } | Exclude<NpmProcessResult, {ok: true}> | { ok: false; kind: 'integrity_mismatch' | 'download_limit' }
> {
  const nonce = randomUUID();
  let calls = 0;
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (req.method !== 'GET' || path !== `/${nonce}/${fixed.packageName.replace('/', '%2f')}` &&
      path !== `/${nonce}/${fixed.packageName}` || ++calls > 16) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    const version = { name: fixed.packageName, version: fixed.exactVersion,
      dist: { tarball: fixed.tarball, integrity: fixed.integrity } };
    res.end(JSON.stringify({ name: fixed.packageName, 'dist-tags': { latest: fixed.exactVersion },
      versions: { [fixed.exactVersion]: version } }));
  });
  try {
    signal.throwIfAborted();
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen_failed');
    const local = `http://127.0.0.1:${address.port}/${nonce}/`;
    const cwd = join(root, 'cwd'); await mkdir(cwd); await mkdir(join(cwd, 'node_modules'));
    const env = npmEnvironment(request.environment, request.homeDirectory);
    const noProxy = await runNpmProcess({ ...request, cwd, signal, environment: env, maxStdoutBytes: 64 * 1024,
      args: [...npmArguments(request, root), 'config', 'get', 'noproxy'] });
    if (noProxy.ok === false) return noProxy;
    const bypass = noProxy.stdout.trim();
    if (/[\r\n\0]/.test(bypass)) return { ok: false, kind: 'process_failed' };
    const scope = fixed.packageName.startsWith('@') ? fixed.packageName.split('/')[0] : undefined;
    const result = await runNpmProcess({ ...request, cwd, signal, maxFileBytes: maxBytes, maxStdoutBytes: 1024 * 1024,
      environment: env,
      args: [...npmArguments(request, root), `--noproxy=127.0.0.1,::1,${bypass}`, `--registry=${local}`, ...(scope ? [`--${scope}:registry=${local}`] : []),
        '--json', 'cache', 'add', `${fixed.packageName}@${fixed.exactVersion}`] });
    if (result.ok === false) return result;
    let entries = 0, bytes = 0, found: { file: string; sha256: string; bytes: number } | undefined;
    const limit = new Error('download_limit');
    async function scan(dir: string): Promise<void> {
      for (const name of await readdir(dir)) {
        signal.throwIfAborted();
        if (++entries > 1024) throw limit;
        const path = join(dir, name), stat = await lstat(path);
        if (stat.isDirectory()) { await scan(path); continue; }
        if (!stat.isFile() || stat.size > maxBytes || (bytes += stat.size) > maxBytes * 4) throw limit;
        const sha512 = createHash('sha512'), sha256 = createHash('sha256');
        for await (const chunk of createReadStream(path, { signal })) { sha512.update(chunk); sha256.update(chunk); }
        if (`sha512-${sha512.digest('base64')}` === fixed.integrity) found = { file: path, sha256: sha256.digest('hex'), bytes: stat.size };
      }
    }
    // An over-limit cache is a download outcome, not an I/O fault.
    try { await scan(join(root, 'cache')); } catch (error) { if (error === limit) return { ok: false, kind: 'download_limit' }; throw error; }
    return found ? { ok: true, ...found } : { ok: false, kind: 'integrity_mismatch' };
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
  }
}
