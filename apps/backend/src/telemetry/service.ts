/** Application Owner: every collection and transport path rechecks the same gate. */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomInt } from 'node:crypto';
import { TELEMETRY_CONSENT_VERSION, TELEMETRY_OPS, TELEMETRY_EVENT_ATTRIBUTES, TELEMETRY_SHAPES, TELEMETRY_TIMES,
  TELEMETRY_TIME_BUCKETS, TELEMETRY_FAILURES, TELEMETRY_AGENTS, TELEMETRY_COUNT_BUCKETS, TELEMETRY_SIZE_BUCKETS, TELEMETRY_DAY_MS,
  TELEMETRY_RETRY_MS, TELEMETRY_MAX_EVENTS, telemetryFieldsAdded, TELEMETRY_MAX_COUNT, TELEMETRY_MAX_REPORT_BYTES, dayRange, deadline, utcDay,
  type TelemetryHistory } from '@alpacawork/contract/telemetry';
import { ConsentStore, telemetryPaths, telemetryGate, runtimeFacts, type Consent, type GateFacts, type TelemetryPaths } from './consent.js';
import { TelemetryMarks, type Mark } from './marks.js';
import { TelemetryOutbox, finishedReport } from './outbox.js';
import { TelemetryQueue } from './queue.js';
import { envelope, reportFromWorkspace } from './report.js';
import { readJson, writeJson } from './files.js';
export type TelemetryRuntime = { now?: () => number; paths?: TelemetryPaths;
  facts?: (consent: Consent | null, now: number, latestDay: string | null) => GateFacts;
  envelope?: typeof envelope; fetch?: typeof fetch };
