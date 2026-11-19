import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import { conversationTool } from './task-action-slot';
import { returnFromReply, useReplyNavigation } from './reply-navigation';
import { messageTime } from './message-time';
export function ReplyReturn() {
  const { t, i18n } = useTranslation('ui');
  const back = useReplyNavigation(state => state.back);
  if (!back) return null;
  return <button type="button" data-reply-return className={conversationTool}
    onClick={returnFromReply}>
    <Icon name="down" className="size-4" />{t('coordinatorCard.returnFromReply', { time: messageTime(back.at, i18n.language) })}
  </button>;
}
