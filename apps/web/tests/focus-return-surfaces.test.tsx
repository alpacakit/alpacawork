// Real popups and dialogs give the focus back to what opened them, however many replaced each other on the way.
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useRef, useState } from 'react';
import { startI18n } from '@alpacawork/i18n';
// A phone's width draws a popup as a bottom sheet; each test sets it (off unless said).
let narrow = false;
vi.mock('@/state/view-store', async (actual) => ({ ...await actual<object>(), useNarrow: () => narrow }));
import { Popup } from '@/components/ui/popup';
import { Dialog, DialogContent, DialogHeading } from '@/components/ui/dialog';
beforeAll(() => startI18n());
afterEach(() => { cleanup(); narrow = false; });
function Ordinary({ kind }: { kind: 'popup' | 'dialog' }) {
  const [open, setOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  return <><button ref={more} onClick={() => setOpen(true)}>open</button>
    {open && (kind === 'popup' ? <Popup open onOpenChange={setOpen} anchorRef={more} label="popup"><button onClick={() => setOpen(false)}>close</button></Popup>
    : <Dialog open onOpenChange={setOpen}><DialogContent aria-describedby={undefined}><DialogHeading title="dialog" /><button onClick={() => setOpen(false)}>close</button></DialogContent></Dialog>)}
  </>;
}
for (const kind of ['popup', 'dialog'] as const) it(`StrictMode ordinary ${kind} restores focus`, async () => {
  render(<StrictMode><Ordinary kind={kind} /></StrictMode>);
  const open = screen.getByText('open'); open.focus(); fireEvent.click(open);
  const close = await screen.findByText('close'); await waitFor(() => expect(document.activeElement).not.toBe(open));
  fireEvent.click(close); await waitFor(() => expect(document.activeElement).toBe(open));
});
function Sequence() {
  const [stage, setStage] = useState(-1);
  const more = useRef<HTMLButtonElement>(null);
  return <><button ref={more} onClick={() => setStage(0)}>more</button>
    {stage === 0 && <Popup open onOpenChange={() => setStage(-1)} anchorRef={more} label="menu"><button onClick={() => setStage(1)}>form</button></Popup>}
    {stage === 1 && <Popup open onOpenChange={() => setStage(-1)} anchorRef={more} label="form"><button onClick={() => setStage(2)}>confirm</button></Popup>}
    {stage === 2 && <Dialog open onOpenChange={() => setStage(-1)}><DialogContent aria-describedby={undefined}><DialogHeading title="confirm" /><button onClick={() => setStage(-1)}>finish</button></DialogContent></Dialog>}
  </>;
}
for (const strict of [false, true]) it(`two replaced surfaces preserve opener (StrictMode ${strict})`, async () => {
  render(strict ? <StrictMode><Sequence /></StrictMode> : <Sequence />);
  const more = screen.getByText('more'); more.focus(); fireEvent.click(more);
  const form = await screen.findByText('form'); await waitFor(() => expect(document.activeElement).toBe(form)); fireEvent.click(form);
  const confirm = await screen.findByText('confirm'); await waitFor(() => expect(document.activeElement).toBe(confirm)); fireEvent.click(confirm);
  const finish = await screen.findByText('finish');
  await waitFor(() => expect(document.activeElement?.getAttribute('data-slot')).toBe('dialog-title'));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  fireEvent.click(finish);
  await waitFor(() => expect(document.activeElement).toBe(more));
});

// A popup opened again from another opener (one that stays mounted, as the reader's state form): what its heading or its
// body opens goes back to this opening's opener, on a phone's sheet as on a computer's popover.
function Reopened({ from }: { from: 'heading' | 'body' }) {
  const [open, setOpen] = useState(false), [dialog, setDialog] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const go = <button onClick={() => { setOpen(false); setDialog(true); }}>go</button>;
  return <><button ref={anchor} onClick={() => setOpen(true)}>first</button><button onClick={() => setOpen(true)}>second</button>
    <Popup open={open} onOpenChange={setOpen} anchorRef={anchor} label="form" heading={<span>head{from === 'heading' && go}</span>}>
      <button onClick={() => setOpen(false)}>close</button>{from === 'body' && go}
    </Popup>
    {dialog && <Dialog open onOpenChange={setDialog}><DialogContent aria-describedby={undefined}><DialogHeading title="dialog" /><button onClick={() => setDialog(false)}>finish</button></DialogContent></Dialog>}
  </>;
}
for (const phone of [false, true]) for (const from of ['heading', 'body'] as const) it(`reopened from another opener, what its ${from} opens goes back there (${phone ? 'phone' : 'computer'})`, async () => {
  narrow = phone;
  render(<Reopened from={from} />);
  const first = screen.getByText('first'), second = screen.getByText('second');
  first.focus(); fireEvent.click(first);
  fireEvent.click(await screen.findByText('close'));
  await waitFor(() => expect(screen.queryByText('close')).toBeNull()); await frame(); await frame();
  second.focus(); fireEvent.click(second);
  const go = await screen.findByText('go'); await frame();
  go.focus(); fireEvent.click(go);
  const finish = await screen.findByText('finish'); await frame();
  fireEvent.click(finish);
  await waitFor(() => expect(document.activeElement).toBe(second));
});

// A modal over a modal. When the upper one closes and what opened it is gone (the settings' update button after
// a start), the focus stays in the modal still open, never on the page it covers; which modal is open is told by what
// covers what (Radix hides the rest from reading), not by the order of the page.
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function Stacked({ titled = true, remount = false }: { titled?: boolean; remount?: boolean }) {
  const [outer, setOuter] = useState(false), [inner, setInner] = useState(false), [startShown, setStartShown] = useState(true);
  const [generation, setGeneration] = useState(0);
  return <><button onClick={() => setOuter(true)}>gear</button>
    {outer && <Dialog key={generation} open onOpenChange={setOuter}>
      <DialogContent aria-describedby={undefined} {...titled ? {} : { 'aria-label': 'untitled' }}>
        {titled ? <DialogHeading title="settings" /> : null}
        {startShown && <button onClick={() => setInner(true)}>start</button>}
      </DialogContent>
    </Dialog>}
    {inner && <Dialog open onOpenChange={setInner}><DialogContent aria-describedby={undefined}><DialogHeading title="confirm" />
      <button onClick={() => { setInner(false); setStartShown(false); if (remount) setGeneration(value => value + 1); }}>go</button>
      <button onClick={() => setInner(false)}>keep</button></DialogContent></Dialog>}
  </>;
}
async function openInner() {
  const gear = screen.getByText('gear'); gear.focus(); fireEvent.click(gear);
  const start = await screen.findByText('start'); await frame(); start.focus(); fireEvent.click(start);
  await screen.findByText('go'); await frame();
  return { gear, start };
}
it('the opener still there inside the lower modal takes the focus back', async () => {
  render(<Stacked />);
  const { start } = await openInner();
  fireEvent.click(screen.getByText('keep'));
  await waitFor(() => expect(document.activeElement).toBe(start));
});
it('an opener gone inside the lower modal leaves the focus on its title, not on the page it covers', async () => {
  render(<Stacked />);
  const { gear } = await openInner();
  fireEvent.click(screen.getByText('go'));
  await waitFor(() => expect(document.activeElement?.textContent).toBe('settings'));
  expect(document.activeElement).not.toBe(gear);
});
it('a lower modal drawn again meanwhile gives its new title the focus', async () => {
  render(<Stacked remount />);
  const { gear } = await openInner();
  fireEvent.click(screen.getByText('go'));
  await waitFor(() => expect(document.activeElement?.textContent).toBe('settings'));
  expect(document.activeElement).not.toBe(gear);
  expect(document.activeElement?.isConnected).toBe(true);
});
it('a lower modal without a title keeps the focus off the page it covers', async () => {
  render(<Stacked titled={false} />);
  const { gear } = await openInner();
  fireEvent.click(screen.getByText('go'));
  await frame(); await frame();
  expect(document.activeElement).not.toBe(gear);
});
it('with no modal left, an opener gone gives the focus to the one before it, as ever', async () => {
  render(<Ordinary kind="dialog" />);
  const open = screen.getByText('open'); open.focus(); fireEvent.click(open);
  const close = await screen.findByText('close'); await waitFor(() => expect(document.activeElement).not.toBe(open));
  fireEvent.click(close); await waitFor(() => expect(document.activeElement).toBe(open));
});

// A button pressed inside a dialog that goes away under the focus (Postpone, Try again) leaves the
// focus on the dialog's title, as a start from the confirmation does, never on the dialog's own box.
function Vanishing() {
  const [shown, setShown] = useState(true);
  return <Dialog open onOpenChange={() => undefined}><DialogContent aria-describedby={undefined}><DialogHeading title="settings" />
    {shown && <button onClick={() => setShown(false)}>postpone</button>}<button>other</button></DialogContent></Dialog>;
}
it('a pressed button gone from an open dialog leaves the focus on its title', async () => {
  render(<Vanishing />);
  const postpone = await screen.findByText('postpone'); await frame(); postpone.focus();
  fireEvent.click(postpone);
  await waitFor(() => expect(document.activeElement?.getAttribute('data-slot')).toBe('dialog-title'));
});
it("the dialog's own box handed the focus gives it to the title", async () => {
  render(<Vanishing />);
  await screen.findByText('postpone'); await frame();
  (document.querySelector('[data-slot="dialog-content"]') as HTMLElement).focus();
  expect(document.activeElement?.getAttribute('data-slot')).toBe('dialog-title');
});
it("a press on the dialog's own box (selecting its words) keeps the focus there; a later catch still goes to the title", async () => {
  render(<Vanishing />);
  await screen.findByText('postpone'); await frame();
  const box = document.querySelector('[data-slot="dialog-content"]') as HTMLElement;
  fireEvent.pointerDown(box); box.focus();
  expect(document.activeElement).toBe(box);
  fireEvent.pointerUp(box);
  (document.querySelector('[data-slot="dialog-title"]') as HTMLElement).focus(); box.focus();
  expect(document.activeElement?.getAttribute('data-slot')).toBe('dialog-title');
});
