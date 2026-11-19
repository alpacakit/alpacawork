/** The sole consent Owner and eligibility decision. Damaged facts fail closed. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { userConfigDirectory, userStateDirectory } from '@alpacawork/cli-kit';
import { type TelemetryStatus, TELEMETRY_CONSENT_VERSION, telemetryIdSchema, utcDay } from '@alpacawork/contract/telemetry';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { thisRelease } from '../release/location.js';
import { releaseKind } from '../release/edition.js';
import { readJson, writeJson } from './files.js';
/**
 * `id` is this PC's reporting number: a random UUID made the first time sending is chosen, the same after stopping and
 * choosing again, so what was sent can be deleted. Keys of earlier versions are dropped.
 */
export const consentSchema = z.object({ version: z.literal(1), choice: z.enum(['on', 'off']), consentVersion: z.number().int(),
  decidedAt: z.iso.datetime(), decidedBy: z.enum(['cli', 'screen']), id: telemetryIdSchema.optional() });
export type Consent = z.infer<typeof consentSchema>;
export type TelemetryPaths = { consent: string; state: string };
export function telemetryPaths(env: NodeJS.ProcessEnv): TelemetryPaths {
  return { consent: join(userConfigDirectory(env), 'telemetry.json'),
    state: join(userStateDirectory(env), 'telemetry') };
}
export type GateFacts = { env: NodeJS.ProcessEnv; source: boolean; edition: string;
  container: boolean; fixture: boolean; consent: Consent | null; now: number; latestDay?: string | null; invalid?: boolean };
export type TelemetryGate = Pick<TelemetryStatus, 'state' | 'blockedBy'>;
const enabled = (value: string | undefined) => value !== undefined && !['', '0', 'false'].includes(value);
export function telemetryGate(facts: GateFacts): TelemetryGate {
  const block = (blockedBy: NonNullable<TelemetryStatus['blockedBy']>): TelemetryGate => ({ state: 'blocked', blockedBy });
  if (['ALPACAWORK_TELEMETRY_DISABLED', 'DO_NOT_TRACK', 'CI'].some(key => enabled(facts.env[key]))) return block('env');
  if (['NODE_TEST_CONTEXT', 'VITEST', 'PLAYWRIGHT_TEST'].some(key => Object.hasOwn(facts.env, key))) return block('test');
  if (facts.container || Object.hasOwn(facts.env, 'container')) return block('container');
  if (facts.fixture) return block('fixture');
  if (facts.source) return block('source');
  if (facts.edition !== 'production') return block('edition');
  if (facts.invalid) return block('invalid_state');
  const consent = facts.consent;
  try {
    if (!Number.isFinite(facts.now) || (consent && Date.parse(consent.decidedAt) > facts.now) ||
      (facts.latestDay && facts.latestDay > utcDay(facts.now))) return block('clock');
  } catch { return block('clock'); }
  if (!consent || consent.choice === 'on' && consent.decidedBy !== 'screen') return { state: 'not_asked', blockedBy: null };
  if (consent.choice === 'on' && (consent.consentVersion !== TELEMETRY_CONSENT_VERSION || !consent.id)) return { state: 'needs_reask', blockedBy: null };
  return { state: consent.choice, blockedBy: null };
}
export class ConsentStore {
  constructor(readonly paths: TelemetryPaths) {}
  read(): Consent | null { const value = readJson(this.paths.consent); return value === null ? null : consentSchema.parse(value); }
  digest(): string { return createHash('sha256').update(JSON.stringify(this.read())).digest('hex'); }
  choose(choice: Consent['choice'], decidedBy: Consent['decidedBy'], now: number, expectedDigest?: string): { consent: Consent; changed: boolean } {
    let previous: Consent | null;
    try { previous = this.read(); }
    catch (error) { if (choice !== 'off') throw error; previous = null; }
    if (expectedDigest !== undefined && expectedDigest !== this.digest()) throw new Problem(PROBLEM_CODE.conflict, 'Telemetry consent changed; read it again', undefined,
      { reason: { kind: 'telemetry_consent_changed' } });
    const changed = !previous || previous.choice !== choice || previous.decidedBy !== decidedBy || previous.consentVersion !== TELEMETRY_CONSENT_VERSION
      || choice === 'on' && !previous.id;
    // The number is made once, when sending is first chosen; stopping keeps it, for deleting what it sent.
    const id = previous?.id ?? (choice === 'on' ? randomUUID() : undefined);
    const next: Consent = changed ? { version: 1, choice, consentVersion: TELEMETRY_CONSENT_VERSION,
      decidedAt: new Date(now).toISOString(), decidedBy, ...(id ? { id } : {}) } : previous!;
    if (changed) writeJson(this.paths.consent, next);
    if (changed || choice === 'off') this.clearPending();
    return { consent: next, changed };
  }
  clearPending(): void { for (const name of ['queue', 'marks', 'next.json']) rmSync(join(this.paths.state, name), { recursive: true, force: true }); }
}
export function runtimeFacts(root: string | undefined, env: NodeJS.ProcessEnv, consent: Consent | null, now: number, latestDay?: string | null): GateFacts {
  const release = thisRelease();
  return { env, consent, now, latestDay, source: release === null,
    edition: release ? releaseKind(release) : 'production',
    container: existsSync('/.dockerenv') || existsSync('/run/.containerenv'), fixture: !!root && existsSync(join(root, '.dev-fixture.json')) };
}
