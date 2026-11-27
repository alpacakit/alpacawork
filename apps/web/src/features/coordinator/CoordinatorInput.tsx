import type { CoordinatorNextLaunch } from "@alpacawork/contract/coordinator";
import { mutateInput } from './editor/draft';
import { useSendGrace } from '@/data/send-grace';
import { useQueryClient } from '@tanstack/react-query';
import { useServerTasks, serverTasksFor, useReaderPeople, readerPeopleFor } from '@/data/queries';
import { coordinatorWriteBasis } from '@/data/coordinator';
import { canSendWrites } from '@/data/connection';
import { readerTurn, sameTurn } from '@/features/reader/submission';
import { swipesOnSend, useSitting, useReaderTurnUnadmitted, type ReaderAdmission, type ReaderCard } from '@/features/reader/next-question';
import { memo, useContext, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { useWorkspaceSelector, useWorkspaceStore } from '@/data/workspace-store';
import { notify } from '@/lib/notify';
import { countUse } from '@/features/telemetry/count';
import { acknowledgeReaderSend, captureReaderSubmission, cancelLocalReaderSend, readerSendReadiness, retryReaderIntent, useReaderSend, type SendScope, type SentIntent } from './reader-send';
import { userTurn } from '@alpacawork/contract';
import { crewOf } from '@/domain/people';
import { decideOf } from '@/domain/questions';
import { useTaskDetail, useWriteDisabled, useWorkspaceWritable } from '@/data/queries';
import { useDraftStore } from '@/features/forms/draft-store';
import { CoordinatorAi } from './CoordinatorAi';
import { CoordinatorContext } from './CoordinatorContext';
import { attachmentsOf } from '@/domain/attachments';
import { useComposerFiles } from '@/features/reader/Attachments';
import { useConversation } from './coordinator';
import { useShared, acknowledgeShared } from './shared';
import { focusCoordinator, useInputDraft } from './editor/draft';
import { writtenIn } from './editor/document';
import { inlines, answeredQuestions, replyIn, hasContent, taskReferencesIn, serialize, draftDocument, textDocument, type Document } from './editor/document';
import { LabelEditor, typeTrigger } from './editor/LabelEditor';
import { skillMark, useCoordinatorSkills } from './editor/skills';
import { deliverOutgoing, SEND_ERROR, sendError } from './deliver';
import { availableInput, pendingInput, inputDraftFiles, freeze, offerOutgoingUndo, flushLeavingOutbox, holdsReaderTurn, nextDelivery, outgoingKey, useOutbox, type Fixed } from './editor/outbox';
import { useShownConversation } from './shown';
import { /* VoiceInput, */ useVoiceInput } from '@/features/reader/VoiceInput';
import { cn } from '@/lib/utils';
import { COLUMN } from '@/features/reader/reading-column';
import { SurfaceDocument } from '@/lib/surface';
import { useNarrow } from '@/state/view-store';
import { FieldError } from '@/components/ui/field';
import { inputFinger, /* inputSpeak, */ inputTool } from './task-action-slot';
import { inputPlaceholder } from './editor/placeholder';
import { useProjectMarks } from '@/data/project-marks';
import { editableIntent } from './editor/editable-intent';
import { goesDownByItself } from './foot';
import { useSteadyControl } from '@/lib/steady-control';


/** The open frame is a pane (tokens.css): its rounding is its round action's radius plus the 8px the row keeps round it,
 * so the action's circle and the frame's corner share one centre, and the conversation and the detail beside it round as it does. */
const FRAME_ROUND = 'rounded-pane';
/** While the expand button stands in the frame's top corner (inside its rounding, its centre over the round action's),
 * the words and the attachment cards (whose remove marks stand out past their corner) end short of it rather than
 * running under it. */
const EXPAND_ROOM = cn('[&[data-input-long]_[data-one-input]]:pr-11 narrow:[&[data-input-long]_[data-one-input]]:pr-12 pointer-coarse:[&[data-input-long]_[data-one-input]]:pr-12',
  // The cards keep their width and scroll sideways, so their strip itself ends before the button: room inside it would only be scrolled to.
  '[&[data-input-long]_[data-attachments]]:mr-10 narrow:[&[data-input-long]_[data-attachments]]:mr-12 pointer-coarse:[&[data-input-long]_[data-attachments]]:mr-12');

/**
 * `launch.next`: the AI the next message goes to (the conversation's `nextLaunch`); null when none can run, and nothing
 * goes. `launch.ready`: the screen has read its workspace and conversation, so `next` is the server's word.
 */
export const CoordinatorInput = memo(function CoordinatorInput({ launch }: { launch: { next: CoordinatorNextLaunch | null; ready: boolean } }) {
  const { t } = useTranslation('ui');
  const conversation = useConversation(state => state.conversation);
  const open = useConversation(state => state.open);
  const draft = useInputDraft();
  const workspace = useWorkspaceStore();
  const client = useQueryClient();
  const serverTasks = useServerTasks();
  const operation = editableIntent(draft.entry.values, draft.doc);
  const retryMeaning = operation.kind === 'intent' ? operation.intent : null;
  const retryPeople = useReaderPeople(retryMeaning?.task ?? null);
  // Selected, not read once: the input is memoized and must be drawn again for another workspace.
  const root = useWorkspaceSelector(data => data.info.root);
  // What each request sent from here may retire in the reader, captured at its press; a recovered one has none.
  // Serve out of reach (or the workspace not taking writes): what goes to it waits, sending above all (canSend). Writing
  // does not wait for serve: what is written is the device's own (draft-store). Only a workspace that takes no writes at
  // all (read-only, or not read yet) has nothing to write toward.
  const unreachable = useWriteDisabled();
  const draftUnavailable = useWriteDisabled(() => coordinatorWriteBasis(answeredQuestions(draft.doc)));
  const writing = useWorkspaceWritable() && !!conversation;
  // An earlier request not yet settled holds the next one (outbox.ts); writing goes on meanwhile.
  useSendGrace(state => state.revision);
  const next = useDraftStore(state => conversation ? nextDelivery(state.entries, root, conversation.id)?.requestId ?? null : null);
  const activeCard = useSitting(state => state.card);
  const cardTask = serverTasks?.find(each => each.id === activeCard?.taskId);
  const heldReader = useReaderTurnUnadmitted(cardTask?.id) && !!conversation;
  const shownConversation = useShownConversation();
  const [long, setLong] = useState(false), [tall, setTall] = useState(false);
  const editor = useRef<Editor | null>(null);
  const voice = useVoiceInput(editor, !open || unreachable || !conversation, draft.lockVoice);
  const recording = voice.active;
  // The one line's microphone brings this input up and records into it at once,
  // as its own microphone does: the words go after what is there (the task's label it starts with), as typing would.
  const listen = useConversation(state => state.listen);
  // The conversation is shown: opened, or in its own window (which shows nothing else). Shown, the input stays up.
  const expanded = useConversation(state => state.expanded);
  const providedDocument = useContext(SurfaceDocument);
  const surface = providedDocument ?? document;
  const own = providedDocument !== null, shown = own || expanded;
  useEffect(() => {
    if (!listen || !voice.enabled) return;
    let timer = 0, tries = 0;
    const go = () => {
      if (editor.current && conversation && !unreachable) {
        useConversation.setState({ listen: false });
        editor.current.commands.setTextSelection(editor.current.state.doc.content.size - 1); voice.toggle();
      } else if (tries++ < 60) timer = window.setTimeout(go, 50);
      else useConversation.setState({ listen: false });
    };
    go();
    return () => clearTimeout(timer);
  }, [listen, voice.enabled, conversation, unreachable]);

  const files = useComposerFiles(draft.key, { kind: 'coordinator', conversationId: conversation?.id ?? '' }, !writing, inputDraftFiles(root, draft.entry.values.requestId!));
  // The agent the next message goes to: its skills are the ones the input offers and checks.
  const profile = launch.next?.agent ?? '';
  const catalog = useCoordinatorSkills(profile);
  const shared = useShared(state => state.shared);
  useEffect(() => {
    if (!shared || draft.locked || files.attachments.disabled || useShared.getState().shared !== shared) return;
    const current = useDraftStore.getState().entries[draft.key];
    if (!current) return;
    const receipt = current.values.shareReceipt ? JSON.parse(current.values.shareReceipt) as { id: string; ops: string[] } : null;
    if (receipt?.id !== shared.id) {
      // Shared words are the person's; shared files alone leave the recipients to the screen (lifecycle.ts).
      if (!mutateInput(draft.key, visible => {
        const before = draftDocument(visible);
        const words: Record<string, string> = shared.text ? { phase: 'composing', doc: JSON.stringify({ ...before, content: [...before.content, ...textDocument(shared.text).content] }) } : {};
        return { ...visible, ...words, shareReceipt: JSON.stringify({ id: shared.id, ops: shared.files.map(() => crypto.randomUUID()) }) };
      })) return;
      return; // The next store notification starts uploads only after the text and IDs have persisted.
    }
    const completed = new Set<string>(JSON.parse(current.values.completedUploads ?? '[]'));
    const remaining = receipt.ops.flatMap((id, at) => completed.has(id) ? [] : [{ id, file: shared.files[at]! }]);
    if (!remaining.length) { void acknowledgeShared(shared).catch(() => sendError(t('input.storageUnavailable'))); return; }
    files.attachments.add(remaining.map(item => item.file), remaining.map(item => item.id));
  }, [shared, files.attachments.disabled, draft.locked, draft.entry.values]);
  /**
   * Whether a send may go now: the one gate every way of sending meets. A press's intent (canPost) needs serve in reach,
   * no unadmitted copy of this same reader turn, a conversation and an AI that can take it (`launch.next`); the draft (the button, Enter, a report's swipe) needs that and
   * itself ready (canSend).
   */
  const closing = shownConversation.closing;
  const canPost = !unreachable && !!conversation && !closing && !!launch.next;
  const canSend = canPost && !draftUnavailable && !shared && !recording && !draft.unavailable && !files.attachments.waiting
    && !pendingInput(useDraftStore.getState().entries, root, draft.key)
    && !(heldReader && readerSendReadiness(draft.doc, serverTasksFor(client) ?? [], null).ready);
  /**
   * A fixed request's check from the reader: resent as it was while unsettled; settled meanwhile (a snapshot holds it),
   * serve has it.
   */
  const recheck = (requestId: string, scope: SendScope) => () => {
    const entry = useDraftStore.getState().entries[outgoingKey(root, requestId)];
    if (entry && entry.values.stage !== 'accepted') void latestDeliver.current(requestId);
    else acknowledgeReaderSend(requestId, scope);
  };
  /**
   * The press, whatever is sent: `doc` (with its files, and what it means: a press's
   * `intent`, or the questions a draft's choices answer, `answers`) becomes a fixed request under the request ID in
   * `values` (outbox.ts), and `accept` is what it answers in the reader once it goes. Its recipients (`tasks`) are what
   * `doc` names (labels, answers, Task IDs in its words) and a press's Task, fixed here. The input's draft goes on in
   * the same write (`input`); an intent leaves the draft as it is. Null when it could not be kept.
   */
  const fix = (conversationId: string, doc: Document, attachments: string[],
    meaning: Pick<Fixed, 'intent' | 'answers'>,
    values: Record<string, string>, input?: { from: string }, card: ReaderCard | null = useSitting.getState().card) => {
    const tasks = [...new Set([...taskReferencesIn(doc, workspace.getState().tasks), ...(meaning.intent ? [meaning.intent.task] : [])])].sort();
    const fixed: Fixed = { conversationId, text: serialize(doc, skillMark(catalog)), ...(tasks.length ? { tasks } : {}),
      skills: [...new Set(inlines(doc).flatMap(node => node.type === 'skillLabel' ? [node.attrs.name] : []))].sort(),
      attachments, ...(replyIn(doc) ? { replyTo: replyIn(doc)!.id } : {}), ...meaning };
    const requestId = values.requestId!, scope = { root, conversationId };
    const accept = captureReaderSubmission(fixed, doc, serverTasksFor(client) ?? [], requestId, scope, recheck(requestId, scope), card);
    if (accept.reader.some(reader => holdsReaderTurn(useDraftStore.getState().entries, root, reader))) return null;
    const frozen = freeze(root, fixed, values, input, accept.reader);
    if (!frozen) { sendError(t('input.storageUnavailable')); return null; }
    const admitted = accept() ? 'retired' as const : 'retained' as const;
    offerOutgoingUndo(root, frozen, surface);
    return admitted;
  };
  /**
   * What is written becomes a fixed request while the draft remains until admission, in one storage write; then it goes
   * (deliverOutgoing). Every way of sending it (the button, its keys, a report's swipe) comes here. `way` is how: from the
   * input itself, which stays on its card with the input open unless auto-swipe is on (swipesOnSend); a swipe that
   * finishes the card; or a press's intent sent again (its explicit retry). Those two always leave.
   */
  const send = (way: 'input' | 'finish' | 'retry' = 'input', by: 'button' | 'key' = 'button'): ReaderAdmission => {
    const explicitRetry = way === 'retry';
    const entries = useDraftStore.getState().entries, stored = entries[draft.key];
    const available = availableInput(entries, root, draft.key);
    const current = stored && available ? { ...stored, values: available } : stored;
    const doc = current ? draftDocument(current.values) : draft.doc;
    const attached = current ? attachmentsOf(current.values) : [];
    if (!current?.values.requestId || pendingInput(entries, root, draft.key) || !canSend || !conversation || !hasContent(doc, attached)) return "rejected";
    const operation = editableIntent(current.values, doc);
    if (operation.kind === 'invalid') { sendError(t('forms:reportForm.chooseAgain')); return 'rejected'; }
    const source = operation.kind === 'intent' ? (serverTasksFor(client) ?? []).find(task => task.id === operation.intent.task) : null;
    const sourcePeople = source ? readerPeopleFor(client, root, source.id, retryPeople) : retryPeople;
    // Only the existing explicit retry entrance may refresh guards. Ordinary send retains the captured operation.
    if (operation.kind === 'intent' && (!source || !canSendWrites(coordinatorWriteBasis({ intent: operation.intent })) || !explicitRetry && (source.hash !== operation.intent.expectedTaskHash
      || !sameTurn(readerTurn(source), operation.turn)
      || operation.intent.expectedPlacementRevision !== crewOf(source.id, sourcePeople).responsible?.revision))) {
      sendError(t('forms:reportForm.chooseAgain')); return 'rejected';
    }
    const retryIntent = operation.kind === 'intent' && source
      ? explicitRetry ? retryReaderIntent(operation.intent, source, sourcePeople) : operation.intent : null;
    // Staying, the card answered is kept out of the submission's departure: it is neither stamped nor left.
    const card = useSitting.getState().card, stays = way === 'input' && !swipesOnSend();
    // Its choices retain their original question and shown versions for the coordinator to interpret.
    const local = fix(conversation.id, doc, attached.map(file => file.name), { ...answeredQuestions(doc), ...retryIntent ? { intent: retryIntent } : {} }, current.values, {
      from: draft.key }, stays ? null : card);
    if (!local) return 'rejected';
    // How it was sent (a swipe counts itself, as the gesture); and the sends kept on the card, auto-swipe being off.
    if (way === 'input') { countUse(by === 'key' ? 'send.key' : 'send.button'); if (stays) countUse('send.pinned'); }
    notify.dismiss(SEND_ERROR); setLong(false); setTall(false);
    // Sent is handed over: where it goes down by itself, the input goes down to its one line (shown, or staying, it stays).
    if (!shownNow.current && !stays && goesDownByItself()) useConversation.getState().setOpen(false);
    // Staying, the open input keeps the focus for the next words, whichever of its ways sent (its button takes it).
    else if (stays && useConversation.getState().open) focusCoordinator();
    return local;
  };
  /**
   * An intent pressed in the reader (reader-send's sendIntent): its one line (`text`) and the intent go as a message of
   * their own, fixed and sent as the draft is, while what is written in the input stays there.
   */
  const post = (intent: SentIntent, card: ReaderCard | null, text: string): ReaderAdmission => {
    if (!canSendWrites(coordinatorWriteBasis({ intent })) || !canPost || !conversation) return "rejected";
    const current = useDraftStore.getState().entries[draft.key];
    const operation = current ? editableIntent(current.values, draftDocument(current.values)) : null;
    if (operation?.kind === 'intent' && operation.intent.task === intent.task && operation.intent.action === intent.action) return send('retry');
    const requestId = crypto.randomUUID(), doc = textDocument(text);
    return fix(conversation.id, doc, [], { intent }, { doc: JSON.stringify(doc), requestId }, undefined, card) ?? 'rejected';
  };
  const place = { root, client, surface, draw: shownConversation.send };
  const deliver = (requestId: string, keepalive?: boolean, leaving?: boolean) => deliverOutgoing(place, requestId, keepalive, leaving);
  const latestDeliver = useRef(deliver);
  latestDeliver.current = deliver;
  useEffect(() => { if (!unreachable && !closing && next) void latestDeliver.current(next); }, [next, unreachable, closing]);
  useEffect(() => {
    const resend = (requestId: string, keepalive?: boolean, leaving?: boolean) => latestDeliver.current(requestId, keepalive, leaving);
    const cancelled = (requestId: string) => cancelLocalReaderSend(requestId, { root, conversationId: useConversation.getState().conversation?.id ?? '' });
    useOutbox.setState({ resend, cancelled });
    const leaving = () => flushLeavingOutbox(root);
    surface.defaultView?.addEventListener('pagehide', leaving);
    return () => { surface.defaultView?.removeEventListener('pagehide', leaving); if (useOutbox.getState().resend === resend) useOutbox.setState({ resend: null, cancelled: undefined }); };
  }, []);
  // The button's short waits (serve reached again, the last message's admission) do not dim it; a press in one sends once
  // the wait ends, what was written then and no more: written on since, it is not sent (useSteadyControl). Having
  // nothing to send shows at once.
  const steady = useSteadyControl(!canSend, writtenIn(draft.entry.values));
  const shownNow = useRef(shown);
  shownNow.current = shown;
  const latestSend = useRef(send);
  latestSend.current = send;
  // The folded input uses this same sender and readiness gate, independently of the reader's current card.
  useEffect(() => {
    const action = canSend ? () => latestSend.current() : null;
    useReaderSend.setState({ sendDraft: action });
    return () => { if (useReaderSend.getState().sendDraft === action) useReaderSend.setState({ sendDraft: null }); };
  }, [canSend]);
  // An intent goes whatever is written or recorded in the input (canPost).
  const latestPost = useRef(post);
  latestPost.current = post;
  useEffect(() => {
    const action = canPost ? (intent: SentIntent, card: ReaderCard | null, text: string) => latestPost.current(intent, card, text) : null;
    useReaderSend.setState({ post: action });
    return () => { if (useReaderSend.getState().post === action) useReaderSend.setState({ post: null }); };
  }, [canPost]);
  const revision = useReaderSend(state => state.revision);
  // The card's open question as read, fixed when asked.
  const { detail: cardDetail, assessment: cardAssessment } = useTaskDetail(cardTask);
  const cardPeople = useReaderPeople(cardTask?.id ?? null);
  const cardQuestion = cardTask && userTurn(cardTask.ball)?.questionId;
  const cardAsked = cardQuestion && cardAssessment.project ? cardDetail?.questions.find(each => each.id === cardQuestion && each.destination.kind === 'user')?.decide : undefined;
  const readiness = canSend && activeCard ? readerSendReadiness(draft.doc, serverTasksFor(client) ?? [], cardAsked === undefined ? null : decideOf(cardAsked)) : null;
  const answerTasks = readiness?.ready ? activeCard!.taskId : '';
  const missing = readiness?.missing ?? null;
  const missingKey = missing ? JSON.stringify(missing) : '';
  useEffect(() => {
    const action = answerTasks ? { tasks: answerTasks.split(' '), run: () => latestSend.current('finish') } : null;
    useReaderSend.setState({ action, missing: missingKey ? JSON.parse(missingKey) : null });
    return () => { if (useReaderSend.getState().action === action) useReaderSend.setState({ action: null, missing: null }); };
  }, [canSend, answerTasks, missingKey, revision]);
  const content = hasContent(draft.doc, files.attachments.attached);
  const narrow = useNarrow();
  const marks = useProjectMarks();
  const placeholder = inputPlaceholder(draft.doc, t, (id) => marks.has(id));
  // One height for the whole row (inputTool): its marks, the model and the round action stand on one centre line, 4px
  // apart under a pointer; a finger's 44px faces already keep their room. Too narrow for them all (large text on a
  // phone), what is at the end goes onto a line of its own, on the right, rather than the model narrowing to nothing.
  const action = cn('size-8 flex-none rounded-full p-0 active:scale-90', inputFinger);
  // The row keeps 8px inside the frame, under a pointer as under a finger, so the round action stands as far from the
  // frame's bottom as from its side; the frame's rounding is that action's own plus those 8px (FRAME_ROUND), one curve
  // round the other, as the folded capsule's is. The words above start where the row's first mark does (LabelEditor).
  // Its words (the # and / tools' signs, the usage's figure, the AI's name, a recording's state) are each boxed to their
  // capitals (cap-box), so centring them puts their letters on the marks' centre line, whatever the font's room above
  // and below.
  const row = 'flex min-h-10 flex-none flex-wrap items-center gap-1 px-2 pb-2 narrow:min-h-13 narrow:gap-0 narrow:px-2 narrow:pb-2 pointer-coarse:min-h-13 pointer-coarse:gap-0 pointer-coarse:px-2 pointer-coarse:pb-2';
  // The input's AI is one of the row's quiet tools, not a field: no box of its own, its ground only when pointed at.
  const ai = 'h-8 rounded-full border-transparent bg-transparent px-2 text-muted hover:text-ink narrow:h-11 narrow:pl-1 pointer-coarse:h-11 pointer-coarse:pl-1';
  // The usage is one of them too, a finger's width at least where a finger presses it.
  // Ring and figure at the row's size, as close as a mark and its words; pressed or open, drawn as the row's tools are.
  const context = 'h-8 gap-1.5 rounded-full px-2 text-sm text-muted hover:bg-hover hover:text-ink active:bg-line data-[state=open]:bg-hover data-[state=open]:text-ink narrow:h-11 narrow:min-w-11 narrow:gap-1 narrow:pr-1 pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:gap-1 pointer-coarse:pr-1';
  const tool = inputTool;
  return <div data-one-input-area data-input-tall={tall || undefined} className="flex min-h-0 shrink flex-col border-t border-rule bg-raised p-2">
    {/* What stands over the words is what lasts about them (a draft that cannot be kept, notify.ts); a send that did not
        go is said by its toast (sendError), as a failed read is (coordinator.ts). */}
    {draft.unavailable && <FieldError className="mt-0 mb-1 text-xs">{t('input.storageUnavailable')}</FieldError>}
    <form className="flex min-h-0 flex-col" onSubmit={e => { e.preventDefault(); void send(); }}>
      {/* The frame is as wide as the coordinator; what is written and its moves stand in the column the conversation is read
          in (reading-column.ts), so a line written and a line read are one measure. Its own ground round the column moves the
          coordinator (data-frame-ground-self: the frame itself, not what is in it). */}
      <div data-composer-frame data-frame-ground-self={!own && !narrow || undefined} data-input-long={long || undefined} className={cn('relative flex min-h-0 flex-col border-hairline border-lit-line bg-raised', FRAME_ROUND, EXPAND_ROOM, files.frame.dropping && 'ring-2 ring-ink')}
        onPaste={files.onPaste}>
        <div data-reading-column className={cn(COLUMN.body, 'flex min-h-0 flex-1 flex-col [&>[data-attachments]]:flex-none')}>
        {files.frame.files}
        {long && <button type="button" aria-label={t(tall ? 'input.shrink' : 'input.expand')} onMouseDown={e => e.preventDefault()} onClick={() => setTall(v => !v)} className="absolute top-3 right-3 z-1 grid size-6 narrow:top-4 narrow:right-4.5 pointer-coarse:top-4 pointer-coarse:right-4.5 place-items-center rounded-sm bg-raised text-muted hover:bg-hover"><Icon name={tall ? 'up' : 'expand'} className="size-3.5" /></button>}
        <LabelEditor draft={draft} catalog={catalog} disabled={recording || !writing} attaching={!files.attachments.disabled} placeholder={placeholder} onSend={() => void send('input', 'key')} tall={tall} onLong={setLong} editorRef={editor} partial={voice.partial ? { at: voice.at, text: voice.partial } : undefined} />
        {recording ? <div data-voice-recording data-voice-state={voice.state} className={row}>
          <button type="submit" data-ask-send disabled aria-label={t('coordinatorCard.send')} className="sr-only" />
          <button type="button" className={tool} aria-label={t('input.cancelVoice')} onClick={voice.cancel}><Icon name="close" className="size-4" /></button>
          {voice.state === 'recording' && <i className="mr-1 size-2 flex-none rounded-full bg-error" />}
          <span role="status" className="cap-box whitespace-nowrap text-sm">{t(voice.state === 'connecting' ? 'reader:voiceInput.connecting' : voice.state === 'recording' ? 'input.recording' : 'input.transcribing')}</span>
          {voice.state === 'recording' && <span data-voice-elapsed className="ml-1 cap-box text-xs text-muted tabular-nums">{Math.floor(voice.seconds / 60)}:{String(voice.seconds % 60).padStart(2, '0')}</span>}
          <span className="min-w-0 flex-1">{voice.state === 'recording' && <span data-voice-waveform className="mx-1 flex h-5 items-center gap-0.5 overflow-hidden" aria-hidden="true">{[4, 9, 16, 8, 12, 20, 10, 6].map((height, at) => <i key={at} style={{ height }} className="w-0.5 flex-none bg-muted motion-safe:animate-pulse" />)}</span>}</span>
          <Button type="button" className={action} aria-label={t('reader:voiceInput.stop')} onClick={voice.stop} disabled={voice.state === 'finalizing'}><Icon name="check" className="size-4" /></Button>
        </div> : <div className={row} data-frame-ground={!own && !narrow || undefined}>
          {files.frame.attach}
          <button type="button" className={tool} disabled={!writing} aria-label={t('input.tasks')} onClick={() => typeTrigger(editor.current, '#')}><span className="cap-box">#</span></button>
          <button type="button" className={tool} disabled={!writing} aria-label={t('input.skills')} onClick={() => typeTrigger(editor.current, '/')}><span className="cap-box">/</span></button>
          {/* Initial release: {voice.enabled && content && <VoiceInput voice={voice} disabled={unreachable} className={inputFinger} />} */}
          {/* The row's ground: on a computer it moves the coordinator (frame-hand.tsx). */}
          <span className={cn("min-w-0 flex-1 self-stretch narrow:flex-none pointer-coarse:flex-none", !own && !narrow && "cursor-grab touch-none [[data-coordinator-held]_&]:cursor-grabbing")} />
          {/* The AI takes the room it needs before the ground does (grow-9), and keeps at least a finger's width (basis-11):
              narrower than that, it goes to the next line instead. */}
          {/* How full the coordinator's conversation is, and its reset, left of its AI: both are about the coordinator. */}
          {launch.ready && <span className="ml-auto flex min-w-0 max-w-max grow-9 basis-11 items-center"><CoordinatorContext className={context} /><CoordinatorAi next={launch.next} className={ai} /></span>}
          <span className="ml-auto flex flex-none">
          {/* Initial release: voice.enabled && !content ? <VoiceInput voice={voice} disabled={unreachable} round className={cn(inputSpeak, inputFinger)} /> : */}<Button type="submit" data-ask-send className={action}
            aria-label={t('coordinatorCard.send')} title={closing ? t('coordinatorCard.clearingHint') : undefined} disabled={steady.disabled || !content} onClick={steady.press()}><Icon name="plane" className="size-4" /></Button>
          </span>
        </div>}
        </div>
      </div>
    </form>
  </div>;
});
