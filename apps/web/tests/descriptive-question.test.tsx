import { answerTask } from './fixtures';
import { expect, test } from 'vitest';
import { decideOf, offeredChoices } from '../src/domain/questions';
import { choiceAnswer, serialize } from '../src/features/coordinator/editor/document';
import { splitMessage } from '../src/features/coordinator/editor/wire';
import { completionQuestion, descriptiveQuestion } from '../../../tests/fixtures/descriptive-question';

for (const [values, expected] of [
  [descriptiveQuestion, ['1-Include', '1-Defer', '1-other']],
  [completionQuestion, ['1-Accept', '1-stop', '1-other']],
] as const) {
  test(`concrete choice names keep their task and first-word answer, Stop and Other the app's own words: ${expected[0]}`, () => {
    // What the question asks as asking fixes it: the decide value's items.
    const question = decideOf(values.decide as Record<string, unknown>[])[0]!;
    const offered = offeredChoices(question, { stop: 'Stop', other: 'Other' });
    expect(offered.map(choice => choice.answer)).toEqual(expected);
    expect(offered.filter(choice => choice.recommended !== null).map(choice => choice.answer)).toEqual([expected[0]]);
    const task = 'T155', title = 'Fix state changes (T99 1-other-answer)';
    for (const choice of offered) {
      const badge = choiceAnswer(answerTask(task), 'Q1', question, choice);
      const wire = serialize({ type: 'doc', content: [{ type: 'paragraph', content: [
        { type: 'taskLabel', attrs: { id: task, title } },
        { type: 'answerLabel', attrs: badge },
      ] }] });
      expect(wire).toBe(`${task}（${title}） ${choice.answer}`);
      const parts = splitMessage(wire, new Set(), new Map([[task, title]]));
      expect(parts.filter(part => part.kind === 'task').map(part => part.id)).toEqual([task]);
      expect(parts.filter(part => part.kind === 'answer').map(part => part.text)).toEqual([choice.answer]);
      expect(badge.name).toBe(choice.name);
    }
  });
}
