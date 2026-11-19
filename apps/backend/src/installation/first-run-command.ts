/** Bounded, owned child groups: shutdown and timeout reap npm's git descendants as well. No shell input. */
import { spawn } from 'node:child_process';

export class FirstRunCommandFailure extends Error {
  constructor(readonly kind: 'missing' | 'timeout' | 'exit') { super(`Command ${kind}`); }
}
export type FirstRunCommand = (command: string, args: readonly string[], options: {
  env: NodeJS.ProcessEnv; signal?: AbortSignal; timeout?: number;
}) => Promise<string>;
export const runFirstRunCommand: FirstRunCommand = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { env: options.env, cwd: options.env.HOME, stdio: ['ignore', 'pipe', 'ignore'],
    detached: process.platform !== 'win32', shell: false });
  let output = '', size = 0, expired = false, closed = false, code: number | null = null;
  let failure: FirstRunCommandFailure | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
  };
  const finish = () => {
    // A parent can exit on TERM while its child ignores it with stdout redirected. Always complete group escalation.
    if (!closed || escalation) return;
    clearTimeout(timer); options.signal?.removeEventListener('abort', stop);
    if (expired) reject(new FirstRunCommandFailure('timeout'));
    else if (failure) reject(failure);
    else if (code !== 0) reject(new FirstRunCommandFailure('exit'));
    else resolve(output);
  };
  const stop = () => {
    if (expired) return;
    expired = true; kill('SIGTERM');
    escalation = setTimeout(() => { kill('SIGKILL'); escalation = undefined; finish(); }, 500);
  };
  const timer = setTimeout(stop, options.timeout ?? 30_000);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  child.stdout.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) stop(); else output += chunk; });
  child.once('error', error => { failure = new FirstRunCommandFailure((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'exit'); });
  child.once('close', result => { code = result; closed = true; finish(); });
});
