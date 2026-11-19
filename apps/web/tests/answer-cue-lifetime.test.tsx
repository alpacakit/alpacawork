import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useAnswerCueLifetime, useCueAnswer } from '../src/features/reader/answer-cue';

let press: ReturnType<typeof useCueAnswer>;
function Reader({ task = 'T1', disabled = false }: { task?: string; disabled?: boolean }) {
  useAnswerCueLifetime(task, 'task');
  press = useCueAnswer(disabled);
  return null;
}
const button = document.createElement('button');
afterEach(() => { cleanup(); button.remove(); });
function pending() {
  document.body.append(button);
  press({ button, task: 'T1', question: 'Q1', n: '1', answer: 'Option1', adds: true });
  expect(document.querySelectorAll('[data-answer-cue-hidden]')).toHaveLength(1);
}

it('unmount releases a pending press before any chip has been drawn', () => {
  const reader = render(<Reader />);
  pending();
  reader.unmount();
  expect(document.querySelector('[data-answer-cue-hidden]')).toBeNull();
});

it('changing the reader task releases pending work without changing the new reader', () => {
  const reader = render(<Reader />);
  pending();
  reader.rerender(<Reader task="T2" />);
  expect(document.querySelector('[data-answer-cue-hidden]')).toBeNull();
  reader.unmount();
});

function Note({ ready }: { ready: (select: ReturnType<typeof useCueAnswer>) => void }) {
  ready(useCueAnswer(false));
  return null;
}

it('a note outside the reader owns its pending work and transfers it when another source answers the same question', () => {
  let first!: ReturnType<typeof useCueAnswer>, second!: ReturnType<typeof useCueAnswer>;
  const note = render(<Note ready={select => { first = select; }} />);
  const other = render(<Note ready={select => { second = select; }} />);
  document.body.append(button);
  const answer = { button, task: 'T1', question: 'Q1', n: '1', answer: 'Option1', adds: true };
  first(answer);
  second({ ...answer, answer: 'Option2' });
  expect(document.querySelectorAll('[data-answer-cue-hidden]')).toHaveLength(1);
  note.unmount();
  expect(document.querySelectorAll('[data-answer-cue-hidden]')).toHaveLength(1);
  other.unmount();
  expect(document.querySelector('[data-answer-cue-hidden]')).toBeNull();
});

it('locking the input releases a pending press before it can hide a committed answer', () => {
  const reader = render(<Reader />);
  pending();
  reader.rerender(<Reader disabled />);
  expect(document.querySelector('[data-answer-cue-hidden]')).toBeNull();
});
