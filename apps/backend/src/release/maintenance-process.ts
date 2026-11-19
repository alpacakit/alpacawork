/** Data-dependent maintenance owns its lifetime; a wall-clock cutoff cannot tell a slow verification from a failure. */
import { spawn } from 'node:child_process';
import { PROBLEM_CODE, Problem, faultReason } from '@alpacawork/core';

export async function runMaintenance(command: string, args: string[], env: NodeJS.ProcessEnv,
  progress: (line: string) => void, label = 'Stopped-server migration'): Promise<string> {
  const started = performance.now();
  progress(`${label} started`);
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  let bytes = 0, stderr = '', fault: Error | undefined;
  let interruptedBy: NodeJS.Signals | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedBy = signal;
    child.kill(signal);
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
    killTimer.unref();
  };
  const stop = () => interrupt('SIGTERM'), cancel = () => interrupt('SIGINT');
  process.on('SIGTERM', stop); process.on('SIGINT', cancel);
  child.once('error', error => { fault = error; });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 8 * 1024 * 1024) stdout.push(chunk);
    else if (!fault) { fault = new Error('Maintenance JSON output exceeded 8 MiB'); interrupt('SIGTERM'); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (line: string) => {
    stderr = (stderr + line).slice(-64 * 1024);
    try { progress(line.trimEnd()); }
    catch (error) { fault = error instanceof Error ? error : new Error(String(error)); interrupt('SIGTERM'); }
  });
  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done =>
    child.once('close', (code, signal) => done({ code, signal })));
  process.off('SIGTERM', stop); process.off('SIGINT', cancel);
  if (killTimer) clearTimeout(killTimer);
  const elapsedMs = Math.round(performance.now() - started);
  if (fault || code !== 0 || signal || interruptedBy) {
    const childResult = signal ? `signal ${signal}` : `exit ${code}`;
    const reason = fault ? `${(fault as NodeJS.ErrnoException).code ?? fault.name}: ${fault.message}`
      : interruptedBy ? `interrupted by ${interruptedBy}; child ${childResult}` : childResult;
    throw new Problem(PROBLEM_CODE.unavailable, `${label} failed after ${(elapsedMs / 1000).toFixed(1)}s (${reason}); switch journal retained`,
      { stderr, code, signal, elapsedMs, interruptedBy, ...(fault ? { error: { code: (fault as NodeJS.ErrnoException).code, message: fault.message } } : {}) },
      { cause: fault, reason: faultReason(fault ?? new Error(reason)) });
  }
  progress(`${label} completed in ${(elapsedMs / 1000).toFixed(1)}s`);
  return Buffer.concat(stdout).toString('utf8');
}
