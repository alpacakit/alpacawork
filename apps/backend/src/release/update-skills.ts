/** The accepted operation authorizes placement; the journal owns write start and the Store owns completion. */
import { bundledSkillSelection } from '@alpacawork/core/installed-skills';
import { ManagedSkillsWriter } from '../installation/skills.js';
import { saveJournal, type SwitchJournal } from './journal.js';
import { updateTarget, type UpdateOperation } from './update-record.js';
import type { SwitchPlace } from './switch.js';
export async function completeUpdateSkills(place: SwitchPlace, journal: SwitchJournal, op: UpdateOperation): Promise<void> {
  if (journal.phase !== 'target_ready') throw new Error('Skills require the same update at target_ready');
  if (op.opId !== journal.opId || op.workspace !== place.workspace || journal.workspace !== op.workspace ||
      journal.target !== updateTarget(place.releases, op)) throw new Error('Skills require the same accepted operation, workspace and target');
  if (!journal.skillsWriteStarted) { journal.skillsWriteStarted = true; saveJournal(place, journal); }
  await new ManagedSkillsWriter({ root: op.skills.root }).install({ version: 2, operationId: op.opId,
    release: journal.target, intent: { place: bundledSkillSelection(op.skills.place), remove: [] } });
}
