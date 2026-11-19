/** One bounded POSIX process-group/pipe transport for managed npm operations. Never return diagnostics. */
import { spawn } from 'node:child_process';
import { platform } from '@alpacawork/core';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export type NpmProcessFailure = 'aborted' | 'spawn_failed' | 'process_failed' | 'output_limit' | 'cleanup_failed';
export type NpmProcessResult = { ok: true; stdout: string } | { ok: false; kind: NpmProcessFailure; exitCode?: number; npmCode?: string; httpStatus?: number };
export function npmEnvironment(environment: Readonly<NodeJS.ProcessEnv>, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...environment, HOME: home };
  delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  return env;
}
export function npmArguments(request: { userConfig: string; globalConfig: string; fetchTimeoutMs?: number }, root: string): string[] {
 return [`--userconfig=${request.userConfig}`, `--globalconfig=${request.globalConfig}`,
  `--cache=${root}/cache`, `--logs-dir=${root}/logs`, '--logs-max=0', '--loglevel=silent', '--timing=false',
  '--update-notifier=false', '--audit=false', '--fund=false', '--ignore-scripts=true', '--strict-ssl=true',
  '--fetch-retries=0', `--fetch-timeout=${request.fetchTimeoutMs ?? 10000}`, '--offline=false',
  '--prefer-offline=false', '--prefer-online=true', '--workspaces=false', '--replace-registry-host=never'];
}
export function runNpmProcess(request: { nodeExecutable: string; npmCli: string; args: string[]; cwd: string;
  environment: NodeJS.ProcessEnv; signal?: AbortSignal; maxStdoutBytes: number; maxFileBytes?: number }): Promise<NpmProcessResult> {
  // ulimit is set before exec, so a streaming cache write cannot exhaust disk between polling ticks.
  // The limit is given in POSIX 512-byte blocks. macOS /bin/sh is bash 3.2, which counts 1024-byte blocks even as sh,
  // so use macOS's dash there; Linux /bin/sh (dash, or bash in POSIX mode) already counts 512-byte blocks.
  const executable = request.maxFileBytes ? (process.platform === 'darwin' ? '/bin/dash' : '/bin/sh') : request.nodeExecutable;
  const argv = request.maxFileBytes
    ? ['-c', 'ulimit -f "$1" || exit 125; shift; exec "$@"', 'npm-file-limit', String(Math.floor(request.maxFileBytes / 512)),
        request.nodeExecutable, request.npmCli, ...request.args]
    : [request.npmCli, ...request.args];
  return new Promise(resolve => {
      if (request.signal?.aborted) { resolve({ ok: false, kind: 'aborted' }); return; }
      let child;
      try {
        child = spawn(executable, argv, {
          cwd: request.cwd, env: request.environment, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { resolve({ ok: false, kind: 'spawn_failed' }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: NpmProcessFailure | undefined;
      let settled = false;
      let closeDeadline: ReturnType<typeof setTimeout> | undefined;
      const kill = () => {
        if (child.pid !== undefined) {
          try { platform.run.signalGroup(child.pid, 'SIGKILL'); }
          catch { failure = 'cleanup_failed'; }
        }
      };
      // exit does not imply pipe close: a descendant may have escaped the owned process group.
      // Limit our wait and report that incomplete cleanup, without trying to discover unrelated processes.
      const terminate = () => {
        kill();
        closeDeadline ??= setTimeout(() => finish(null, true), 250);
      };
      const onAbort = () => { failure ??= 'aborted'; terminate(); };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > request.maxStdoutBytes) { failure ??= 'output_limit'; terminate(); return; }
        if (!failure) chunks.push(chunk);
      };
      child.stdout.on('data', onData);
      // Drain without retaining: npm error text can contain credentials, URLs and config values.
      child.stderr.resume();
      const onError = () => { failure ??= 'spawn_failed'; terminate(); };
      const onPipeError = () => { failure ??= 'process_failed'; terminate(); };
      const onExit = () => terminate();
      const onClose = (code: number | null) => finish(code);
      child.on('error', onError);
      child.stdout.on('error', onPipeError);
      child.stderr.on('error', onPipeError);
      child.on('exit', onExit);
      child.once('close', onClose);
      const finish = (code: number | null, incomplete = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(closeDeadline);
        request.signal?.removeEventListener('abort', onAbort);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
        child.stdout.removeListener('data', onData);
        child.stdout.removeListener('error', onPipeError);
        child.stderr.removeListener('error', onPipeError);
        if (incomplete) {
          // Destroy only our read ends. This cannot prove that an escaped descendant stopped.
          child.stdout.destroy(); child.stderr.destroy(); child.unref(); chunks.length = 0;
          resolve({ ok: false, kind: 'cleanup_failed' }); return;
        }
        if (failure || request.signal?.aborted) { chunks.length = 0; resolve({ ok: false, kind: failure ?? 'aborted' }); return; }
        const stdout = Buffer.concat(chunks).toString('utf8');
        if (code !== 0) {
          const rejected: Exclude<NpmProcessResult, {ok: true}> = { ok: false, kind: 'process_failed' };
          if (code !== null) rejected.exitCode = code;
          try {
            const data: unknown = JSON.parse(stdout);
            const npmCode = record(data) && record(data.error) ? data.error.code : undefined;
            // Return only recognized machine codes; never arbitrary registry/npm messages.
            if (typeof npmCode === 'string' && /^(?:E[45][0-9]{2}|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EINTEGRITY|FETCH_ERROR|EJSONPARSE|INVALID_JSON|ERR_SOCKET_TIMEOUT)$/.test(npmCode)) {
              rejected.npmCode = npmCode;
              if (/^E[45][0-9]{2}$/.test(npmCode)) rejected.httpStatus = Number(npmCode.slice(1));
            }
          } catch { /* No safe npm machine code. */ }
          resolve(rejected);
        } else resolve({ ok: true, stdout });
        chunks.length = 0;
      };
      if (request.signal?.aborted) onAbort();
});
}
