import { expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAgentSetting, DEFAULT_LIMITS } from '@alpacawork/contract';
import { Problem } from '@alpacawork/core';
import { i18n, startI18n } from '@alpacawork/i18n';
import { apiError, errorText } from '../src/data/client';

test('an actual missing or non-executable command refusal translates its reason and shows the path once', async () => {
  const modulePath = '@alpacawork/backend/test-dist/agents-settings.js';
  const { launchSnapshot } = await import(modulePath);
  const root = mkdtempSync(join(tmpdir(), 'command-refusal-'));
  try {
    const blocked = join(root, 'blocked'); writeFileSync(blocked, '', { mode: 0o600 });
    await startI18n();
    for (const [command, detail] of [[join(root, 'missing'), 'not_found'], [blocked, 'not_executable']]) {
      let refusal: Problem | undefined;
      try { launchSnapshot({ limits: DEFAULT_LIMITS, agents: { codex: { ...defaultAgentSetting('codex'), command } } }, 'codex', 'start', root); }
      catch (error) { if (!(error instanceof Problem)) throw error; refusal = error; }
      if (!refusal) throw new Error('Command admission unexpectedly succeeded');
      expect(refusal?.reason).toEqual({ kind: 'agent_command_unavailable', path: command, detail });
      for (const language of ['en', 'ja']) {
        await i18n.changeLanguage(language);
        const text = errorText(apiError({ code: 'invalid_input', retry: 'fix', message: refusal.message, reason: refusal.reason }));
        expect(text.split(command!).length - 1).toBe(1);
        expect(text).not.toContain(detail!);
        if (language === 'ja') expect(text.replace(command!, '')).not.toMatch(/[A-Za-z]/);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
