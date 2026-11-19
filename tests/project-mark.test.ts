/** A project's mark takes its letters from its name, its letters' colour from its square, and one regular colour. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, inkOn, markLetters, MARK_SWATCHES, newProjectColor, shortOrFullColor, sixDigitColor }
  from '../apps/web/src/domain/project-mark.ts';

test('the letters are the first two ASCII letters or digits, else the one character, else P', () => {
  assert.equal(markLetters('alpacawork'), 'AL');
  assert.equal(markLetters('alpacashop'), 'AL');
  assert.equal(markLetters('2024年の振り返り'), '20');
  assert.equal(markLetters('A案件'), 'A');
  // A run stops at a space, symbol or a grapheme containing a combining mark.
  for (const name of ['a b', 'a#b', 'ab\u0301c']) assert.equal(markLetters(name), 'A');
  assert.equal(markLetters('a\u0301bc'), 'a\u0301');
  assert.equal(markLetters('あいう'), 'あ');
  assert.equal(markLetters('家計簿アプリ'), '家');
  assert.equal(markLetters('  「test2」'), 'TE');
  assert.equal(markLetters('#★ x'), 'X');
  assert.equal(markLetters('Ａ全角'), 'Ａ');
  assert.equal(markLetters('🐪らくだ'), 'ら');
  // An emoji's variation selector, a joined emoji and a zero-width space are skipped with it, never drawn as an empty square.
  assert.equal(markLetters('⭐️プロジェクト'), 'プ');
  assert.equal(markLetters('👨‍💻開発'), '開');
  assert.equal(markLetters('\u200b\ufeffalpha'), 'AL');
  // One character is one grapheme: a separate voiced mark stays with its kana.
  assert.equal(markLetters('か\u3099き'), 'か\u3099');
  assert.equal(markLetters(''), 'P');
  assert.equal(markLetters(' ・。! '), 'P');
});

test('only six hex digits are a colour while typing; three count when the field is left', () => {
  assert.equal(sixDigitColor('#2F6A9C'), '#2f6a9c');
  assert.equal(sixDigitColor('2f6a9c'), '#2f6a9c');
  for (const partial of ['1b2', '#1b2', '1b2a', '#1b2a9', '#1b2a9cc', 'zzzzzz', '']) assert.equal(sixDigitColor(partial), null, partial);
  assert.equal(shortOrFullColor('ABC'), '#aabbcc');
  assert.equal(shortOrFullColor('#123'), '#112233');
  assert.equal(shortOrFullColor('#2f6a9c'), '#2f6a9c');
  for (const partial of ['1b', '1b2a', '#12345', 'xyz']) assert.equal(shortOrFullColor(partial), null, partial);
});

test('the letters are white or black, whichever contrasts more, compared unrounded', () => {
  assert.equal(inkOn('#000000'), '#ffffff');
  assert.equal(inkOn('#ffffff'), '#000000');
  assert.equal(inkOn('#39659b'), '#ffffff');
  assert.equal(inkOn('#f2d230'), '#000000');
  // #777777: black 4.69 against white 4.48; rounding both to 4.5 would tie.
  assert.ok(contrastRatio('#777777', '#000000') > contrastRatio('#777777', '#ffffff'));
  assert.equal(inkOn('#777777'), '#000000');
  for (const { color } of MARK_SWATCHES) assert.ok(contrastRatio(color, inkOn(color)) >= 4.5, color);
});

test("a new project takes the often-used colour farthest from the ones in use", () => {
  assert.equal(newProjectColor([]), MARK_SWATCHES[0].color);
  const navy = MARK_SWATCHES[0].color;
  const second = newProjectColor([navy]);
  assert.notEqual(second, navy);
  assert.ok(MARK_SWATCHES.some(({ color }) => color === second));
  // Every often-used colour taken, the next still is one of them: colours repeat, letters and IDs tell projects apart.
  assert.ok(MARK_SWATCHES.some(({ color }) => color === newProjectColor(MARK_SWATCHES.map(({ color }) => color))));
  // A colour already in use is never the pick while an unused one remains.
  const used = MARK_SWATCHES.slice(0, 7).map(({ color }) => color);
  assert.equal(newProjectColor(used), MARK_SWATCHES[7].color);
});