export class TelemetryService {
  readonly store: ConsentStore;
  readonly marks: TelemetryMarks;
  readonly queue: TelemetryQueue;
  private readonly outbox: TelemetryOutbox;
  private readonly now: () => number;
  private cancellation = new AbortController();
  /** The send in progress, which a delete waits out so that nothing it sends arrives after the delete. */
  private sending: Promise<void> | null = null;
  private lastDiagnosticDay = '';
  constructor(readonly root?: string, readonly env: NodeJS.ProcessEnv = process.env, private readonly runtime: TelemetryRuntime = {}) {
    this.store = new ConsentStore(runtime.paths ?? telemetryPaths(env));
    this.now = runtime.now ?? Date.now;
    const { state } = this.store.paths;
    this.marks = new TelemetryMarks(state);
    this.outbox = new TelemetryOutbox(state, this.now, runtime.fetch ?? fetch);
    this.queue = new TelemetryQueue(state, this.outbox);
  }
  /** The latest day this PC has seen; a clock behind it is not trusted. */
  private latestDay(): string | null {
    const clock = readJson(join(this.store.paths.state, 'clock.json')) as { day?: string } | null;
    const days = [clock?.day, ...this.queue.queued().map(item => item.value.report.day), ...this.marks.files().map(path => basename(path, '.json'))]
      .filter((day): day is string => !!day);
    return days.sort().at(-1) ?? null;
  }
  facts(): GateFacts {
    const consent = this.store.read(), now = this.now(), latest = this.latestDay();
    return this.runtime.facts ? this.runtime.facts(consent, now, latest) : runtimeFacts(this.root, this.env, consent, now, latest);
  }
  gate() {
    try { return telemetryGate(this.facts()); }
    catch { return { state: 'blocked' as const, blockedBy: 'invalid_state' }; }
  }
  status() {
    const gate = this.gate();
    let consent: Consent | null = null, digest: string | null = null, queued = 0, lastSentAt: string | null = null;
    try {
      consent = this.store.read(); digest = this.store.digest(); queued = this.queue.queued().length;
      lastSentAt = this.outbox.log().find(finishedReport)?.at ?? null;
    } catch { /* Status must remain readable even if local records are unavailable. */ }
    const added = gate.state === 'needs_reask' && consent?.fields ? telemetryFieldsAdded(consent.fields) : null;
    return { ...gate, consent, digest, id: consent?.id ?? null, decidedAt: consent?.decidedAt ?? null, queued, lastSentAt, added };
  }
  show() {
    return { ...this.status(), endpoint: this.outbox.endpoint, consentVersion: TELEMETRY_CONSENT_VERSION,
      allowed: { ops: TELEMETRY_OPS, attributes: TELEMETRY_EVENT_ATTRIBUTES.map(({ name, values }) => ({ name, values })),
        maxEvents: TELEMETRY_MAX_EVENTS, maxCount: TELEMETRY_MAX_COUNT, maxBytes: TELEMETRY_MAX_REPORT_BYTES,
        shapes: TELEMETRY_SHAPES, times: TELEMETRY_TIMES, timeBuckets: TELEMETRY_TIME_BUCKETS, sizes: TELEMETRY_SIZE_BUCKETS,
        failures: TELEMETRY_FAILURES, agents: TELEMETRY_AGENTS, counts: TELEMETRY_COUNT_BUCKETS,
        os: ['linux', 'darwin', 'wsl'], arch: ['x64', 'arm64'], node: '24..40' },
      next: this.preview(), queue: this.queue.queued().map(({ value }) => value),
      log: this.outbox.log(), paths: this.store.paths };
  }
  history(): TelemetryHistory {
    const { state } = this.gate();
    const log = this.outbox.log(), finished = this.outbox.finishedDays(log);
    // A report past its deadline is never sent (the queue drops it), so it is not shown as waiting.
    const now = this.now();
    // A failed attempt waits until its retry, so the row says when it can go next.
    const queue = this.queue.queued().flatMap(({ value: { notBefore, nextAttempt, report } }) =>
      finished.has(report.day) || now >= deadline(report.day) ? [] : [{ day: report.day, notBefore: Math.max(notBefore, nextAttempt), report }]);
    return { state, next: this.preview(), queue, log };
  }
  /** When counting starts: the consent, or a later delete of what was sent (nothing before it is reported again). */
  private countFrom(consent: Consent): number {
    const deleted = readJson(join(this.store.paths.state, 'deleted.json')) as { at?: number } | null;
    return Math.max(Date.parse(consent.decidedAt), typeof deleted?.at === 'number' ? deleted.at : 0);
  }
  /** Read today's report so far without queueing, recording a send, or touching the network. */
  preview() {
    if (this.gate().state !== 'on' || !this.root) return null;
    const consent = this.store.read()!, day = utcDay(this.now());
    return reportFromWorkspace(this.root, consent, day, this.marks.snapshot(day, consent.decidedAt), this.runtime.envelope ?? envelope, this.countFrom(consent));
  }
  choose(choice: Consent['choice'], decidedBy: Consent['decidedBy'], expectedDigest?: string) {
    if (choice === 'on' && (decidedBy !== 'screen' || this.gate().state === 'blocked'))
      throw new Problem(PROBLEM_CODE.forbidden, 'Usage data sending cannot be enabled here', undefined,
        { reason: { kind: 'telemetry_opt_in_unavailable' } });
    const { changed } = this.store.choose(choice, decidedBy, this.now(), expectedDigest);
    if (changed || choice === 'off') {
      this.cancellation.abort(); this.cancellation = new AbortController(); this.marks.clear();
    }
    return this.status();
  }
  /**
   * Deletes, at the receiver, every report sent with this PC's number. What was counted until now is dropped and never
   * reported (counting starts again from now), and a send in progress is stopped before the delete goes, so no report
   * of it arrives after. Totals without the number stay (docs/telemetry.md).
   */
  async deleteSent(timeoutMs = 20_000): Promise<{ id: string }> {
    const id = this.store.read()?.id;
    if (!id) throw new Problem(PROBLEM_CODE.conflict, 'This PC has no usage data number', undefined, { reason: { kind: 'telemetry_no_number' } });
    const state = this.store.paths.state;
    writeJson(join(state, 'deleted.json'), { at: this.now() });
    for (const name of ['queue', 'marks', 'next.json']) rmSync(join(state, name), { recursive: true, force: true });
    this.marks.clear();
    this.cancellation.abort(); this.cancellation = new AbortController();
    await this.sending?.catch(() => {});
    let outcome: 'unknown' | 'accepted' | 'rejected' | 'retry' = 'unknown';
    try {
      ({ outcome } = await this.outbox.delete(id, AbortSignal.timeout(timeoutMs)));
    } catch (error) { this.diagnostic(error); }
    if (outcome !== 'accepted')
      throw new Problem(PROBLEM_CODE.unavailable, 'Could not confirm deletion of the usage data', undefined, { reason: { kind: 'telemetry_delete_failed' } });
    return { id };
  }
  mark(fact: Mark): void {
    try { if (this.gate().state === 'on') this.marks.mark(fact, this.now(), this.store.read()!.decidedAt); }
    catch (error) { this.diagnostic(error); }
  }
  async send(timeoutMs = 10_000, signal?: AbortSignal): Promise<void> {
    if (this.gate().state !== 'on') return;
    if (this.sending) return this.sending;
    const sending = this.queue.send({ now: this.now, allowed: () => this.gate().state === 'on',
      timeoutMs, signal: signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal });
    this.sending = sending;
    try { await sending; } finally { if (this.sending === sending) this.sending = null; }
  }
  /** Each closed day still inside its retry window gets its report once, sent at a random time during the next day. */
  async tick(signal?: AbortSignal): Promise<void> {
    this.outbox.prune(this.now());
    if (this.gate().state !== 'on' || !this.root) return;
    const consent = this.store.read()!, now = this.now(), today = utcDay(now), state = this.store.paths.state;
    writeJson(join(state, 'clock.json'), { day: today });
    this.marks.flush(consent.decidedAt);
    const from = this.countFrom(consent), first = utcDay(Math.max(from, now - TELEMETRY_RETRY_MS));
    for (let at = dayRange(first).start; at < dayRange(today).start; at += TELEMETRY_DAY_MS) {
      const day = utcDay(at);
      if (this.queue.has(day) || now >= deadline(day)) continue;
      const report = reportFromWorkspace(this.root, consent, day, this.marks.read(day, consent.decidedAt), this.runtime.envelope ?? envelope, from);
      if (report && this.gate().state === 'on') this.queue.enqueue(report, dayRange(day).end + randomInt(TELEMETRY_DAY_MS), now);
    }
    const next = reportFromWorkspace(this.root, consent, today, this.marks.read(today, consent.decidedAt), this.runtime.envelope ?? envelope, from);
    if (this.gate().state !== 'on') return;
    writeJson(join(state, 'next.json'), next);
    await this.send(10_000, signal);
    this.queue.prune(this.now());
    for (const path of this.marks.files()) if (deadline(basename(path, '.json')) <= this.now()) rmSync(path, { force: true });
  }
  diagnostic(error: unknown): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.lastDiagnosticDay) { this.lastDiagnosticDay = day; console.error('Telemetry unavailable', error); }
  }
  async close(): Promise<void> {
    this.cancellation.abort();
    try { if (this.gate().state === 'on') this.marks.flush(this.store.read()!.decidedAt); }
    catch (error) { this.diagnostic(error); }
  }
}
