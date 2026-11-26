import { setConversationState, SERVED } from './conversation-fixture';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import type { Editor } from '@tiptap/react';
import { Slice } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import { startI18n } from '@alpacawork/i18n';
import { piecesClip, readPieces, textClip, writeClip, type Piece } from '../src/lib/clipboard';
import { contentPieces, keepCopy, piecesContent } from '../src/features/coordinator/editor/clip';
import { LabelEditor } from '../src/features/coordinator/editor/LabelEditor';
import { useInputDraft } from '../src/features/coordinator/editor/draft';
import { useConversation } from '../src/features/coordinator/coordinator';
import { dto, screenData, tree, TestWorkspace } from './fixtures';
import { LONG_PRESS_MS, useLongPress } from '../src/lib/long-press';
import { guardPinchZoom } from '../src/lib/pinch-zoom';

/*
 * What a paste into the coordinator's input takes, and when a long press is one.
 */
const dataOf = (plain: string, html: string) => ({ files: [], getData: (type: string) => type === 'text/html' ? html : type === 'text/plain' ? plain : '' }) as unknown as DataTransfer;
beforeAll(() => startI18n());
beforeEach(() => setConversationState({ conversation: { id: 'clipboard-paste', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, turns: [], cancelled: [] } }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const current = () => (screen.getByRole('textbox') as HTMLElement & { editor: Editor }).editor;
const skills = [{ name: 'deploy', description: 'local', invocation: '/' as const }];
function Harness() {
  const draft = useInputDraft(); const editorRef = useRef<Editor | null>(null);
  return <LabelEditor draft={draft} catalog={{ status: 'ready', profile: 'claude', skills }} onSend={() => {}} disabled={false} attaching tall={false} placeholder="p" onLong={() => {}} editorRef={editorRef} />;
}
const workspace = (title = 'Current title') => <TestWorkspace data={screenData(tree({ tasks: [dto({ id: 'T1', title })] }))}><Harness /></TestWorkspace>;
/** A paste as ProseMirror hands it to the input (jsdom's events carry no clipboard of their own). */
function paste(plain: string, html: string) {
  const editor = current(); const event = { clipboardData: dataOf(plain, html), preventDefault() {} } as unknown as ClipboardEvent;
  act(() => { editor.view.someProp('handlePaste', handle => handle(editor.view, event, Slice.empty)); });
}
/** The input's own copy of all it holds, as its copy event writes it. */
function copyAll() {
  const values: Record<string, string> = {};
  const data = { clearData() {}, setData(type: string, value: string) { values[type] = value; } } as unknown as DataTransfer;
  const event = { clipboardData: data, preventDefault() {} } as unknown as ClipboardEvent;
  act(() => { current().commands.selectAll(); const view = current().view; view.someProp('handleDOMEvents', handlers => handlers.copy?.(view, event)); });
  return values;
}
const set = (content: JSONContent[]) => act(() => { current().commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content }] }); });
const inline = () => current().getJSON().content!.flatMap(block => block.content ?? []);

test('a pasted task is its label with its title as known when pasted, also from the input’s own copy', () => {
  const host = render(workspace('Old title'));
  set([{ type: 'taskLabel', attrs: { id: 'T1', title: 'Old title' } }]);
  const copied = copyAll();
  host.rerender(workspace('Current title'));
  act(() => current().commands.clearContent());
  paste(copied['text/plain']!, copied['text/html']!);
  expect(inline()).toEqual([{ type: 'taskLabel', attrs: { id: 'T1', title: 'Current title' } }]);
});

test('the words pasted are the words on the clipboard, whatever the input kept of its copy', () => {
  render(workspace());
  set([{ type: 'taskLabel', attrs: { id: 'T1', title: 'Current title' } }, { type: 'text', text: ' original instruction' },
    { type: 'answerLabel', attrs: { question: 'Q1', task: 'T1', n: '1', name: 'A', answer: '1-A' } }]);
  const copied = copyAll();
  act(() => current().commands.clearContent());
  paste(copied['text/plain']!.replace('original', 'edited'), copied['text/html']!.replace('original', 'edited'));
  expect(current().getText()).toContain('edited instruction');
  expect(current().getText()).not.toContain('original');
  // The answer it kept is its label again, at its place and as the same words; changed, it is its words.
  expect(inline().map(node => node.type)).toEqual(['taskLabel', 'text', 'answerLabel']);
  act(() => current().commands.clearContent());
  paste('x', copied['text/html']!.replace('>1-A<', '>2-B<'));
  expect(inline().map(node => node.type)).toEqual(['taskLabel', 'text']);
  expect(current().getText()).toContain('2-B');
});

test('an answer copied alone comes back as its label with its fixed question identity; another copy’s key or another app’s answer does not', () => {
  render(workspace());
  const attrs = { question: 'Q1', task: 'T1', n: '1', name: 'A', answer: '1-A' };
  set([{ type: 'answerLabel', attrs }, { type: 'text', text: ' words' }]);
  const copied = copyAll();
  act(() => current().commands.clearContent());
  paste(copied['text/plain']!, copied['text/html']!);
  expect(inline()[0]).toMatchObject({ type: 'answerLabel', attrs });
  keepCopy([]); // A newer copy: the older key names nothing now.
  act(() => current().commands.clearContent());
  paste(copied['text/plain']!, copied['text/html']!);
  expect(inline().map(node => node.type)).toEqual(['text']);
});

