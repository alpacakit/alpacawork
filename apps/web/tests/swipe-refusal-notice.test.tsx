import { afterEach, beforeAll, expect, test } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { ReaderSwipe } from '../src/features/reader/swipe-answer';
import { useReaderSend } from '../src/features/coordinator/reader-send';
import { notify, useToasts } from '../src/lib/notify';
import { at, screenData, taskFixture, TestWorkspace, tree, userBall } from './fixtures';

beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id); });

/** A failure stays until closed, so it must not keep a refused swipe silent where nothing else can say why. */
test('a refused swipe on a question not drawn says why even while another failure stays', async () => {
  const data = screenData(tree({ tasks: [taskFixture({ id: 'T1', ball: userBall('question', 'Q1', at, { questionId: 'Q1' }) })] }));
  const task = data.tasks.find(each => each.id === 'T1')!;
  useReaderSend.setState({ action: null, missing: { task: 'T1', question: 'Q1', n: '1', words: false } });
  function Reader({ enabled = false }: { enabled?: boolean }) {
    const box = useRef<HTMLElement>(null), content = useRef<HTMLDivElement>(null);
    return <TestWorkspace data={data}><aside ref={box}><div ref={content} data-area>Question folded</div>
      <ReaderSwipe task={task} box={box} reading={content} content={content} className="" enabled={enabled} /></aside></TestWorkspace>;
  }
  const view = render(<Reader />); view.rerender(<Reader enabled />);
  act(() => { notify.error('An earlier failure', { id: 'earlier' }); });
  for (const [type, x] of [['pointerdown', 40], ['pointermove', 210], ['pointerup', 220]] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: x, clientY: 200 });
    act(() => { document.querySelector('[data-area]')!.dispatchEvent(event); });
  }
  await waitFor(() => expect(useToasts.getState().toasts.map(each => each.id)).toEqual(['earlier', 'reader-refused']));
});
