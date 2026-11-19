import type { SelectionProblem } from '@alpacawork/contract/agent-selection';
import { beforeAll, expect, test } from 'vitest';
import { businessReasonSchema } from '@alpacawork/core';
import { i18n, startI18n } from '@alpacawork/i18n';
import examples from '../../../tests/fixtures/business-reason-examples.json';
import { apiError, errorText, problemReasonText } from '../src/data/client';

beforeAll(() => startI18n());

test('update refusal keeps the domain reason and a classified cause in both languages', async () => {
  const { problemReasonSchema } = await import('@alpacawork/core');
  const reason = problemReasonSchema.parse({ kind: 'update_refused', reason: 'not_managed',
    cause: { kind: 'system_error', code: 'ENOENT', path: '/synthetic/switch.json', diagnostic: 'synthetic missing file' } });
  expect(problemReasonSchema.safeParse({ kind: 'update_refused', reason: '' }).success).toBe(false);
  expect(problemReasonSchema.safeParse({ kind: 'update_refused', reason: 'stale', cause: { kind: 'unknown' } }).success).toBe(false);
  for (const locale of ['en', 'ja']) {
    await i18n.changeLanguage(locale);
    const error = apiError({ code: 'conflict', retry: 'reread', message: 'UNTRANSLATED DIAGNOSTIC', reason });
    const text = errorText(error);
    for (const fact of ['not_managed', 'ENOENT', '/synthetic/switch.json', 'synthetic missing file']) expect(text).toContain(fact);
    expect(text).not.toContain('UNTRANSLATED DIAGNOSTIC');
    expect(text).not.toMatch(/problem\./);
    expect(problemReasonText(problemReasonSchema.parse({ kind: 'update_refused', reason: 'stale' }))).toContain('stale');
  }
});

test('every migrated refusal retains its prior English information and every fact in both languages', async () => {
  for (const example of examples) {
    const reason = businessReasonSchema.parse(example.reason);
    const error = apiError({ code: 'conflict', retry: 'reread', message: 'UNTRANSLATED DIAGNOSTIC', reason });
    await i18n.changeLanguage('en');
    expect(errorText(error), reason.kind).toBe(example.en);
    await i18n.changeLanguage('ja');
    const japanese = errorText(error);
    expect(japanese, reason.kind).not.toContain('UNTRANSLATED DIAGNOSTIC');
    expect(japanese, reason.kind).not.toBe('別の変更と競合しました。');
    expect(japanese, reason.kind).not.toMatch(/^problem\./);
    for (const [field, fact] of Object.entries(example.reason))
      if (field !== 'kind') expect(japanese, reason.kind).toContain(fact);
  }
});

test('permission failures translate machine seats and conditions instead of embedding English descriptions', async () => {
  const reason = { kind: 'authorization_required' as const, action: 'task.move', grants: [
    ['parent', 'within'], ['human'] ] };
  const parsed = (await import('@alpacawork/core')).problemReasonSchema.parse(reason);
  await i18n.changeLanguage('en');
  expect(problemReasonText(parsed)).toBe("Only the parent task owner's run when moving it while it stays under the run's own task, or the user can run task.move");
  await i18n.changeLanguage('ja');
  expect(problemReasonText(parsed)).toBe('task.moveを実行できるのは親タスクの責任者のRun Run自身のタスクの下に置いたまま移動する場合、または利用者です');
});

test('nested operation context preserves an already classified business reason', async () => {
  const reason = { kind: 'push_unavailable' as const, cause: {
    kind: 'run_store_unavailable' as const, cause: { kind: 'settings_changed' as const } } };
  await i18n.changeLanguage('en');
  expect(problemReasonText(reason)).toBe('Push notifications are unavailable: Cannot read or write runs: Settings changed. Reload and try again');
  await i18n.changeLanguage('ja');
  expect(problemReasonText(reason)).toBe('プッシュ通知を利用できません: Runを読み書きできません: 設定が変更されました。再読み込みしてからやり直してください');
});

test('installation record context retains the refusal and repair location in both languages', async () => {
  const reason = { kind: 'installation_record_unavailable' as const, path: '/tmp/本人 HOME/installation.json',
    cause: { kind: 'installation_workspace_changed' as const, path: '/tmp/workspace B' } };
  const parsed = (await import('@alpacawork/core')).problemReasonSchema.parse(reason);
  for (const locale of ['en', 'ja']) {
    await i18n.changeLanguage(locale);
    const text = problemReasonText(parsed);
    expect(text).toContain(reason.path);
    expect(text).toContain(reason.cause.path);
    expect(text).toContain('skills/alpacawork/references/troubleshoot.md#installation-record');
    expect(text).not.toContain('unexpected_error');
  }
});

