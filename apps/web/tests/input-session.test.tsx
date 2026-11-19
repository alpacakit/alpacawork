import { Fragment, StrictMode, useRef } from 'react';
import { startI18n } from '@alpacawork/i18n';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OpeningForm, focusOpeningForm, useOpeningFocus } from '../src/lib/opening-focus';
import { InlineForm } from '../src/features/forms/InlineForm';
import { useDialogStore } from '../src/state/dialog-store';
import { openInput, closeInput } from '../src/state/open-input';
import { useViewStore } from '../src/state/view-store';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../src/data/query-client';

beforeAll(() => startI18n());
afterEach(() => { cleanup(); useDialogStore.getState().close(); queryClient.clear(); vi.restoreAllMocks(); });
const show = (strict = false) => {
  const Wrapper = strict ? StrictMode : Fragment;
  useViewStore.getState().openReader('T9'); openInput({ form: 'responsible', taskId: 'T9' });
  const outside = vi.fn(closeInput);
  render(<Wrapper><QueryClientProvider client={queryClient}>
    <div data-input-view="T9"><button>Retry same Task</button><button onClick={() => openInput({ form: 'move', taskId: 'T9' })}>Change parent</button></div>
    <div data-input-view="T8"><button>Another Task view</button></div>
    <InlineForm submitLabel="Save" error={undefined} pending={false} onSubmit={() => {}} onCancel={closeInput} onOutside={outside}><textarea defaultValue="kept draft" /></InlineForm>
    <button>Outside</button>
  </QueryClientProvider></Wrapper>);
  return outside;
};
test('the Task’s display controls retain its one input; an ordinary outside press still dismisses it', () => {
  const outside = show(); const input = screen.getByRole('textbox'); input.focus(); (input as HTMLTextAreaElement).setSelectionRange(2, 4);
  fireEvent.pointerDown(screen.getByText('Retry same Task')); expect(outside).not.toHaveBeenCalled();
  expect(useDialogStore.getState().dialog).toMatchObject({ form: 'responsible', taskId: 'T9' }); expect(screen.getByRole('textbox')).toBe(input);
  fireEvent.pointerDown(screen.getByText('Outside')); expect(outside).toHaveBeenCalledOnce(); expect(useDialogStore.getState().dialog).toBeNull();
});
test('displaying another Task is outside; changing input and explicitly cancelling still end the prior session', () => {
  const outside = show(); fireEvent.pointerDown(screen.getByText('Another Task view')); expect(outside).toHaveBeenCalledOnce();
  openInput({ form: 'responsible', taskId: 'T9' }); fireEvent.click(screen.getByText('Change parent'));
  expect(useDialogStore.getState().dialog).toMatchObject({ form: 'move' });
  useViewStore.getState().openReader('T8'); expect(useDialogStore.getState().dialog).toBeNull();
  useViewStore.getState().openReader('T9'); openInput({ form: 'responsible', taskId: 'T9' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(useDialogStore.getState().dialog).toBeNull();
});

/** Model the browser's cancellation contract: a cancelled frame is never invoked. */
function openingFrames() {
  let next = 0;
  const held = new Map<number, FrameRequestCallback>();
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { held.set(++next, callback); return next; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(frame => { held.delete(frame); });
  return { pending: () => held.size, flush: () => { for (const [id, frame] of [...held]) { held.delete(id); frame(0); } } };
}
for (const strict of [false, true]) test.each(['untouched', 'selection', 'other', 'returned'] as const)(
  `opening focus preserves later choices and caret, StrictMode=${strict}, %s`, choice => {
    const frames = openingFrames();
    render(<button>Opening control</button>);
    const opener = screen.getByText('Opening control'); opener.focus();
    show(strict);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(frames.pending()).toBe(1);
    if (choice === 'selection') { input.focus(); input.setSelectionRange(2, 4); }
    if (choice === 'other' || choice === 'returned') screen.getByText('Retry same Task').focus();
    if (choice === 'returned') opener.focus();
    frames.flush();
    expect(document.activeElement).toBe(choice === 'returned' ? opener : choice === 'other' ? screen.getByText('Retry same Task') : input);
    if (choice === 'selection') expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4]);
    if (choice === 'untouched') expect([input.selectionStart, input.selectionEnd]).toEqual([input.value.length, input.value.length]);
  });
test('cancel/unmount cancels the old opening frame and a reopened form gets its own request', () => {
  const frames = openingFrames(); show(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(useDialogStore.getState().dialog).toBeNull();
  cleanup();
  expect(frames.pending()).toBe(0);
  frames.flush(); expect(document.activeElement).toBe(document.body);
  show(true); expect(frames.pending()).toBe(1); frames.flush();
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(input.value.length);
});


// A reader owns the request before the form exists. The form shares its DOM ref, including through a portal.
function AwaitingInput({ ready, choiceVisible = true }: { ready: boolean; choiceVisible?: boolean }) {
  const form = useRef<HTMLFormElement>(null), title = useRef<HTMLHeadingElement>(null);
  useOpeningFocus(true, () => () => ({ complete: !!form.current, focus: () => {
    if (!focusOpeningForm(form.current)) title.current?.focus();
  } }));
  return <OpeningForm value={form}><h2 ref={title} tabIndex={-1}>Waiting title</h2>{choiceVisible && <button>Later choice</button>}
    {ready && <InlineForm submitLabel="Save" error={undefined} pending={false} onSubmit={() => {}}><textarea defaultValue="kept draft" /></InlineForm>}
  </OpeningForm>;
}
for (const strict of [false, true]) for (const arrival of ['ready-first', 'waiting-first', 'later-choice', 'ready-later-choice'] as const)
  test(`one input request spans arrival: ${arrival}, StrictMode=${strict}`, () => {
    const frames = openingFrames(), Wrapper = strict ? StrictMode : Fragment;
    const element = (ready: boolean) => <Wrapper><QueryClientProvider client={queryClient}><AwaitingInput ready={ready} /></QueryClientProvider></Wrapper>;
    const ready = arrival.startsWith('ready');
    const view = render(element(ready));
    // The old control no longer receives keys, before any frame and independently of field arrival.
    expect(document.activeElement).toBe(document.body);
    if (arrival === 'ready-later-choice') screen.getByText('Later choice').focus();
    if (!ready) {
      frames.flush(); expect(document.activeElement).toBe(screen.getByText('Waiting title'));
      if (arrival === 'later-choice') screen.getByText('Later choice').focus();
      view.rerender(element(true));
    }
    frames.flush();
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(arrival.endsWith('later-choice') ? screen.getByText('Later choice') : field);
    if (!arrival.endsWith('later-choice')) expect([field.selectionStart, field.selectionEnd]).toEqual([field.value.length, field.value.length]);
    view.unmount(); expect(frames.pending()).toBe(0);
  });

for (const reopen of [false, true]) test(`reader return belongs to its closing transition, reopen=${reopen}`, () => {
  const frames = openingFrames();
  render(<><button data-read="T9">Original row</button><input aria-label="Later input" /></>);
  const row = screen.getByText('Original row'), later = screen.getByLabelText('Later input');
  row.focus(); useViewStore.getState().openReader('T9');
  useViewStore.getState().closeReader(); row.blur();
  if (reopen) { useViewStore.getState().openReader('T8'); later.focus(); }
  frames.flush();
  expect(document.activeElement).toBe(reopen ? later : row);
});

for (const strict of [false, true]) test(`a disappeared choice resumes only an unfinished request, StrictMode=${strict}`, () => {
  const frames = openingFrames(), Wrapper = strict ? StrictMode : Fragment;
  const element = (ready: boolean, choiceVisible: boolean) => <Wrapper><QueryClientProvider client={queryClient}><AwaitingInput ready={ready} choiceVisible={choiceVisible} /></QueryClientProvider></Wrapper>;
  const view = render(element(false, true)); frames.flush();
  screen.getByText('Later choice').focus();
  view.rerender(element(false, false)); frames.flush();
  expect(document.activeElement).toBe(screen.getByText('Waiting title'));
  view.rerender(element(true, true)); frames.flush();
  const field = screen.getByRole('textbox'); expect(document.activeElement).toBe(field);
  screen.getByText('Later choice').focus();
  view.rerender(element(true, false)); frames.flush();
  // The request already finished: removal of a subsequent choice cannot resurrect it.
  expect(document.activeElement).toBe(document.body);
});

test('a surviving choice at target arrival finishes the opening without stealing or later resuming', () => {
  const frames = openingFrames();
  const element = (ready: boolean, choiceVisible: boolean) => <QueryClientProvider client={queryClient}><AwaitingInput ready={ready} choiceVisible={choiceVisible} /></QueryClientProvider>;
  const view = render(element(false, true)); frames.flush();
  const choice = screen.getByText('Later choice'); choice.focus();
  view.rerender(element(true, true)); frames.flush();
  expect(document.activeElement).toBe(choice);
  view.rerender(element(true, false)); frames.flush();
  expect(document.activeElement).toBe(document.body);
});

function OpeningIntent({ request, seen }: { request: unknown; seen: unknown[] }) {
  useOpeningFocus(request, previous => { seen.push(previous); return null; });
  return null;
}
test('each opening learns the request it follows; a React re-run of the same request follows nothing', () => {
  const input = {}, seen: unknown[] = [];
  const view = render(<OpeningIntent request={true} seen={seen} />);
  for (const request of [input, true, null, true]) view.rerender(<OpeningIntent request={request} seen={seen} />);
  expect(seen).toEqual([null, true, input, null]);
  const strict: unknown[] = [];
  render(<StrictMode><OpeningIntent request={true} seen={strict} /></StrictMode>);
  expect(strict).toEqual([null, null]);
});
