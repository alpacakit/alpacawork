/** Executable capabilities derive numbers from each record Owner. */
import { updateCapabilitiesSchema } from './npm-records.js';
import { readManifest } from './package-closure.js';
import { JOURNAL_VERSION, newJournalVersion, loadJournal, type SwitchJournal } from './journal.js';
import { UPDATE_RECORD_VERSION } from './update-record.js';
import { completeSkillsReceiptSchema } from '@alpacawork/core/installed-skills';
import { installationVersion } from '../installation/store.js';
const one = (version: number) => ({ read: [version], write: version, migrate: [] });
const UPDATE_HANDOFF_VERSION = 1 as const;
export function updateCapabilities() {
  return { handoff: UPDATE_HANDOFF_VERSION, records: {
    update: one(UPDATE_RECORD_VERSION), installation: one(installationVersion),
    receipt: one(completeSkillsReceiptSchema.shape.version.value), journal: one(JOURNAL_VERSION),
  } };
}
/** Every record crosses the same handoff rule, including the actual journal representation. */
export class UpdateCompatibilityError extends Error {}
export function assertUpdateHandoff(target: string, place: { releases: string; workspace: string }): void {
  assertJournalUpdateHandoff(target, loadJournal(place));
}
/** The same handoff rule also validates a journal before its publication. */
export function assertJournalUpdateHandoff(target: string, journal: SwitchJournal | null): void {
  const facts = readManifest(target).alpacawork as {update?: unknown} | undefined;
  const parsed = updateCapabilitiesSchema.safeParse(facts?.update);
  if (!parsed.success) throw new UpdateCompatibilityError('Unsupported target update capabilities');
  if (parsed.data.handoff !== UPDATE_HANDOFF_VERSION) throw new UpdateCompatibilityError('Unknown update handoff version');
  const versions = { ...Object.fromEntries(Object.entries(updateCapabilities().records).map(([name, format]) => [name, format.write])),
    journal: newJournalVersion(journal) };
  for (const [name, version] of Object.entries(versions)) {
    const next = parsed.data.records[name];
    if (!next || !next.read.includes(version) || next.write !== version && !next.migrate.some(m => m.from === version && m.to === next.write))
      throw new UpdateCompatibilityError(`Target cannot read update ${name} version ${version}`);
  }
}
