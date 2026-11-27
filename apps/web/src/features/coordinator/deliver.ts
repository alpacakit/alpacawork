import type { QueryClient } from '@tanstack/react-query';
import { i18n } from '@alpacawork/i18n';
import { captureReadBoundary, sameReadSession } from '@/data/read-model';
import { coordinatorWriteBasis } from '@/data/coordinator';
import { canSendWrites, workspaceWriteBasis } from '@/data/connection';
import { ApiError } from '@/data/client';
import { notify, recordFailure } from '@/lib/notify';
import { draftKey, useDraftStore } from '@/features/forms/draft-store';
import type { ReaderAdmission } from '@/features/reader/next-question';
import { deliveryNotice, deliveryNoticeId } from './delivery-notice';
import { acknowledgeReaderSend, failReaderSend } from './reader-send';
import { useConversation, readConversationSnapshot, withStatus, withLearnt } from './coordinator';
import { replyIn, inlines, automationIn } from './editor/document';
import { begin, outgoingBlock, outgoingBlockText, deliveryOutcome, isWithdrawn, simpleOutgoing, outgoingKey, refuse as refuseOutgoing } from './editor/outbox';
import { copyRecoveredFiles } from './editor/recovered-files';
import { skillStanding, skillsUnverified } from './editor/skills';
import { readSkillCatalog, resources } from '@/data/resources';
import type { LocalTurn } from './shown';

/** The toast slot of a send from the input that did not go (sendError). */
export const SEND_ERROR = 'coordinator-send-error';
/**
 * Why what is in the input did not go is said as the screen's other failures are (notify.ts), in one slot: the next
 * one takes its place, and a send that goes takes it away.
 */
export const sendError = (text: string) => notify.error(text, { id: SEND_ERROR, from: 'coordinator' });

/** Where a delivery runs: the input's window and workspace, and how the thread draws a request being sent. */
export type DeliveryPlace = { root: string; client: QueryClient; surface: Document;
  draw: <T>(turn: LocalTurn, work: () => Promise<T>) => Promise<T> };

/**
 * One attempt at a fixed request (a new one, or one whose outcome is unknown, resent as it was): drawn as sending from
 * now until its answer; settled by the snapshot that holds it (coordinator.ts → reconcileOutbox). Not reaching serve,
 * or refused by it, it goes back to the input (or stays refused in the thread); with no answer, it stays unknown.
 */