test('another server’s task stays its words after the typed-ID conversion would have run, and its skill too', async () => {
  render(workspace());
  paste('T1 ', '<a data-alpacawork="task" href="https://foreign.example/?task=T1">T1 </a>');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
  expect(inline().map(node => node.type)).toEqual(['text']);
  // A skill is taken only from this app's own copy (its origin): from another, or from no app, it is its words.
  const foreign = `<span data-alpacawork-origin="https://foreign.example"><span data-alpacawork="skill">/deploy</span></span>`;
  expect(readPieces(dataOf('/deploy', foreign))).toEqual([{ kind: 'text', text: '/deploy' }]);
  expect(readPieces(dataOf('/deploy', '<span data-alpacawork="skill">/deploy</span>'))).toEqual([{ kind: 'text', text: '/deploy' }]);
  const own = piecesClip([{ kind: 'skill', name: 'deploy', invocation: '/' }]);
  expect(readPieces(dataOf(own.plain, own.html!))).toEqual([{ kind: 'skill', name: 'deploy', invocation: '/' }]);
  expect(piecesContent(readPieces(dataOf(own.plain, own.html!))!, () => undefined, name => name === 'deploy' ? { ...skills[0]!, description: '' } : undefined, () => undefined)
    .flatMap(block => block.content ?? []).map(node => node.type)).toEqual(['skillLabel']);
});

test('the app’s own line breaks, leading and trailing too, are kept; another place’s blocks are lines', () => {
  const pieces: Piece[] = [{ kind: 'text', text: '\n\n' }, { kind: 'task', address: 'T1', label: 'T1 Current title' }, { kind: 'text', text: '\n\n' }];
  const clip = piecesClip(pieces);
  expect(readPieces(dataOf(clip.plain, clip.html!))).toEqual(pieces);
  expect(readPieces(dataOf('', `<div><p>One</p><p><a data-alpacawork="task" href="${location.origin}/?task=T1">T1</a></p></div>`)))
    .toEqual([{ kind: 'text', text: 'One\n' }, { kind: 'task', address: 'T1', label: 'T1' }]);
  // Deep HTML within the size read is read.
  expect(() => readPieces(dataOf('/deploy', '<div>'.repeat(1800) + '<span data-alpacawork="skill">/deploy</span>' + '</div>'.repeat(1800)))).not.toThrow();
});

test('in the coordinator’s own window (about:blank) a task of this app is still this app’s', () => {
  const blank = document.implementation.createHTMLDocument('');
  const clip = piecesClip([{ kind: 'task', address: 'T1', label: 'T1 x' }]);
  expect(readPieces(dataOf(clip.plain, clip.html!), blank)).toEqual([{ kind: 'task', address: 'T1', label: 'T1 x' }]);
});

test('a copy refused after a later one is not written again over it, nor said', async () => {
  class Item { constructor(readonly types: Record<string, Blob>) {} }
  vi.stubGlobal('ClipboardItem', Item);
  let reject!: (error: unknown) => void; let actual = '';
  const pending = new Promise<void>((_resolve, no) => { reject = no; });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: () => pending, writeText: async (text: string) => { actual = text; } } });
  const older = writeClip(piecesClip([{ kind: 'skill', name: 'older', invocation: '/' }]), { said: false });
  await writeClip(textClip('newer'), { said: false });
  reject(new DOMException('superseded', 'NotAllowedError'));
  await expect(older).resolves.toBe(false);
  expect(actual).toBe('newer');
});

function Held({ onLong, onClick = () => {} }: { onLong: () => void; onClick?: () => void }) {
  const press = useLongPress(onLong);
  return <><div data-testid="held" {...press.props}><button type="button" onClick={onClick}>inside</button></div><button type="button">outside</button></>;
}
const down = () => fireEvent.pointerDown(screen.getByText('inside'), { pointerId: 1, pointerType: 'touch', button: 0, isPrimary: true, clientX: 10, clientY: 10 });
const up = () => fireEvent.pointerUp(screen.getByText('inside'), { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 });
const hold = () => act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 50));

