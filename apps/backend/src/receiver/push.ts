/**
 * Web Push from serve: the VAPID keys, the subscribed devices, and the events
 * sent to them. serve is the only writer of
 * `<root>/.alpacawork/push.json`.
 *
 * An event is written before it is sent, and every device has its own delivery
 * record, so a restart never repeats a sent event and one failing device never
 * holds back another. Delivery goes through the browser vendors' push
 * services; only their hosts are accepted as endpoints, over https, on the
 * default port, without following redirects.
 */
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { FILE_MODE, hasCode, PROBLEM_CODE, Problem, faultReason } from '@alpacawork/core';
import { META_DIRECTORY } from '@alpacawork/raw';
import { endpointAllowed, pushPayloadSchema, pushSubscriptionSchema, userTurn, type Ball, type PushDevice, type PushPayload, type PushSubscriptionInput, type SettingValues } from '@alpacawork/contract';
import { noticeStateSchema } from '@alpacawork/contract';
import { isFinished } from '@alpacawork/contract/branch';
import { serverText, type ServerLocale, type ServerText } from '@alpacawork/i18n/server';
import { defaultUiLocale, uiLocaleOrDefault } from '@alpacawork/core/ui-language';
import type { PresenceStatus } from './presence.js';
import type { ControlTaskDTO, ControlTreeDTO } from '@alpacawork/contract/control';

const PUSH_FILE = 'push.json';
/** Delivered events are kept this long so a restart cannot repeat them. */
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** After this, an undelivered event is stale: the person has moved on or read the screen. */
const DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;
const SEND_TIMEOUT_MS = 10_000;
export { endpointAllowed } from '@alpacawork/contract';

const deliverySchema = z.union([
  z.object({ sent_at: z.string() }).strict(),
  z.object({ closed_at: z.string() }).strict(),
  z.object({ attempts: z.number().int().nonnegative(), next_at: z.string(), error: z.string() }).strict(),
]);
const eventSchema = z.object({
  key: z.string().min(1),
  payload: pushPayloadSchema,
  urgency: z.enum(['normal', 'high']),
  created_at: z.string(),
  log_count: z.number().int().nonnegative(),
  pending: z.boolean(),
  deliveries: z.record(z.string(), deliverySchema),
}).strict();
const deviceSchema = z.object({
  id: z.string().min(1), label: z.string(), created_at: z.string(), subscription: pushSubscriptionSchema,
}).strict();
/** push.json names each Task by its ID (`T42`). */
const PUSH_VERSION = 4;
const fileSchema = z.object({
  version: z.literal(PUSH_VERSION),
  vapid: z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) }).strict(),
  subscriptions: z.array(deviceSchema),
  events: z.array(eventSchema),
  /** Current Task transition keys and the initialization marker, persisted across restarts. */
  seen: z.array(z.string()),
}).strict();
type PushFile = z.infer<typeof fileSchema>;
type PushEvent = z.infer<typeof eventSchema>;
type Device = z.infer<typeof deviceSchema>;
type NoticeSnapshot = z.infer<typeof noticeStateSchema> | null;

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
async function generateVapid(): Promise<PushFile['vapid']> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  if (!jwk.d || raw.length !== 65) throw new Error('Unexpected VAPID key shape');
  return { publicKey: base64url(raw), privateKey: jwk.d };
}
const deviceId = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

/** How the sender reaches a push service; tests replace it. `retryAfter` is the service's Retry-After in seconds. */
export type PushSender = (device: PushSubscriptionInput, payload: PushPayload, options: { urgency: 'normal' | 'high'; ttl: number; vapid: { subject: string; publicKey: string; privateKey: string } }) => Promise<{ status: number; retryAfter?: number }>;
const defaultSender: PushSender = async (subscription, payload, options) => {
  if (!endpointAllowed(subscription.endpoint)) return { status: 0 };
  const request = await buildPushPayload(
    { data: payload, options: { ttl: options.ttl, urgency: options.urgency } },
    { endpoint: subscription.endpoint, expirationTime: subscription.expirationTime ?? null, keys: subscription.keys },
    options.vapid,
  );
  const response = await fetch(subscription.endpoint, {
    method: 'POST', headers: request.headers, body: request.body as BodyInit,
    redirect: 'error', signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  await response.arrayBuffer().catch(() => undefined);
  const retryAfter = Number(response.headers.get('retry-after'));
  return { status: response.status, ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}) };
};

