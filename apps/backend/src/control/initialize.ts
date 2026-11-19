/** Create a fresh workspace once, then return the identity owned by its control database. */
import { buildControlDatabaseImage, controlDatabasePath, openControlDatabase } from '@alpacawork/db';
import { CONFIG_FILE, initialControlDocument } from '@alpacawork/raw';
import { initialFirstRun, canonicalLanguageTag } from '@alpacawork/contract';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { randomUUID } from 'node:crypto';
import { initialAgentsTemplate } from '../agents-settings.js';
import type { DetectedSetupAgent } from '../installation/setup-ai.js';
import { FileWriter } from '../raw/storage.js';
import { TaskRepository } from './task-store.js';
import { FIRST_RUN_FILE } from '../receiver/person-state.js';

export const SAMPLE_PROJECT_NAME = 'Sample Project';
export async function initializeWorkspace(root: string, detected: readonly DetectedSetupAgent[] = [], options: { firstRun?: boolean; language?: string } = {}) {
  const language = options.language === undefined ? null : canonicalLanguageTag(options.language);
  if (options.language !== undefined && !language) throw new Problem(PROBLEM_CODE.invalidInput, '--lang must be a BCP 47 language tag');
  const writer = FileWriter.createFresh(root);
  try {
    return await writer.exclusive(async () => {
      const { image, value: id } = buildControlDatabaseImage(db =>
        new TaskRepository(writer.root, db).create('project', id => ({ values: {}, settings: { color: '#39659b' },
          meta: initialControlDocument(id, null, SAMPLE_PROJECT_NAME,
            { kind: 'project', userRequested: false, actor: { kind: 'human' } }) })));
      writer.createFile(writer.root, CONFIG_FILE, Buffer.from(initialAgentsTemplate(detected)));
      writer.createFile(writer.meta, controlDatabasePath(writer.root).split('/').at(-1)!, image);
      if (options.firstRun !== false) writer.createFile(writer.meta, FIRST_RUN_FILE, Buffer.from(JSON.stringify({
        version: 1, revision: randomUUID(), value: initialFirstRun(id),
      })));
      if (language) writer.createFile(writer.meta, 'personal-settings.json', Buffer.from(JSON.stringify({
        version: 1, revision: randomUUID(), value: { language: new Intl.Locale(language).language === 'ja' ? 'ja' : 'en', 'ai.language': language },
      })));
      const db = openControlDatabase(writer.root, { busyTimeoutMs: 1000 }, true);
      try {
        const workspaceIdentity = String(db.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()!.id);
        return { root: writer.root, initializedProject: { id, title: SAMPLE_PROJECT_NAME }, workspaceIdentity };
      } finally { db.close(); }
    });
  } finally { writer.close(); }
}
