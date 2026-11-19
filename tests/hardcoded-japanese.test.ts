/**
 * Text that reaches a person — on the screen, in the terminal or in a
 * notification — is written in English and translated through the catalogs
 * (packages/i18n/README.md). Japanese written straight into the code skips
 * the catalog: an English reader sees it untranslated, and `pnpm i18n:check`
 * cannot see it because it only looks at `t("…")` keys. This finds it.
 *
 * Looked at: every string, template, regular expression and JSX text in the
 * code the browser runs — `apps/web/src` and `packages/contract/src`, which
 * `apps/web` imports — and in the code that writes to the terminal and sends
 * notifications, `apps/backend/src` and `apps/cli/src`. Comments are not text
 * a person reads there and are not looked at. Tests are not looked at either:
 * they write Japanese on purpose, to check the `ja` catalog.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const project = resolve(import.meta.dirname, '..');
const SCANNED = ['apps/web/src', 'packages/contract/src', 'apps/backend/src', 'apps/cli/src'];

/** CJK punctuation and ideographic space, kana, kanji, full-width forms. */
const JAPANESE = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

/**
 * Japanese that stays as written. Each entry is one file and the exact
 * literals allowed in it (without the line breaks and indent around JSX text); anything else in that file is still found.
 */
const ALLOWED: { file: string; why: string; texts: string[] }[] = [
  { file: 'packages/contract/src/task-tokens.ts', why: 'Task target punctuation and full-width IDs are shared input grammar.', texts: ['「', '」', '『', '』', '（', '）', '/[TtＴｔPpＰｐ][0-9０-９]+/'] },
  { file: 'apps/web/src/features/coordinator/editor/wire.ts', why: 'Wire delimiters and full-width input recognition are protocol syntax; screen labels use i18n.', texts: ["（","＃","／","|[/$][p{L}p{N}_][p{L}p{N}_:.-]*|[1-9]d*-[^s]+)(?=（|s|$)"] },
  { file: 'apps/web/src/features/coordinator/editor/LabelEditor.tsx', why: 'Full-width Task IDs are shared input grammar, like task-tokens.ts; this regular expression is not display copy.', texts: ["/[TtＴｔPpＰｐ][0-9０-９]+[\\s\\S]$/"] },
  { file: 'packages/contract/src/report-diff.ts', why: 'commitTitle strips task IDs in half- or full-width brackets from commit subjects; the brackets are input syntax, not display copy.', texts: ['s*[(（]', '[)）]', '([(（])'] },
  {
    file: 'apps/backend/src/control/task-values-migration.ts',
    why: 'The one-time migration reads stored Task bodies by the Japanese item titles and section names they were written with; these match old data and are shown to nobody.',
    texts: ['ゴール', '方針', '禁止事項', 'ユーザーの指示文', '結論', '残件', '動かしたままのもの', '完了条件', '成果物', 'PR（MR）', '/^- 進み具合: ([^\\r\\n]+)$/', '上に決めてほしいこと', '本文'],
  },
];

type Hit = { line: number; text: string };

/** Every literal in the source whose text contains Japanese. */
export function japaneseLiterals(source: string, fileName = 'source.tsx'): Hit[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    // `.text` rather than `getText()`: the scanner counts U+3000 as trivia, so a
    // JSX text that is only an ideographic space has an empty `getText()`.
    const text =
      ts.isStringLiteralLike(node) ||
      ts.isTemplateLiteralToken(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isJsxText(node)
        ? node.text
        : undefined;
    if (text !== undefined && JAPANESE.test(text)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      // Only the layout whitespace around JSX text is dropped; `trim()` would
      // also drop U+3000, which is itself what is being looked for.
      hits.push({ line: line + 1, text: text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

test('no Japanese is written straight into the code whose text reaches a person', () => {
  const tracked = execSync(`git ls-files ${SCANNED.join(' ')}`, { cwd: project, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && existsSync(join(project, f)));
  for (const folder of SCANNED) assert.ok(tracked.some((f) => f.startsWith(folder + '/')), `expected ${folder} to be scanned`);
  const offenders: string[] = [];
  for (const file of tracked) {
    const allowed = new Set(ALLOWED.find((a) => a.file === file)?.texts);
    for (const hit of japaneseLiterals(readFileSync(join(project, file), 'utf8'), file)) {
      if (!allowed.has(hit.text)) offenders.push(`${file}:${hit.line}: ${JSON.stringify(hit.text)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Write text for people in English and translate it through the catalogs (packages/i18n/README.md):\n${offenders.join('\n')}`,
  );
});

test('the allow list names only literals that are still there', () => {
  const stale: string[] = [];
  for (const { file, texts } of ALLOWED) {
    const found = new Set(japaneseLiterals(readFileSync(join(project, file), 'utf8'), file).map((h) => h.text));
    for (const text of texts) if (!found.has(text)) stale.push(`${file}: ${JSON.stringify(text)}`);
  }
  assert.deepEqual(stale, [], `remove these from ALLOWED:\n${stale.join('\n')}`);
});

test('the check finds Japanese in every kind of literal and nowhere else', () => {
  for (const source of [
    'const a = "保存";',
    "const a = '保存';",
    'const a = `保存`;',
    'const a = `${x} 件`;',
    'const a = /結論/;',
    'const a = <p>保存</p>;',
    'const a = <p aria-label="本文の表" />;',
    'const a = <p>{x}\u3000{y}</p>;',
    'const a = "ＡＢＣ";',
  ]) {
    assert.equal(japaneseLiterals(source).length, 1, `missed: ${source}`);
  }
  for (const source of [
    '// 保存',
    '/* 保存 */',
    '/** 保存 */ const a = "save";',
    'const a = <p>{/* 保存 */}Save</p>;',
    'const a = "○ ● ✓ — ·";',
  ]) {
    assert.equal(japaneseLiterals(source).length, 0, `false positive: ${source}`);
  }
});