function pushUnavailable(cause: unknown): Problem {
  return new Problem(PROBLEM_CODE.unavailable, `Push notifications are unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, undefined,
    { reason: { kind: 'push_unavailable', cause: faultReason(cause) }, cause });
}

/** A Task of the screen's tree, opened by its ID as the screen's URL names it. */
type Task = Pick<ControlTaskDTO, 'id' | 'kind' | 'parentId' | 'title' | 'state' | 'lifecycle' | 'userRequested' | 'log'>;
type Tasks = readonly Task[];
export type Derived = { key: string; payload: PushPayload; urgency: 'normal' | 'high'; occurredAt: string; logCount?: number };
const clip = (text: string, max: number) => text.length > max ? text.slice(0, max - 1) + '…' : text;
const titleOf = (task: Task) => clip(`${task.id} ${task.title}`, 80);
const taskUrl = (task: string) => `/?task=${encodeURIComponent(task)}`;
const INITIALIZED = 'tasks:initialized';
/** Host episode events are keyed by their start, so each episode is recorded once. */
const HOST_PUSH_PREFIX = 'host:';
export const hostPushKey = (start: number) => `${HOST_PUSH_PREFIX}${start}`;
type Balls = ControlTreeDTO['balls'];
type NoticeState = 'error' | 'review' | 'question' | 'followup' | 'done' | 'stopped';
type NoticeReason = Extract<Ball, { holder: 'user' }>['reason'] | 'done' | 'stopped';
export type HeldNotice = { task: Task; state: NoticeState; reason: NoticeReason; at: string };
/** The one table from why the user holds the ball to the notice it is. */
const TURN_NOTICES: Record<Extract<Ball, { holder: 'user' }>['reason'], NoticeState> = {
  review: 'review', question: 'question', limit: 'followup', unconfirmed: 'followup', blocked: 'followup', failed: 'error',
};
/** The entry the Task's current state began with; repeated reports in the same state do not begin it again. */
function transition(task: Task): Task['log'][number] | null {
  let previous: string | null = null, began: Task['log'][number] | null = null;
  for (const entry of task.log) {
    if (entry.toState === null || entry.toState === previous) continue;
    began = entry;
    previous = entry.toState;
  }
  return began;
}
/**
 * The notices each Task holds now, by key: the user's turn, under its ball's key (a hold keeps the ball's key and time,
 * so holding and returning never notify again), and the end (done or stopped) of a Task the home list shows, under the
 * entry that ended it.
 */
export function holdingKeys(tasks: Tasks, balls: Balls, parentLookup?: (id: string) => Pick<Task, 'kind' | 'lifecycle'> | undefined): Map<string, HeldNotice> {
  const byId = parentLookup ? undefined : new Map(tasks.map(task => [task.id, task]));
  const parent = parentLookup ?? ((id: string) => byId!.get(id));
  const keys = new Map<string, HeldNotice>();
  for (const task of tasks) {
    if (task.lifecycle !== 'active' || task.kind !== 'task') continue;
    const turn = userTurn(balls[task.id] ?? null);
    if (turn) keys.set(`${task.id}:${turn.key}`, { task, state: TURN_NOTICES[turn.reason], reason: turn.reason, at: turn.at });
    else if (isFinished(task.state) && (!task.parentId || parent(task.parentId)?.kind !== 'task' || parent(task.parentId)?.lifecycle !== 'active')) {
      const ended = transition(task);
      if (ended) keys.set(`${task.id}:${ended.id}`, { task, state: task.state, reason: task.state, at: ended.at });
    }
  }
  return keys;
}
/** Display reasons stay distinct even when they share a delivery setting. */
const noticeWords = (t: ServerText): Record<NoticeReason, { body: string; short: string }> => ({
  review: { body: t('server:push.reason.review.body'), short: t('server:push.reason.review.short') },
  question: { body: t('server:push.reason.question.body'), short: t('server:push.reason.question.short') },
  limit: { body: t('server:push.reason.limit.body'), short: t('server:push.reason.limit.short') },
  unconfirmed: { body: t('server:push.reason.unconfirmed.body'), short: t('server:push.reason.unconfirmed.short') },
  blocked: { body: t('server:push.reason.blocked.body'), short: t('server:push.reason.blocked.short') },
  failed: { body: t('server:push.reason.failed.body'), short: t('server:push.reason.failed.short') },
  done: { body: t('server:push.reason.done.body'), short: t('server:push.reason.done.short') },
  stopped: { body: t('server:push.reason.stopped.body'), short: t('server:push.reason.stopped.short') },
});
/** Only newly observed Task notices selected in the workspace's personal notification settings. */
export function deriveEvents(seen: ReadonlySet<string>, current: Tasks, balls: Balls, settings: SettingValues): Derived[] {
  return deriveHeldEvents(seen, holdingKeys(current, balls), settings);
}
function deriveHeldEvents(seen: ReadonlySet<string>, holding: Iterable<readonly [string, HeldNotice]>, settings: SettingValues): Derived[] {
  const events: Derived[] = [];
  const t = serverText(uiLocaleOrDefault(settings.language));
  for (const [key, { task, state, reason, at: occurredAt }] of holding) {
    if (seen.has(key) || settings[state === 'error' ? 'push.followup' : `push.${state}`] !== true) continue;
    const reportTitle = task.log.find(entry => entry.id === key.slice(task.id.length + 1))?.title;
    const label = noticeWords(t)[reason].body;
    events.push({ key, urgency: state === 'done' ? 'normal' : 'high', occurredAt, logCount: task.log.length,
      payload: { title: titleOf(task), body: reportTitle ? t('server:push.withReport', { label, reportTitle }) : label,
        url: taskUrl(task.id), tag: key } });
  }
  return events;
}

/** Replace one complete push snapshot atomically; the store serializes calls. */
export type PushFileWriter = (file: string, contents: string) => Promise<void>;
const replacePushFile: PushFileWriter = async (file, contents) => {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const fd = await open(temporary, 'wx', FILE_MODE);
    try { await fd.writeFile(contents); await fd.sync(); } finally { await fd.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
};

export class PushStore {
  private readonly file: string;
  private data!: PushFile;
  private sending: Promise<void> | undefined;
  private holding: ReturnType<typeof holdingKeys> = new Map();
  private hostHolding: string | null = null;
  private readonly seen = new Set<string>();
  private readonly taskKeys = new Map<string, ReadonlySet<string>>();
  private writes: Promise<void> = Promise.resolve();
  private seenVersion = 0;
  private savedSeenVersion = 0;
  private seenTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private closed: Promise<void> | undefined;
  private constructor(root: string, private readonly subject: string, private readonly sender: PushSender, private readonly log: (line: string) => void, private readonly writer: PushFileWriter) {
    this.file = join(root, META_DIRECTORY, PUSH_FILE);
  }
  /** Reads or creates `push.json`; a file that cannot be read or parsed is a start-up failure. */
  static async open(root: string, options: { subject: string; sender?: PushSender; log?: (line: string) => void; writer?: PushFileWriter }): Promise<PushStore> {
    const store = new PushStore(root, options.subject, options.sender ?? defaultSender, options.log ?? (line => console.error(line)), options.writer ?? replacePushFile);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(store.file, 'utf8')); }
    catch (error) {
      if (!hasCode(error, 'ENOENT')) throw pushUnavailable(error);
      store.data = { version: PUSH_VERSION, vapid: await generateVapid(), subscriptions: [], events: [], seen: [] };
      await store.persist(store.data);
      return store;
    }
    try { store.data = fileSchema.parse(raw); }
    catch (error) { throw pushUnavailable(error); }
    for (const key of store.data.seen) {
      store.seen.add(key);
      if (key === INITIALIZED) continue;
      const task = key.slice(0, key.indexOf(':'));
      const keys = new Set(store.taskKeys.get(task));
      keys.add(key); store.taskKeys.set(task, keys);
    }
    return store;
  }
  /** All durable mutations and seen snapshots share this queue, including after a failed write. */
  private enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.writes.then(work);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }
  private ensureOpen(): void {
    if (this.closing) throw pushUnavailable(new Error('Push store is closing'));
  }
  private stopSeenTimer(): void {
    if (this.seenTimer) clearTimeout(this.seenTimer);
    this.seenTimer = undefined;
  }
  private scheduleSeen(): void {
    if (this.closing || this.seenTimer || this.seenVersion === this.savedSeenVersion) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = undefined;
      void this.enqueue(() => this.flushSeen()).catch(error => this.log(`Push seen save failed: ${String(error)}`));
    }, 1000);
    this.seenTimer.unref();
  }
  private async persist(next: PushFile, seen: ReadonlySet<string> = this.seen): Promise<void> {
    this.stopSeenTimer();
    const snapshot = { ...next, seen: [...seen] };
    try { await this.writer(this.file, JSON.stringify(snapshot)); }
    catch (error) { throw pushUnavailable(error); }
    this.data = snapshot;
    this.savedSeenVersion = this.seenVersion;
  }
  private async flushSeen(): Promise<void> {
    if (this.seenVersion !== this.savedSeenVersion) await this.persist(this.data);
  }
  /** Commit memory only after file replacement succeeds. Seen-only updates never clone the file. */
  private async commit<T>(change: (draft: PushFile) => T, seen: ReadonlySet<string> = this.seen): Promise<T> {
    const draft = structuredClone(this.data);
    const result = change(draft);
    await this.persist(draft, seen);
    return result;
  }
  private edit<T>(change: (draft: PushFile) => T): Promise<T> {
    return this.enqueue(() => this.commit(change));
  }
  private event(key: string, change: (event: PushEvent) => void): Promise<void> {
    return this.edit(draft => { const event = draft.events.find(event => event.key === key); if (event) change(event); });
  }
  get publicKey(): string { return this.data.vapid.publicKey; }
  devices(): PushDevice[] {
    return this.data.subscriptions.map(({ id, label, created_at, subscription }) => ({ id, label, created_at, endpoint: subscription.endpoint }));
  }
  async subscribe(input: PushSubscriptionInput, label: string): Promise<{ id: string }> {
    this.ensureOpen();
    const subscription = input;
    const id = deviceId(subscription.endpoint);
    const device: Device = { id, label: clip(label.trim(), 80), created_at: new Date().toISOString(), subscription };
    await this.edit(draft => {
      const existing = draft.subscriptions.findIndex(item => item.id === id);
      if (existing >= 0) draft.subscriptions[existing] = { ...device, created_at: draft.subscriptions[existing]!.created_at };
      else draft.subscriptions.push(device);
    });
    return { id };
  }
  async unsubscribe(id: string): Promise<{ removed: boolean }> {
    this.ensureOpen();
    return this.removeDevice(id);
  }
  private removeDevice(id: string): Promise<{ removed: boolean }> {
    return this.enqueue<{ removed: boolean }>(() => {
      if (!this.data.subscriptions.some(item => item.id === id)) return { removed: false };
      return this.commit(draft => {
        draft.subscriptions = draft.subscriptions.filter(item => item.id !== id);
        for (const event of draft.events) delete event.deliveries[id];
        return { removed: true };
      });
    });
  }
  private append(draft: PushFile, event: Derived, now: number): boolean {
    draft.events = draft.events.filter(event => Date.parse(event.created_at) > now - EVENT_RETENTION_MS);
    if (draft.events.some(item => item.key === event.key)) return false;
    const at = new Date(now).toISOString();
    draft.events.push({ key: event.key, payload: pushPayloadSchema.parse(event.payload), urgency: event.urgency,
      created_at: event.occurredAt, log_count: event.logCount ?? 0, pending: false,
      deliveries: Object.fromEntries(draft.subscriptions.map(device => [device.id, { attempts: 0, next_at: at, error: '' }])) });
    return true;
  }
  /** Records an event for every current device unless its key was already recorded. */
  async record(event: Derived, now = Date.now()): Promise<{ event: string; recipients: number; created: boolean }> {
    this.ensureOpen();
    return this.edit(draft => {
      const created = this.append(draft, event, now);
      return { event: event.key, recipients: created ? draft.subscriptions.length : 0, created };
    });
  }
  /**
   * The first successful Task read establishes a baseline. Later reads record
   * selected notices, including one that began while serve was down.
   */
  observe(tasks: Tasks, balls: Balls, settings: SettingValues, now = Date.now()): Promise<Derived[]> {
    this.ensureOpen();
    const holding = holdingKeys(tasks, balls);
    // Full reads are the startup/test adapter; production sends only changed tasks.
    const changes = new Map<string, Map<string, HeldNotice>>(tasks.map(task => [task.id, new Map()]));
    for (const [key, notice] of holding) changes.get(notice.task.id)!.set(key, notice);
    return this.enqueue(() => {
      for (const id of this.taskKeys.keys()) if (!changes.has(id)) changes.set(id, new Map());
      return this.observeChanges(changes, settings, now);
    });
  }
  /** Replace just these tasks' current keys. An empty map removes a task, including its seen keys. */
  observeChanged(changes: ReadonlyMap<string, ReadonlyMap<string, HeldNotice>>, settings: SettingValues, now = Date.now()): Promise<Derived[]> {
    this.ensureOpen();
    const captured = new Map([...changes].map(([id, keys]) => [id, new Map(keys)]));
    return this.enqueue(() => this.observeChanges(captured, settings, now));
  }
  private async observeChanges(changes: ReadonlyMap<string, ReadonlyMap<string, HeldNotice>>, settings: SettingValues, now: number): Promise<Derived[]> {
    const derived = this.seen.has(INITIALIZED)
      ? deriveHeldEvents(this.seen, (function* () { for (const keys of changes.values()) yield* keys; })(), settings)
      : [];
    const fresh = derived.filter(event => !this.data.events.some(existing => existing.key === event.key && Date.parse(existing.created_at) > now - EVENT_RETENTION_MS));
    // A new event requires a durable snapshot before the observation resolves.
    const nextSeen = fresh.length ? new Set(this.seen) : this.seen;
    let changed = !nextSeen.has(INITIALIZED);
    nextSeen.add(INITIALIZED);
    for (const [id, keys] of changes) {
      const previous = this.taskKeys.get(id);
      for (const key of previous ?? []) if (!keys.has(key)) { nextSeen.delete(key); changed = true; }
      for (const key of keys.keys()) if (!nextSeen.has(key)) { nextSeen.add(key); changed = true; }
    }
    if (fresh.length) {
      await this.commit(draft => { for (const event of fresh) this.append(draft, event, now); }, nextSeen);
      this.seen.clear();
      for (const key of nextSeen) this.seen.add(key);
    }
    for (const [id, keys] of changes) {
      for (const key of this.taskKeys.get(id) ?? []) this.holding.delete(key);
      if (keys.size) this.taskKeys.set(id, new Set(keys.keys())); else this.taskKeys.delete(id);
      for (const [key, notice] of keys) this.holding.set(key, notice);
    }
    if (changed) {
      this.seenVersion++;
      if (fresh.length) this.savedSeenVersion = this.seenVersion;
      else this.scheduleSeen();
    }
    return fresh;
  }
  /** The tight host episode whose event may still be sent (`hostPushKey`); null once the machine is calm again. */
  holdHost(key: string | null): void { this.hostHolding = key; }
  /** Every pending delivery whose turn has come. One pass at a time. */
  tick(now = Date.now(), presence: PresenceStatus = { state: 'away', until: null }, notices: NoticeSnapshot = null, language: ServerLocale = defaultUiLocale): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.sending ??= this.deliver(now, presence, notices, language).catch(error => this.log(`Push delivery pass failed: ${String(error)}`)).finally(() => { this.sending = undefined; });
  }
  private async deliver(now: number, presence: PresenceStatus, notices: NoticeSnapshot, language: ServerLocale): Promise<void> {
    await this.writes;
    const byDevice = new Map<string, { event: PushEvent; delivery: Extract<PushEvent['deliveries'][string], { attempts: number }> }[]>();
    for (const event of this.data.events) {
      if (Date.parse(event.created_at) < now - DELIVERY_WINDOW_MS) {
        let closed = false;
        for (const [id, delivery] of Object.entries(event.deliveries)) {
          if (!('attempts' in delivery)) continue;
          closed = true;
        }
        if (closed) await this.event(event.key, current => {
          for (const [id, delivery] of Object.entries(current.deliveries))
            if ('attempts' in delivery) current.deliveries[id] = { closed_at: new Date(now).toISOString() };
        });
        continue;
      }
      for (const [id, delivery] of Object.entries(event.deliveries)) {
        if (!('attempts' in delivery) || delivery.attempts >= MAX_ATTEMPTS) continue;
        // A host event holds while its episode is tight; a Task event while its transition holds and is unread.
        const host = event.key.startsWith(HOST_PUSH_PREFIX);
        const current = host ? undefined : this.holding.get(event.key);
        const baseline = current && (notices?.reads[current.task.id] ?? notices?.checkpoint.tasks[current.task.id]);
        const opened = !!current && !!baseline && baseline.state === current.task.state &&
          baseline.log >= event.log_count && (!baseline.turnKey || event.key.endsWith(`:${baseline.turnKey}`));
        if (host ? event.key !== this.hostHolding : !current || opened) {
          await this.event(event.key, current => { current.deliveries[id] = { closed_at: new Date(now).toISOString() }; });
          continue;
        }
        if (presence.state !== 'away') {
          if (!event.pending) await this.event(event.key, current => { current.pending = true; });
          continue;
        }
        if (event.pending) await this.event(event.key, current => { current.pending = false; });
        if (Date.parse(delivery.next_at) > now) continue;
        const group = byDevice.get(id) ?? [];
        group.push({ event, delivery });
        byDevice.set(id, group);
      }
    }
    for (const [id, eligible] of byDevice) {
      const device = this.data.subscriptions.find(item => item.id === id);
      if (!device) {
        for (const { event } of eligible) await this.event(event.key, current => { delete current.deliveries[id]; });
        continue;
      }
      // One push request has one TTL. Keep the newest included notice alive.
      const group = eligible;
      const latest = group.reduce((at, { event }) => Math.max(at, Date.parse(event.created_at)), 0);
      const ttl = Math.max(1, Math.floor((latest + DELIVERY_WINDOW_MS - now) / 1000));
      const t = serverText(language), words = noticeWords(t);
      const payload = group.length === 1 ? group[0]!.event.payload : {
        title: t('server:push.groupTitle', { updateCount: group.length }),
        body: clip(group.map(({ event }) => {
          const current = this.holding.get(event.key);
          // Host events (or a missing Task context) use their existing title alone.
          return clip(current ? `${words[current.reason].short} ${event.payload.title}` : event.payload.title, 40);
        }).join('\n'), 180),
        url: '/', tag: `pending:${createHash('sha256').update(group.map(({ event }) => event.key).join(',')).digest('hex').slice(0, 16)}`,
      };
      const urgency = group.some(({ event }) => event.urgency === 'high') ? 'high' : 'normal';
      let status: number, retryAfter: number | undefined, error = '';
      try { ({ status, retryAfter } = await this.sender(device.subscription, payload, { urgency, ttl,
        vapid: { subject: this.subject, ...this.data.vapid } })); }
      catch (cause) { status = 0; error = cause instanceof Error ? cause.message : String(cause); }
      if (status === 404 || status === 410) {
        this.log(`Push subscription ${id} is gone (HTTP ${status}); removing it`);
        await this.removeDevice(id);
        continue;
      }
      for (const { event, delivery } of group) {
        if (status >= 200 && status < 300) await this.event(event.key, current => {
          if (current.deliveries[id]) current.deliveries[id] = { sent_at: new Date(now).toISOString() };
        });
        else {
          const attempts = status >= 400 && status < 500 && status !== 429 ? MAX_ATTEMPTS : delivery.attempts + 1;
          const message = error || `HTTP ${status}`;
          const wait = Math.max(RETRY_BASE_MS * 2 ** delivery.attempts, (retryAfter ?? 0) * 1000);
          await this.event(event.key, current => {
            if (current.deliveries[id]) current.deliveries[id] = { attempts, next_at: new Date(Date.now() + wait).toISOString(), error: message };
          });
          this.log(`Push to ${id} (${device.label}) failed for ${event.key}: ${message}${attempts >= MAX_ATTEMPTS ? '; giving up' : ''}`);
        }
      }
    }
  }
  close(): Promise<void> {
    return this.closed ??= (async () => {
      this.closing = true;
      this.stopSeenTimer();
      await this.sending;
      await this.enqueue(() => this.flushSeen());
    })();
  }
}
