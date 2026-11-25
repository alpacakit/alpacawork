/** Only recorded requests can reach the usage data receiver. */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { TELEMETRY_DAY_MS, TELEMETRY_ENDPOINT, telemetryAttemptSchema, type TelemetryAttempt, type TelemetryReport } from '@alpacawork/contract/telemetry';
import { jsonFiles, readJson, writeJson } from './files.js';

const keep = 13 * 7 * TELEMETRY_DAY_MS;
type ReportAttempt = Extract<TelemetryAttempt, { kind: 'report' }>;
type DeleteAttempt = Extract<TelemetryAttempt, { kind: 'delete' }>;
type Request = Pick<ReportAttempt, 'kind' | 'day' | 'method' | 'url' | 'body'> | Pick<DeleteAttempt, 'kind' | 'method' | 'url'>;

export function finishedReport(attempt: TelemetryAttempt): attempt is ReportAttempt & { outcome: 'accepted' | 'rejected' } {
  return attempt.kind === 'report' && (attempt.outcome === 'accepted' || attempt.outcome === 'rejected');
}

export class TelemetryOutbox {
  readonly endpoint = TELEMETRY_ENDPOINT;
  private readonly directory: string;
  constructor(state: string, private readonly now: () => number, private readonly fetchRequest: typeof fetch) {
    this.directory = join(state, 'log');
  }

  private entries() {
    return jsonFiles(this.directory).flatMap(path => {
      const value = readJson(path);
      return value === null ? [] : [{ path, attempt: telemetryAttemptSchema.parse(value) }];
    });
  }

  log(): TelemetryAttempt[] {
    return this.entries().map(({ attempt }) => attempt).sort((a, b) => b.at.localeCompare(a.at));
  }

  finishedDays(log: readonly TelemetryAttempt[] = this.log()): ReadonlySet<string> {
    return new Set(log.filter(finishedReport).flatMap(({ day }) => day === undefined ? [] : [day]));
  }

  prune(now: number): void {
    for (const { path, attempt } of this.entries()) {
      if (Date.parse(attempt.at) + keep <= now) rmSync(path, { force: true });
    }
  }

  report(report: TelemetryReport, signal: AbortSignal) {
    return this.deliver({ kind: 'report', day: report.day, method: 'POST', url: this.endpoint, body: JSON.stringify(report) }, signal);
  }

  delete(id: string, signal: AbortSignal) {
    return this.deliver({ kind: 'delete', method: 'DELETE', url: `${this.endpoint}/${id}` }, signal);
  }

  private async deliver(request: Request, signal: AbortSignal): Promise<{ outcome: TelemetryAttempt['outcome']; retryAfter: string | null }> {
    const now = this.now(), path = join(this.directory, `${now}-${randomUUID()}.json`);
    writeJson(path, { ...request, at: new Date(now).toISOString(), outcome: 'unknown' });
    const saved = telemetryAttemptSchema.parse(readJson(path));
    if (saved.url !== request.url || saved.kind !== request.kind) throw new Error('Recorded telemetry destination does not match the request');

    const headers: Record<string, string> = { 'user-agent': 'alpacawork-telemetry' };
    const body = saved.kind === 'report' ? saved.body : undefined;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchRequest(saved.url, { method: saved.method, redirect: 'error', credentials: 'omit', headers, signal,
        ...(body === undefined ? {} : { body }) });
    } catch {
      return { outcome: 'unknown', retryAfter: null };
    }

    const { status } = response, retryAfter = response.headers.get('retry-after');
    const accepted = response.ok || (saved.kind === 'delete' && status === 404);
    const outcome = accepted ? 'accepted' : [400, 410, 413].includes(status) ? 'rejected' : 'retry';
    try { writeJson(path, { ...saved, outcome, status }); }
    finally { await response.body?.cancel().catch(() => {}); }
    return { outcome, retryAfter };
  }
}
