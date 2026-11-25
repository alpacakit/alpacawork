/** Frozen reports retry with their original random ID; the receiver owns deduplication. */
import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { deadline, dayRange, telemetryReportSchema, type TelemetryReport } from '@alpacawork/contract/telemetry';
import { readJson, writeJson, jsonFiles } from './files.js';
import type { TelemetryOutbox } from './outbox.js';
const hour = 3_600_000;
const queuedSchema = z.object({ report: telemetryReportSchema, notBefore: z.number().finite(), nextAttempt: z.number().finite(),
  createdAt: z.number().finite(), attempts: z.number().int().nonnegative() }).strict();
export type QueuedReport = z.infer<typeof queuedSchema>;
export function retryAt(attempts: number, now: number, retryAfter: string | null): number {
  const delay = [1, 3, 6, 12, 24][Math.min(attempts, 4)]! * hour;
  const retry = retryAfter === null ? 0 : /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
  return Math.max(now + delay, Number.isFinite(retry) ? retry : 0);
}
export type QueueRuntime = { now: () => number; allowed: () => boolean; signal?: AbortSignal; timeoutMs?: number };
export class TelemetryQueue {
  constructor(readonly state: string, private readonly outbox: TelemetryOutbox) {}
  /** Whether a day's report was already made (queued or finished). */
  has(day: string): boolean { return existsSync(join(this.state, 'queue', `day-${day}.json`)) || this.outbox.finishedDays().has(day); }
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
  async send(runtime: QueueRuntime): Promise<void> {
    if (!runtime.allowed()) return;
    const queued = this.queued();
    if (!queued.length) return;
    const finished = this.outbox.finishedDays();
    for (const { path, value } of queued) {
      const now = runtime.now(), { report } = value;
      if (now >= deadline(report.day) || finished.has(report.day)) { rmSync(path, { force: true }); continue; }
      if (now < dayRange(report.day).start || !runtime.allowed() || runtime.signal?.aborted) return;
      if (now < Math.max(value.notBefore, value.nextAttempt)) continue;
      const timeout = AbortSignal.timeout(runtime.timeoutMs ?? 10_000);
      const signal = runtime.signal ? AbortSignal.any([timeout, runtime.signal]) : timeout;
      const { outcome, retryAfter } = await this.outbox.report(report, signal);
      if (!runtime.allowed() || runtime.signal?.aborted || !existsSync(path)) return;
      if (runtime.now() >= deadline(report.day) || outcome === 'accepted' || outcome === 'rejected') {
        rmSync(path, { force: true });
      } else writeJson(path, { ...value, attempts: value.attempts + 1, nextAttempt: retryAt(value.attempts, runtime.now(), retryAfter) });
    }
  }
  prune(now: number): void {
    for (const { path, value } of this.queued()) if (now >= deadline(value.report.day)) rmSync(path, { force: true });
  }
}
