/** Shared node/browser test process isolation; never touches other roots. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function cleanEnv(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
  for (const key of Object.keys(env))
    if (key === 'CLAUDE_CODE_SESSION_ID' || key === 'CLAUDECODE' || key.startsWith('CODEX_') ||
        key === 'ALPACAWORK_TASK' || key === 'ALPACAWORK_RUN' || key === 'ALPACAWORK_RUN_TOKEN') delete env[key];
  return { ...env, ...extra };
}
export async function until<T>(check: () => T | false | null | undefined | Promise<T | false | null | undefined>, message: string, timeout = 30_000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const result = await check(); if (result) return result;
    if (performance.now() > deadline) throw new Error(`Deadline: ${message}`);
    await delay(20);
  }
}
export function alive(pid: number, group = false) {
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; throw e; }
}
export { killGroup, processes } from '../helpers/process-groups.ts';
import { cleanupGroups as cleanupRootGroups } from '../helpers/process-groups.ts';
export async function cleanupGroups(root: string) {
  const known = receipts(root).map(receipt => receipt.pgid);
  const local = join(root, 'local-processes');
  if (existsSync(local)) for (const pid of readdirSync(local)) known.push(Number(pid));
  const orphan = join(root, 'orphan-pgid');
  if (existsSync(orphan)) known.push(Number(readFileSync(orphan, 'utf8')));
  await cleanupRootGroups(root, known);
}
export type Receipt = { pid: number; pgid: number; branch: string; prompt: string };
export function receipts(root: string): Receipt[] {
  const dir = join(root, 'processes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    try { return [JSON.parse(readFileSync(join(dir, name), 'utf8'))]; } catch { return []; }
  });
}
