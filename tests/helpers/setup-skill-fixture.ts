/** Give an isolated HOME the same required base skill and receipt that setup writes. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ManagedSkillsWriter } from '@alpacawork/backend/test-dist/installation/skills.js';

export async function seedSetupSkill(home: string, release: string): Promise<void> {
  await new ManagedSkillsWriter({ root: join(home, '.agents/skills') }).install({ version: 2,
    operationId: randomUUID(), release, intent: { place: ['alpacawork'], remove: [] } });
}