test('an OS permission cause keeps its diagnostic and is not sent to record repair', async () => {
  const cause = { kind: 'system_error' as const, path: '/tmp/本人 HOME/alpacawork', syscall: 'open', code: 'EACCES', diagnostic: 'synthetic OS access refusal' };
  const parsed = (await import('@alpacawork/core')).problemReasonSchema.parse(
    { kind: 'installation_record_unavailable', path: '/tmp/本人 HOME/installation.json', cause });
  for (const locale of ['en', 'ja']) {
    await i18n.changeLanguage(locale);
    const text = problemReasonText(parsed);
    for (const fact of [cause.path, cause.syscall, cause.code, cause.diagnostic]) expect(text).toContain(fact);
    expect(text).not.toContain('skills/alpacawork/references/troubleshoot.md#installation-record');
  }
});

test('an archived-task refusal keeps archive wording in both languages', async () => {
  const reason = businessReasonSchema.parse({ kind: 'task_archived' });
  const error = apiError({ code: 'not_found', retry: 'fix', message: 'UNTRANSLATED DIAGNOSTIC', reason });
  for (const [locale, text] of [
    ['en', 'This task belongs to an archived project'],
    ['ja', 'このタスクのプロジェクトはアーカイブされています'],
  ]) {
    await i18n.changeLanguage(locale);
    expect(errorText(error)).toBe(text);
  }
});

test('a selection_required refusal says what each previous value needs, the conversation ending first, in both languages', async () => {
  const reason = businessReasonSchema.parse({ kind: 'selection_required', problems: [
    { key: 'model', previous: 'gpt-5', candidates: [null, 'gpt-6.1-sol'], reason: 'invalid_value', recovery: 'select_value' },
    { key: 'verbosity', previous: 'low', candidates: [], reason: 'removed', recovery: 'new_conversation' },
  ] });
  for (const locale of ['en', 'ja']) {
    await i18n.changeLanguage(locale);
    const text = problemReasonText(reason);
    // Not "choose again to go on": the conversation cannot go on.
    expect(text).not.toContain(i18n.t('problem.reason.selection_required'));
    expect(problemReasonText(businessReasonSchema.parse({ kind: 'selection_required', problems: [reason.kind === 'selection_required' ? reason.problems[0] : null] })))
      .toContain(i18n.t('problem.reason.selection_required'));
    // The conversation cannot go on, so choosing the model again is not asked for; it needs a new conversation.
    for (const fact of ['verbosity', 'low', i18n.t('forms:agentPicker.next.anew')]) expect(text).toContain(fact);
    expect(text).not.toContain('gpt-5');
    expect(text).not.toMatch(/agentPicker\./);
  }
});

test('a refused automatic wake says the business reason serve kept with it', async () => {
  const { ballSchema } = await import('@alpacawork/contract');
  const { turnSentence } = await import('../src/features/reader/TurnReason');
  await i18n.changeLanguage('en');
  const problemReason = { kind: 'selection_required', problems: [
    { key: 'model', previous: 'gpt-5', candidates: [null, 'gpt-6.1-sol'], reason: 'invalid_value', recovery: 'select_value' }] };
  const ball = ballSchema.parse({ holder: 'user', reason: 'blocked', at: '2026-11-05T00:00:00Z', key: 'K1', questionId: null, aboutRunId: null,
    count: null, code: 'selection_required', problemReason, failure: null });
  if (ball.holder !== 'user') throw new Error('user ball expected');
  expect(turnSentence(ball, i18n.getFixedT(null, 'ui'))).toBe(problemReasonText(businessReasonSchema.parse(problemReason)));
});

test("a Task's agent refused for a removed row is told it needs a new conversation, not the coordinator's clear button, which its picker keeps", async () => {
  const { ballSchema } = await import('@alpacawork/contract');
  const { turnSentence } = await import('../src/features/reader/TurnReason');
  const { renderHook } = await import('@testing-library/react');
  const { useChoiceText } = await import('../src/features/forms/choice-text');
  const removed: SelectionProblem = { key: 'verbosity', previous: 'low', candidates: [], reason: 'removed', recovery: 'new_conversation' };
  const ball = ballSchema.parse({ holder: 'user', reason: 'blocked', at: '2026-11-05T00:00:00Z', key: 'K1', questionId: null, aboutRunId: null,
    count: null, code: 'selection_required', problemReason: { kind: 'selection_required', problems: [removed] }, failure: null });
  if (ball.holder !== 'user') throw new Error('user ball expected');
  for (const locale of ['en', 'ja']) {
    await i18n.changeLanguage(locale);
    const said = turnSentence(ball, i18n.getFixedT(null, 'ui'));
    expect(said).toContain(i18n.t('forms:agentPicker.next.anew'));
    expect(said).not.toContain(i18n.t('ui:coordinatorCard.clear'));
    expect(renderHook(() => useChoiceText()).result.current.problem(removed)).toContain(i18n.t('ui:coordinatorCard.clear'));
  }
});
