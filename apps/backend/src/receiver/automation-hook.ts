import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { AUTOMATION_SIGNAL_DATA_BYTES } from '@alpacawork/contract/automation';
import { automationJson } from '@alpacawork/contract/automation-program';
import { errorBody, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { hookAddress, missingHook, readHookTarget, receiveHook } from '../automations/hooks.js';
import { assertSignalDepth, type AutomationIngress } from '../automations/signals.js';
import { jsonHeaders } from './request-scope.js';

export const hookHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

async function readHookDelivery(req: IncomingMessage) {
  const headers = req.headersDistinct;
  const values = headers['idempotency-key'] ?? headers['webhook-id'];
  const supplied = values?.[0]?.trim();
  if (values && (values.length !== 1 || !supplied || supplied.length > 512))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Expected one delivery identifier of at most 512 characters');
  const key = supplied ?? randomUUID();
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
    throw new Problem(PROBLEM_CODE.invalidInput, 'Content-Type must be application/json');

  let size = 0;
  const chunks: Buffer[] = [];
  // Breaking early leaves the stream available for the receiver to send a bounded error response.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > AUTOMATION_SIGNAL_DATA_BYTES)
      throw new Problem(PROBLEM_CODE.tooLarge, 'Signal data exceeds 64 KiB');
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Problem(PROBLEM_CODE.invalidInput, 'Expected JSON');
  }
  assertSignalDepth(parsed);
  const data = automationJson.safeParse(parsed);
  if (!data.success) throw new Problem(PROBLEM_CODE.invalidInput, 'Expected JSON');
  return { key, publicKey: supplied ?? null, data: data.data };
}

type HookAdmission = {
  read: <T>(work: (db: DatabaseSync) => T) => T;
  write: <T>(work: (db: DatabaseSync) => T) => Promise<T>;
  admit: () => void;
  generation: () => string;
  ingress: AutomationIngress;
};

/** Capability URLs bypass generic request instrumentation and never become command receipts. */
export async function handleHook(req: IncomingMessage, res: ServerResponse, pathname: string, admission: HookAdmission) {
  try {
    if (req.method !== 'POST') missingHook();
    const address = hookAddress(pathname);
    const automation = admission.read(db => readHookTarget(db, address, admission.generation()));
    if (!automation.enabled) {
      res.writeHead(204, hookHeaders).end();
      return;
    }
    admission.admit();
    try { admission.ingress.take(automation.id); }
    catch (error) {
      if (!(error instanceof Problem && error.code === PROBLEM_CODE.busy)) throw error;
      res.writeHead(429, { ...hookHeaders, 'Retry-After': '60' }).end();
      return;
    }

    const deadline = setTimeout(() => {
      if (!req.complete && !res.headersSent)
        res.writeHead(408, { ...hookHeaders, Connection: 'close' }).end();
    }, 5000);
    let delivery: Awaited<ReturnType<typeof readHookDelivery>>;
    try { delivery = await readHookDelivery(req); }
    finally { clearTimeout(deadline); }
    if (res.headersSent || res.destroyed) return;

    const receipt = await admission.write(db => {
      admission.admit();
      return receiveHook(db, address, delivery, admission.generation(), new Date());
    });
    if (!receipt) res.writeHead(204, hookHeaders).end();
    else {
      res.writeHead(receipt.duplicate ? 200 : 202, { ...jsonHeaders, ...hookHeaders });
      res.end(JSON.stringify(receipt));
    }
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      const problem = error instanceof Problem ? error : new Problem(PROBLEM_CODE.unavailable, 'HTTP hook is temporarily unavailable');
      const connection = req.complete ? {} : { Connection: 'close' };
      res.writeHead(problem.status, { ...jsonHeaders, ...hookHeaders, ...connection });
      res.end(JSON.stringify(errorBody(problem)));
    }
  } finally { req.resume(); }
}
