import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { automationIdSchema, type AutomationSignalData } from '@alpacawork/contract/automation';
import { automationEventSource } from '@alpacawork/contract/automation-program';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { acceptSignal } from './signals.js';
import { readBundleAutomation } from './bundle-store.js';

const tokenPattern = '[A-Za-z0-9_-]{43}';
const hookPath = new RegExp('^/hooks/([^/]+)/(' + tokenPattern + ')$');
const absentToken = Buffer.alloc(43);

export function missingHook(): never {
  throw new Problem(PROBLEM_CODE.notFound, 'HTTP hook does not exist');
}

function hookToken(db: DatabaseSync, id: string): string | undefined {
  const row = db.prepare(`SELECT s.hook_token,json_extract(v.config,'$.on.event') AS event FROM automation_secrets s JOIN automations a ON a.id=s.automation_id
    JOIN automation_versions v ON v.automation_id=a.id AND v.digest=coalesce(a.live_digest,a.latest_digest)
    WHERE a.external_id=? AND a.deleted=0`).get(id);
  return typeof row?.hook_token === 'string' && automationEventSource(row.event) === 'signal' ? row.hook_token : undefined;
}

// A restored database can contain an older seed and lack receipts for later deliveries.
function deliveryToken(seed: string, generation: string): string {
  return createHmac('sha256', Buffer.from(seed, 'base64url')).update(generation).digest('base64url');
}

export function readHookUrl(db: DatabaseSync, id: string, origin: string, generation: string): string {
  const seed = hookToken(db, id);
  if (seed === undefined) missingHook();
  const token = deliveryToken(seed, generation);
  return new URL(`/hooks/${id}/${token}`, origin).href;
}

export function hookAddress(pathname: string): { id: string; token: string } {
  const match = hookPath.exec(pathname);
  if (!match || !automationIdSchema.safeParse(match[1]).success) missingHook();
  return { id: match[1]!, token: match[2]! };
}

/** Check again inside the write. While the request body arrived, the owner could have changed the hook. */
export function readHookTarget(db: DatabaseSync, { id, token }: ReturnType<typeof hookAddress>, generation: string) {
  const seed = hookToken(db, id);
  const current = seed === undefined ? absentToken : Buffer.from(deliveryToken(seed, generation));
  if (!timingSafeEqual(Buffer.from(token), current) || seed === undefined) missingHook();
  return readBundleAutomation(db, id);
}

export function receiveHook(db: DatabaseSync, address: ReturnType<typeof hookAddress>, delivery: { key: string; publicKey: string | null; data: AutomationSignalData[string] }, generation: string, now: Date) {
  const automation = readHookTarget(db, address, generation);
  if (!automation.enabled) return;
  return acceptSignal(db, automation, delivery.data, { kind: 'webhook' }, delivery.key, now, delivery.publicKey);
}
