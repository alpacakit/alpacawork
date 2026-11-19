import { expect, test } from 'vitest';
import en from '../../../packages/i18n/src/locales/en/panels.json';
import ja from '../../../packages/i18n/src/locales/ja/panels.json';
import { AGENT_DRAFT_ISSUE_KINDS, agentDraftIssueKind } from '../src/features/panels/agent-settings-issues';

test('every displayed agent error category has Japanese and English wording, including the unknown fallback', () => {
  for (const kind of AGENT_DRAFT_ISSUE_KINDS) {
    for (const catalog of [ja, en]) expect(catalog.agentSettings.errors[kind].trim().length).toBeGreaterThan(0);
  }
  for (const catalog of [ja, en]) {
    for (const kind of ['withoutModel', 'withoutParam', 'withoutDuplicate'] as const) {
      const text = catalog.agentSettings.errors[kind];
      expect(text).toContain(catalog.settings.discard);
      expect(text).not.toMatch(/再読込|Load the latest/);
    }
  }
  expect(agentDraftIssueKind({ field: 'values', message: 'an unfamiliar contract error' })).toBe('invalidValue');
  expect(agentDraftIssueKind({ field: 'base', message: 'an unfamiliar contract error' })).toBe('invalidValue');
});
