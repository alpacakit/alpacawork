/** Frozen reports retry with their original random ID; the receiver owns deduplication. */
import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { deadline, dayRange, telemetryReportSchema, type TelemetryReport } from '@alpacawork/contract/telemetry';
import { readJson, writeJson, jsonFiles } from './files.js';
const hour = 3_600_000;
const queuedSchema = z.object({ report: telemetryReportSchema, notBefore: z.number().finite(), nextAttempt: z.number().finite(),
  createdAt: z.number().finite(), attempts: z.number().int().nonnegative() }).strict();
export type QueuedReport = z.infer<typeof queuedSchema>;
export function retryAt(attempts: number, now: number, retryAfter: string | null): number {
  const delay = [1, 3, 6, 12, 24][Math.min(attempts, 4)]! * hour;
  const retry = retryAfter === null ? 0 : /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
  return Math.max(now + delay, Number.isFinite(retry) ? retry : 0);
}
export type QueueRuntime = { endpoint: string; now: () => number; allowed: () => boolean; fetch: typeof fetch; signal?: AbortSignal; timeoutMs?: number };
export class TelemetryQueue {
  constructor(readonly state: string) {}
  /** Whether a day's report was already made (queued or sent). */
  has(day: string): boolean { return ['queue', 'sent'].some(dir => existsSync(join(this.state, dir, `day-${day}.json`))); }
  enqueue(report: TelemetryReport, notBefore: number, createdAt = Date.now()): boolean {
    if (this.has(report.day)) return false;
    const name = `day-${report.day}.json`;
    writeJson(join(this.state, 'queue', name), { report: telemetryReportSchema.parse(report), notBefore, nextAttempt: notBefore, createdAt, attempts: 0 });
    return true;
  }
  /** Queued reports; one of an earlier report format (a week's) is dropped unsent. */
  queued(): { path: string; value: QueuedReport }[] {
    return jsonFiles(join(this.state, 'queue')).flatMap(path => {
      if (!basename(path).startsWith('day-')) { rmSync(path, { force: true }); return []; }
      return [{ path, value: queuedSchema.parse(readJson(path)) }];
    });
  }
  sent(): unknown[] { return jsonFiles(join(this.state, 'sent')).map(path => readJson(path)); }
  async send(runtime: QueueRuntime): Promise<void> {
    if (!runtime.allowed()) return;
    for (const { path, value } of this.queued()) {
      const now = runtime.now(), { report } = value;
      if (now >= deadline(report.day)) { rmSync(path, { force: true }); continue; }
      if (now < dayRange(report.day).start || !runtime.allowed() || runtime.signal?.aborted) return;
      if (now < Math.max(value.notBefore, value.nextAttempt)) continue;
      let status = 0, retry: string | null = null;
      try {
        const timeout = AbortSignal.timeout(runtime.timeoutMs ?? 10_000);
        const response = await runtime.fetch(runtime.endpoint, { method: 'POST', redirect: 'error', credentials: 'omit',
          headers: { 'content-type': 'application/json', 'user-agent': 'alpacawork-telemetry' }, body: JSON.stringify(report),
          signal: runtime.signal ? AbortSignal.any([timeout, runtime.signal]) : timeout });
        status = response.status; retry = response.headers.get('retry-after');
        await response.body?.cancel();
      } catch { /* A failed attempt retains the original envelope until its deadline. */ }
      if (!runtime.allowed() || runtime.signal?.aborted || !existsSync(path)) return;
      if (runtime.now() >= deadline(report.day)) { rmSync(path, { force: true }); continue; }
      if ((status >= 200 && status < 300) || [400, 410, 413].includes(status)) {
        writeJson(join(this.state, 'sent', basename(path)), { report, sentAt: new Date(runtime.now()).toISOString(), outcome: status < 300 ? 'accepted' : 'rejected', status });
        rmSync(path, { force: true });
      } else writeJson(path, { ...value, attempts: value.attempts + 1, nextAttempt: retryAt(value.attempts, runtime.now(), retry) });
    }
  }
  prune(now: number): void {
    for (const { path, value } of this.queued()) if (now >= deadline(value.report.day)) rmSync(path, { force: true });
    for (const path of jsonFiles(join(this.state, 'sent'))) {
      const value = readJson(path) as { sentAt: string };
      if (Date.parse(value.sentAt) + 13 * 7 * 24 * hour <= now) rmSync(path, { force: true });
    }
  }
}