test('a long press ends with another finger anywhere, the window’s blur or a scroll, a release elsewhere, or a zoomed page', () => {
  vi.useFakeTimers();
  const onLong = vi.fn();
  render(<Held onLong={onLong} />);
  down(); fireEvent.pointerDown(screen.getByText('outside'), { pointerId: 2, pointerType: 'touch', button: 0, isPrimary: false }); hold(); up();
  down(); fireEvent.blur(window); hold(); up();
  expect(onLong).not.toHaveBeenCalled();
  // The focus leaving an element (the input) as the press lands does not end it.
  down(); fireEvent.blur(screen.getByText('outside')); hold(); up();
  expect(onLong).toHaveBeenCalledOnce(); onLong.mockClear(); act(() => vi.advanceTimersByTime(1000));
  down(); fireEvent.scroll(document); hold(); up();
  down(); hold(); fireEvent.pointerUp(screen.getByText('outside'), { pointerId: 1, pointerType: 'mouse' });
  expect(onLong).not.toHaveBeenCalled();
  const viewport = Object.assign(new EventTarget(), { scale: 2 });
  vi.stubGlobal('visualViewport', viewport);
  const unguard = guardPinchZoom(window);
  try { down(); hold(); up(); } finally { unguard(); }
  expect(onLong).not.toHaveBeenCalled();
  down(); hold(); up();
  expect(onLong).toHaveBeenCalledOnce();
});

test('the click a long press ends in is not pressed; the next press and a key’s click are their own', () => {
  vi.useFakeTimers();
  const onLong = vi.fn(), onClick = vi.fn();
  render(<Held onLong={onLong} onClick={onClick} />);
  down(); hold(); fireEvent.pointerUp(document.body, { pointerId: 1, pointerType: 'touch' });
  down(); act(() => vi.advanceTimersByTime(20)); up(); fireEvent.click(screen.getByText('inside'), { detail: 1 });
  expect(onClick).toHaveBeenCalledOnce();
  down(); hold(); up(); fireEvent.click(screen.getByText('inside'), { detail: 0 });
  expect(onLong).toHaveBeenCalledOnce(); expect(onClick).toHaveBeenCalledTimes(2);
});

test('each copy in a paste is its own: a skill is taken only inside this app’s, a kept piece only with its place', () => {
  const html = `<span data-alpacawork-origin="${location.origin}"><span data-alpacawork="skill">/local</span></span>`
    + '<span data-alpacawork-origin="https://foreign.example"><span data-alpacawork="skill">/deploy</span></span>'
    + '<span data-alpacawork="skill">/loose</span>';
  expect(readPieces(dataOf('', html))).toEqual([{ kind: 'skill', name: 'local', invocation: '/' }, { kind: 'text', text: '/deploy/loose' }]);
  const first = '<span data-alpacawork-origin="https://foreign.example"><span data-alpacawork="skill">/deploy</span></span>'
    + `<span data-alpacawork-origin="${location.origin}" data-alpacawork-copy="k"><span data-alpacawork="skill">/local</span><span data-alpacawork="kept" data-alpacawork-at="1">1-A</span></span>`;
  expect(readPieces(dataOf('', first))).toEqual([{ kind: 'text', text: '/deploy' }, { kind: 'skill', name: 'local', invocation: '/' }, { kind: 'kept', text: '1-A', at: 1, copy: 'k' }]);
  for (const at of ['', ' data-alpacawork-at=""', ' data-alpacawork-at="01"', ' data-alpacawork-at="1e2"', ' data-alpacawork-at="-1"'])
    expect(readPieces(dataOf('', `<span data-alpacawork-origin="${location.origin}" data-alpacawork-copy="k"><span data-alpacawork="kept"${at}>1-A</span></span>`)))
      .toEqual([{ kind: 'text', text: '1-A' }]);
});

test('a copy that a later one overtook says nothing of itself, and its button shows no ✓', async () => {
  let finish!: () => void; let calls = 0;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => ++calls === 1
    ? new Promise<void>(resolve => { finish = resolve; }) : Promise.reject(new DOMException('No', 'NotAllowedError')) } });
  const older = writeClip(textClip('a'), { said: false });
  await expect(writeClip(textClip('b'), { said: false })).resolves.toBe(false);
  finish();
  await expect(older).resolves.toBe(false);
});

test('a finger let go off the message, though its events still go to it, is no long press', () => {
  // A touch's events all go to where it was pressed.
  vi.useFakeTimers();
  const onLong = vi.fn();
  render(<Held onLong={onLong} />);
  const outside = screen.getByText('outside');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => outside });
  try {
    down(); hold(); up();
    // Let go off the screen: nothing is there.
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
    act(() => vi.advanceTimersByTime(1000)); down(); hold(); up();
    expect(onLong).not.toHaveBeenCalled();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => screen.getByText('inside') });
    act(() => vi.advanceTimersByTime(1000)); down(); hold(); up();
    expect(onLong).toHaveBeenCalledOnce();
  } finally { delete (document as { elementFromPoint?: unknown }).elementFromPoint; }
});

test('a copy button keeps the ✓ of its latest press, whatever an earlier press comes to after it', async () => {
  const { CopyButton } = await import('../src/components/ui/copy-button');
  let finish!: () => void; let calls = 0;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => ++calls === 1
    ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve() } });
  render(<CopyButton clip={() => textClip('x')} label="copy" />);
  const button = screen.getByRole('button');
  fireEvent.click(button);
  fireEvent.click(button);
  await vi.waitFor(() => expect(button.dataset.copy).toBe('done'));
  await act(async () => { finish(); await Promise.resolve(); });
  expect(button.dataset.copy).toBe('done');
});
