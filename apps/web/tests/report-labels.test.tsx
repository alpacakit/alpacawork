import { expect, test } from 'vitest';
import { firstReportLine, resultLine } from '../src/domain/report-labels';

test.each([
  ['', ''],
  ['\n\n', ''],
  ['\n# > - ** `\r\n\t\n', ''],
  ['\n# > - ** `\r\n\t**結果** `🙂` **完了** \r\n後続の本文', '結果 🙂 完了'],
  ['  見出し\r続き\n本文', '見出し\r続き'],
  ['日本語\u2028English\u2029العربية\n本文', '日本語\u2028English\u2029العربية'],
  ['1-決定 *保持* #後ろ >記号 -そのまま\n本文', '1-決定 *保持* #後ろ >記号 -そのまま'],
])('takes the first nonempty LF-delimited label from %j', (text, expected) => {
  expect(firstReportLine(text)).toBe(expected);
});

test.each([
  ['## 題\n点検の結果：合格\n## 説明\n本文', '点検の結果：合格'],
  ['**Title:** Review passed\nDetails', 'Review passed'],
  ['題名の付け方を直しました', '題名の付け方を直しました'],
  ['過去の記録を [調査結果](/home/x/report.md) にまとめました', '過去の記録を 調査結果 にまとめました'],
])('a result says its first line with words, past a part name and a link\'s address: %j', (text, expected) => {
  expect(resultLine(text)).toBe(expected);
});
