import { useTranslation } from 'react-i18next';
import type { CoordinatorTurn } from '@/data/coordinator';
import { Icon } from '@/components/ui/icon';
import { MarkdownBody } from '@/features/reader/MarkdownBody';
import { followTask } from './follow-task';
import { useConversation } from './coordinator';
import { LabelPopover, LabelRemove } from './LabelPopover';
import { messageTime } from './message-time';
import { goToReply, type ReplyOrigin } from './reply-navigation';
import { answerBodyFiles } from './MessageFiles';

const useReplyDisplay = (answeredAt: string) => {
  const { t, i18n } = useTranslation('ui');
  const time = answeredAt && messageTime(answeredAt, i18n.language);
  return { time, name: answeredAt ? t('coordinatorCard.replyLabel', { time }) : t('coordinatorCard.replyUnavailable') };
};
function ReplyLabelFace({ name }: { name: string }) {
  return <><Icon name="reply" className="size-3 flex-none" /><span className="min-w-0 truncate text-ink">{name}</span></>;
}
export function ReplyLabelText({ answeredAt }: { answeredAt: string }) {
  return <ReplyLabelFace name={useReplyDisplay(answeredAt).name} />;
}
/** Its reference comes from the document before sending, and from the Request afterward; excerpts are read projections. */
export function ReplyLabel({ reply, origin, remove }: {
  reply: NonNullable<CoordinatorTurn['replyTo']>; origin?: ReplyOrigin; remove?: () => void;
}) {
  const { t } = useTranslation('ui');
  const source = useConversation(state => state.conversation?.turns.find(turn => turn.id === reply.id));
  const text = source?.answer ?? reply.head;
  const { name, time } = useReplyDisplay(reply.answeredAt);
  return <span data-label="reply" className="inline">
    <LabelPopover kind="reply" name={t('coordinatorCard.replySource')} face={<ReplyLabelFace name={name} />}
      tail={remove && <LabelRemove name={t('coordinatorCard.removeContext', { id: name })} remove={remove} />}
      header={<><Icon name="reply" className="size-3.5" />{time} {t('coordinatorCard.replySource')}</>}
      actions={close => <><button type="button" className="rounded-sm border border-line px-2 py-1" disabled={!source}
        onClick={() => { close(); goToReply(reply.id, origin ?? { at: new Date().toISOString() }); }}>{t('coordinatorCard.goToReply')}</button>
        {remove && <button type="button" className="px-2 py-1 text-muted" onClick={() => { close(); remove(); }}>{t('input.remove')}</button>}</>}>
      <div data-reply-preview className="mt-1 max-h-[9.6em] overflow-hidden [mask-image:linear-gradient(black_70%,transparent)]">
        {text ? <MarkdownBody text={text} task={null} variant="note" onFollow={followTask} files={source && answerBodyFiles(source)} /> : <span className="text-muted">{t('coordinatorCard.replyUnavailable')}</span>}
      </div>
    </LabelPopover>
  </span>;
}
