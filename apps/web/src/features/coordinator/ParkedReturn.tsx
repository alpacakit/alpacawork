import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useDraftStore } from '@/features/forms/draft-store';
import { shownInReader, useViewStore } from '@/state/view-store';
import { useConversation } from './coordinator';
import { focusCoordinator } from './editor/draft';
import { parkedReaderDraft, restoreReaderDraft } from './editor/outbox';
import { conversationTool, ROW_GIVES_WAY, useToolsHere } from './task-action-slot';

/**
 * The opened Task's own words, put aside when another card took the input (outbox.ts keeps the one original). Browsing
 * never brings them back by itself; this is the person's way back, named with the Task they belong to. It only shows
 * that the original is kept; whether it can enter the input now is the outbox's to say.
 */
export function ParkedReturn({ folded = false }: { folded?: boolean }) {
  const { t } = useTranslation('ui');
  const root = useConversation(state => state.root);
  const conversationId = useConversation(state => state.conversation?.id ?? null);
  const taskId = useViewStore(shownInReader);
  const kept = useDraftStore(state => !!conversationId && !!taskId && !!parkedReaderDraft(state.entries, root, conversationId, taskId));
  const here = useToolsHere(folded);
  if (!kept || !here) return null;
  const take = () => {
    // Words being written stay where they are; the original stays kept until the input is empty.
    if (restoreReaderDraft(root, conversationId!, taskId!) === 'blocked') notify.info(t('coordinatorCard.takeBackHint'), { from: 'coordinator' });
    else focusCoordinator();
  };
  return <button type="button" data-coordinator-take-back-parked className={cn(conversationTool, ROW_GIVES_WAY, 'pointer-events-auto')} onClick={take}>
    <Icon name="up" className="size-3 flex-none" /><span className="min-w-0 truncate">{t('coordinatorCard.takeBackParked', { task: taskId })}</span>
  </button>;
}