export function deliverOutgoing({ root, client, surface, draw }: DeliveryPlace, requestId: string, keepalive = false, leaving = false): Promise<ReaderAdmission> {
  const saved = useDraftStore.getState().entries[outgoingKey(root, requestId)];
  if (leaving && (!saved || !simpleOutgoing(saved))) return Promise.resolve('retained');
  const source = { ...workspaceWriteBasis(), root }, boundary = captureReadBoundary(client);
  const sameSession = () => sameReadSession(client, boundary);
  const attempt = begin(root, requestId);
  if (!attempt) {
    const blocked = saved && outgoingBlock(root, requestId);
    if (blocked) deliveryNotice(root, requestId, outgoingBlockText(blocked), { kind: 'delivery' });
    return Promise.resolve("rejected");
  }
  const { fixed } = attempt, scope = { root, conversationId: fixed.conversationId };
  const turn: LocalTurn = { id: requestId, at: new Date().toISOString(), ask: fixed.text, ...(fixed.tasks ? { tasks: fixed.tasks } : {}), ...(fixed.automation ? { automation: fixed.automation, ...automationIn(attempt.doc)?.name ? { automationName: automationIn(attempt.doc)!.name } : {} } : {}), attachments: fixed.attachments, files: attempt.files,
    ...(fixed.replyTo ? { replyTo: { id: fixed.replyTo, answeredAt: replyIn(attempt.doc)?.answeredAt ?? '', head: '' } } : {}),
    root, conversationId: fixed.conversationId, stage: 'sending', refusal: null };
  return draw(turn, async (): Promise<ReaderAdmission> => {
    let posted = attempt.checked, readAfterPost = false;
    const refuse = (reason: string, error: unknown = new ApiError(() => reason, 'conflict', 'fix'), conflict = false) => {
      const handled = failReaderSend(requestId, scope, error, reason);
      const currentId = useConversation.getState().conversation?.id;
      const destination = currentId ? draftKey(root, 'coordinator', currentId) : null;
      const removedFiles = currentId && currentId !== fixed.conversationId ? fixed.attachments : [];
      const names = removedFiles.join(i18n.t('ui:coordinatorCard.readerTargetSeparator'));
      const fileWarning = !removedFiles.length ? '' : removedFiles.length <= 2 && names.length <= 60
        ? i18n.t('ui:coordinatorCard.reattachNamedFiles', { names })
        : i18n.t('ui:coordinatorCard.reattachFiles', { count: removedFiles.length });
      const where = refuseOutgoing(root, requestId, reason, conflict, destination);
      if (handled && fileWarning) notify.error(fileWarning, { id: deliveryNoticeId(root, requestId), from: 'coordinator' });
      // Back in this input, the input is opened to the words and the toast says why; kept in the thread instead, or in
      // another conversation, the toast also says where it is.
      const inInput = where === 'restored' && currentId === scope.conversationId;
      if (inInput && !handled) { sendError(i18n.t('ui:coordinatorCard.refused', { reason })); useConversation.getState().setOpen(true); }
      else if (!handled) notify.error([i18n.t(where === 'restored' ? 'ui:coordinatorCard.refusedRestored' : 'ui:coordinatorCard.refusedKept', { reason }), fileWarning].filter(Boolean).join(' '), { id: deliveryNoticeId(root, requestId), from: 'coordinator' });
      return "rejected" as const;
    };
    try {
      // A fixed request may already be admitted: reconcile that fact before asking for new Task authority.
      if (attempt.checked) {
        readAfterPost = true;
        const read = (await readConversationSnapshot()).conversation;
        // Not among the open turns, it may have been withdrawn elsewhere: its own status says so.
        const received = read.turns.some(turn => turn.id === requestId) ? withLearnt(read) : await withStatus(read, requestId);
        if (deliveryOutcome(received, requestId, fixed) === 'cancelled') return 'retained';
        if (deliveryOutcome(received, requestId, fixed) === 'accepted')
          return sameSession() && acknowledgeReaderSend(requestId, scope) ? 'retired' : 'retained';
      }
      if (!sameSession()) return 'rejected';
      if (attempt.checked && useDraftStore.getState().entries[attempt.key]?.values.conflict)
        return refuse(i18n.t('ui:coordinatorCard.conflict'), new ApiError('Message ID belongs to different input', 'idempotency_conflict', 'fix'), true);
      if (!attempt.checked) {
        const skills = inlines(attempt.doc).flatMap(node => node.type === 'skillLabel' ? [node.attrs.name] : []);
        if (skills.length) {
          const live = await readSkillCatalog(fixed.conversationId);
          if (!sameSession()) return 'rejected';
          // What this read found is what the list and the chips then say, for the AI it was read for.
          client.setQueryData(resources.skills(root, live.profile, fixed.conversationId).queryKey, live);
          const standings = skills.map(name => skillStanding(live, name));
          if (standings.includes('gone')) return refuse(i18n.t('ui:input.skillsChanged'));
          if (standings.includes('unknown')) return refuse(skillsUnverified(i18n.t, live));
        }
        if (useConversation.getState().conversation?.id !== fixed.conversationId) return refuse(i18n.t('ui:coordinatorCard.conversationChanged'));
        const original = useDraftStore.getState().entries[outgoingKey(root, requestId)];
        const names = original && !leaving ? await copyRecoveredFiles(original.values, fixed.conversationId, requestId) : undefined;
        if (!sameSession()) return 'rejected';
        const checkpoint = attempt.check(names);
        if (checkpoint === 'retained') return 'retained';
        if (checkpoint === 'unavailable') return refuse(i18n.t('ui:input.storageUnavailable'));
        posted = true;
      }
      // Local submission already moved the reader; delivery now only updates its result facts.
      if (!sameSession()) return 'rejected';
      // Missing current authority cannot prove an earlier POST failed. Keep its fixed unknown request intact.
      if (attempt.checked && !canSendWrites(coordinatorWriteBasis(fixed))) return 'retained';
      const applied = await useConversation.getState().ask({ ...fixed, id: requestId }, { ...coordinatorWriteBasis(fixed), root: source.root, generation: source.generation }, keepalive || surface.hidden);
      return applied && sameSession() && acknowledgeReaderSend(requestId, scope) ? 'retired' : 'retained';
    } catch (error) {
      recordFailure(error, "coordinator send");
      if (!sameSession()) return 'rejected';
      const settled = () => {
        const received = useConversation.getState().conversation;
        const outcome = deliveryOutcome(received, requestId, fixed);
        const entry = useDraftStore.getState().entries[attempt.key];
        if (outcome === 'cancelled' || entry && isWithdrawn(entry.values)) return 'cancelled';
        if (outcome === 'accepted' || entry?.values.stage === 'accepted') return 'accepted';
        return outcome;
      };
      let outcome = settled();
      // An unanswered POST is checked once via the existing read Owner before being called unknown.
      const certainRefusal = !attempt.checked && (!posted || error instanceof ApiError && error.retry !== 'check');
      if (outcome === 'unknown' && posted && !certainRefusal && !readAfterPost) {
        readAfterPost = true;
        try {
          const read = (await readConversationSnapshot()).conversation;
          // Not among the open turns: its own status says whether serve took it and it was withdrawn since.
          if (sameSession() && !read.turns.some(turn => turn.id === requestId)) await withStatus(read, requestId);
        } catch (readError) { recordFailure(readError, 'coordinator send check'); }
        if (!sameSession()) return 'rejected';
        outcome = settled();
      }
      if (outcome === 'cancelled' || useDraftStore.getState().entries[attempt.key]?.values.last === 'withdraw') return 'retained';
      if (outcome === 'accepted') return acknowledgeReaderSend(requestId, scope) ? 'retired' : 'retained';
      // Serve, the one judge of a skill's mark, refused words that call a skill otherwise than the AI they go to does (its
      // settings changed meanwhile), a resend of the same ID included: the words go back, and sent again they are fixed
      // with that AI's marks.
      if (error instanceof ApiError && error.reason?.kind === 'skill_invocation_mismatch')
        return refuse(i18n.t('ui:coordinatorCard.coordinatorAiChanged'), error);
      if (outcome === 'conflict' || certainRefusal && error instanceof ApiError && error.code === 'idempotency_conflict')
        return refuse(i18n.t('ui:coordinatorCard.conflict'), error, true);
      if (certainRefusal) {
        if (error instanceof ApiError && (['question_closed', 'question_expired'].includes(error.code)
          || error.reason?.kind === 'question_does_not_exist')) return refuse(i18n.t('ui:input.questionsChanged'), error);
        const failure = posted || error instanceof ApiError && error.retry !== 'check' ? error
          : Object.assign(new ApiError('Request was not posted', 'unavailable', 'later'), { cause: error });
        return refuse(error instanceof ApiError && error.reason ? error.displayMessage : i18n.t(posted ? 'ui:coordinatorCard.serverRefused' : 'ui:coordinatorCard.notReached'), failure);
      }
      // A later refusal cannot settle the earlier unanswered POST. Keep the reader held too.
      const unknown = error instanceof ApiError && error.retry !== 'check'
        ? Object.assign(new ApiError(() => error.displayMessage, error.code, 'check', error.detail, error.issues, error.reason), { cause: error }) : error;
      const handled = failReaderSend(requestId, scope, unknown);
      if (!handled) deliveryNotice(root, requestId, i18n.t('ui:coordinatorCard.unconfirmedToast'), { kind: 'delivery' });
      return "rejected";
    } finally { attempt.finish(); }
  });
}
