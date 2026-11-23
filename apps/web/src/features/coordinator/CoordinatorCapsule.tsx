import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { COLUMN } from '@/features/reader/reading-column';
import { Button } from '@/components/ui/button';
import { useWorkspaceWritable, /* useWriteDisabled */ } from '@/data/queries';
import { attachmentsOf } from '@/domain/attachments';
import { useConversation } from './coordinator';
import { focusCoordinator, useInputDraft } from './editor/draft';
import { writtenIn } from './editor/document';
import { serialize, replyIn, hasContent } from './editor/document';
import { useReaderSend } from './reader-send';
import { messageTime } from './message-time';
import { DraftPreview, previewContent } from './DraftPreview';
// import { voiceAvailable } from './foot';
// import { inputSpeak } from './task-action-slot';
import { inputPlaceholder } from './editor/placeholder';
import { useProjectMarks } from '@/data/project-marks';
import { useSteadyControl } from '@/lib/steady-control';

/* Hallmark · component: the coordinator's input, folded to one line · genre: modern-minimal · theme: the app's own tokens
 * states: draft (what is written, kept) · empty (its placeholder; also after a failed read, which its toast says)
 *   · loading (the conversation not read yet; said once it takes a moment) · wanted (pressed meanwhile)
 */
/** A read that answers within this is not said: a usual load shows the line as it then stays. */
const SAY_LOADING_MS = 400;

/**
 * The input while it is down (`open` false): one line with round ends, at the screen's foot. It says what is written
 * and not sent, else where to write; what the conversation says is the way into it over the input (LastWordsPill).
 * A press on the line brings the input up to write; its action sends the draft, or brings it up recording when empty.
 */
// The line owns its draft and connection subscriptions; the frame following an animation changes neither.
export const CoordinatorCapsule = memo(function CoordinatorCapsule() {
  const { t, i18n } = useTranslation('ui');
  const marks = useProjectMarks();
  const draft = useInputDraft();
  // Writing is the device's own: serve out of reach, the line still brings the input up (only sending waits). Before the
  // conversation is read, or with a workspace that takes no writes at all, there is nothing to write toward.
  const read = useConversation(state => state.conversation !== null), writable = useWorkspaceWritable();
  const writing = read && writable;
  // Not read yet, the line says so and keeps a press: the conversation is read (again) and the input comes up once it is.
  // A failed read is said by its toast (coordinator.ts); meanwhile the line is the input's, as it is once read.
  const failed = useConversation(state => !!state.error), wanted = useConversation(state => state.wanted);
  const trying = useConversation(state => state.trying);
  const loading = writable && !read;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), SAY_LOADING_MS);
    return () => clearTimeout(timer);
  }, [loading]);
  const press = loading
    ? () => { useConversation.setState({ wanted: true }); useConversation.getState().retry(); } : () => focusCoordinator();
  // Read again (pressed, or on its own), it is loading again.
  const waiting = !loading || failed && !trying ? null : wanted ? 'wanted' : slow || failed ? 'loading' : null;
  const said = waiting && t(waiting === 'wanted' ? 'coordinatorCard.loadingWanted' : 'coordinatorCard.loading');
  // The microphone sends what is said to serve to be written out: out of reach, it waits.
  // const unreachable = useWriteDisabled(); // Initial release.
  const send = useReaderSend(state => state.sendDraft);
  // As the open input's button: a short wait does not dim it, and a press in one sends what was written then once it ends.
  const steady = useSteadyControl(!send, writtenIn(draft.entry.values));
  const attached = attachmentsOf(draft.entry.values);
  const content = hasContent(draft.doc, attached);
  // Keep the existing spoken draft name; the visible preview reads its labels and text from the document.
  const own = draft.doc;
  const reply = replyIn(draft.doc);
  // Shown is what the preview draws (labels, a reply, words), not what may be sent: a draft of Task labels alone is
  // nothing to send, yet says whom the input is for.
  const preview = previewContent(draft.doc), populated = preview.labels.length > 0 || !!preview.text;
  const replyName = reply ? t('coordinatorCard.replyLabel', { time: messageTime(reply.answeredAt, i18n.language) }) : '';
  const draftName = populated || attached.length > 0 ? [replyName, serialize(own).replace(/\s+/g, ' ').trim()].filter(Boolean).join(' ') || t('coordinatorCard.attached') : '';
  // Its words and moves stand in the column the conversation is read in (reading-column.ts), as the input's do, so
  // folding and opening a wide coordinator leaves them where they are.
  // Its round action: 40px inside the 48px line, its press reaching the 44px a finger takes (the line's own padding).
  const round = "relative size-8 flex-none rounded-full p-0 active:scale-90 pointer-coarse:size-10 pointer-coarse:before:absolute pointer-coarse:before:-inset-0.5 pointer-coarse:before:content-['']";
  return <div data-coordinator-capsule className="flex min-h-12 touch-none narrow:touch-auto items-center rounded-full border-hairline border-lit-line bg-raised p-1 pl-1 shadow-float keys:has-[[data-coordinator-write]:focus-visible]:border-muted text-sm text-ink">
    <div data-reading-column className={cn(COLUMN.body, 'flex items-center gap-0.5')}>
    {/* What it says is its name (the draft, where to write); a press brings the input up. */}
    <button type="button" data-coordinator-write title={t('coordinatorCard.open')} disabled={!writing && !loading}
      aria-label={!waiting && draftName ? `${t('coordinatorCard.draft')} ${draftName}` : undefined}
      aria-busy={loading && trying} data-coordinator-loading={waiting || undefined} onClick={press}
      // Its words start where the open input's do (LabelEditor), so a press that opens it does not move them sideways.
      // Reached by the keyboard, the line itself says so (its edge darkens, its ground as pointed at), not a ring inside it.
      className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full pr-2 pl-3 text-left outline-none narrow:pl-4.5 pointer-coarse:pl-4.5 hover:bg-hover disabled:opacity-38 keys:focus-visible:bg-hover">
      {waiting ? <span className="min-w-0 flex-1 truncate text-muted motion-safe:animate-pulse">{said}</span>
        : populated ? <DraftPreview doc={draft.doc} preview={preview} />
        : draftName ? <span className="min-w-0 flex-1 truncate text-ink">{draftName}</span>
        : <span className="min-w-0 flex-1 truncate text-muted">{inputPlaceholder(draft.doc, t, (id) => marks.has(id), true)}</span>}
    </button>
    {/* What the line says while it waits is also put in a status region beside the button, for a screen reader (a button's name changing is not announced). */}
    <span role="status" className="sr-only">{said || ''}</span>
    {(content /* || voiceAvailable() */) && <span className="flex flex-none">
      {/* content ? */}<Button type="button" data-ask-send className={round} disabled={steady.disabled}
        aria-label={t('coordinatorCard.send')} onClick={steady.press(() => { if (send?.() === 'rejected') focusCoordinator(); })}><Icon name="plane" className="size-4" /></Button>
      {/* Initial release: : <Button type="button" data-coordinator-speak className={cn(round, inputSpeak)} disabled={unreachable}
        aria-label={t('coordinatorCard.speak')} title={t('coordinatorCard.speakHint')}
        onClick={() => { useConversation.setState({ listen: true }); useConversation.getState().setOpen(true); }}><Icon name="microphone" className="size-4" /></Button> */}
    </span>}
    </div>
  </div>;
});
