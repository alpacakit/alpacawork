import { beforeAll, expect, test } from 'vitest';
import { i18n, startI18n } from '@alpacawork/i18n';
import { undoOfferCopy, type OperationFacts } from '../src/data/write-operation';
import { intentKey } from '../src/data/write-intent';

beforeAll(startI18n);
// The approved words, through the producer used by local admission. No keys are built from action names.
const cases = [
  ['message', 'coordinator/messages', '送信しました', 'Sent', '送信を取り消しました', 'Message cancelled'],
  ['sendback', 'coordinator/messages', '送信しました', 'Sent', '送信を取り消しました', 'Message cancelled'],
  ['continue', 'coordinator/messages', '送信しました', 'Sent', '送信を取り消しました', 'Message cancelled'],
  ['retry', 'coordinator/messages', '送信しました', 'Sent', '送信を取り消しました', 'Message cancelled'],
  ['report:approve', 'task/report', 'T416 を完了にしました', 'Marked T416 as done', '完了を取り消しました', 'Completion undone'],
  ['report:hold', 'task/report', 'T416 を保留にしました', 'Put T416 on hold', '保留を取り消しました', 'Hold undone'],
  ['report:unhold', 'task/report', 'T416 の保留を外しました', 'Took T416 off hold', '保留の解除を取り消しました', 'Back on hold'],
  ['write', 'move', 'T416 を移動しました', 'Moved T416', '移動を取り消しました', 'Move undone'],
  ['write', 'responsible', 'T416 の責任者を替えました', 'Replaced the owner of T416', '責任者の交代を取り消しました', 'Owner replacement undone'],
  ['write', 'task/archive', 'T416 をアーカイブしました', 'Archived T416', 'アーカイブを取り消しました', 'Archive undone'],
  ['write', 'task/delete', 'T416 を削除しました', 'Deleted T416', '削除を取り消しました', 'Deletion undone'],
  ['write', 'task/restore', 'T416 を復元しました', 'Restored T416', '復元を取り消しました', 'Restoration undone'],
  ['write', 'project/new', 'プロジェクトを作成しました', 'Created a project', 'プロジェクトの作成を取り消しました', 'Project creation undone'],
] as const;
for (const locale of ['ja', 'en'] as const) {
  test.each(cases)(`${locale}: %s / %s names the completed press in one line and what was undone`, async (action, path, ja, en, jaUndone, enUndone) => {
    await i18n.changeLanguage(locale);
    const row = { key: intentKey('/fixture', path, 'T416'), subject: { action, taskId: 'T416', label: 'Original title\nMore' } } as OperationFacts;
    const copy = undoOfferCopy(row);
    expect(copy).toMatchObject({ text: locale === 'ja' ? ja : en, undone: locale === 'ja' ? jaUndone : enUndone });
    // One line: what was typed or pressed on is not said back.
    expect(copy).not.toHaveProperty('detail');
  });
  test(`${locale}: unknown operations use the default cancellation`, async () => {
    await i18n.changeLanguage(locale);
    const row = { key: intentKey('/fixture', 'unknown', 'T416'), subject: { action: 'write', taskId: 'T416', label: '' } } as OperationFacts;
    expect(undoOfferCopy(row).undone).toBe(locale === 'ja' ? '取り消しました' : 'Undone');
  });
}
