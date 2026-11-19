import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FieldHint } from '@/components/ui/field';
import { useWorkspaceInfo, useWriteDisabled } from '@/data/queries';
import { serverReadFacts } from '@/data/read-model';
import { workspaceWriteBasis, rowWriteBasis } from '@/data/connection';
import { checkDirectIntent, sendDirectIntent } from '@/data/direct-write';
import { useWriteIntent, useCheckShownHere } from '@/data/write-intent';
import { ArchiveProjectDialog } from './ArchiveProjectDialog';
import { archiveRefusal, projectArchiveIntentKey } from './archive-operations';

type ArchivedProjectRef = { id: string; title: string; hash: string };
type ProjectArchiveSectionProps = {
  project: ArchivedProjectRef; dirty: boolean; saving: boolean; onArchived: () => void;
};
/** The project settings (ProjectSettings) own saving/discarding and closing. Only the saved project and its exact hash cross this boundary. */
export function ProjectArchiveSection({ project, dirty, saving, onArchived }: ProjectArchiveSectionProps) {
  const { t } = useTranslation('panels'), client = useQueryClient(), root = useWorkspaceInfo(info => info.root);
  const [open, setOpen] = useState(false);
  const key = projectArchiveIntentKey(root, project.id);
  const intent = useWriteIntent(key);
  const checking = intent.status === 'unconfirmed';
  useCheckShownHere(key, open && checking);
  const disabled = useWriteDisabled(() => checking ? workspaceWriteBasis() : rowWriteBasis(project.id, project.hash));
  const archive = useMutation({
    meta: { errorToast: false },
    mutationFn: () => {
      if (dirty || saving) throw new Error('Save or discard changes first');
      if (checking) return checkDirectIntent(client, key);
      return sendDirectIntent(client, key, { path: 'task/archive', response: 'task', label: project.title, outcomes: 'all' },
        () => ({ task: project.id, expectedTaskHash: project.hash }), rowWriteBasis(project.id, project.hash), { admitted: () => setOpen(false) });
    },
  });
  const blocked = dirty || saving || disabled || archive.isPending || intent.status === 'pending' || intent.unavailable || intent.blocked;
  return <section data-project-archive>
    <h3 className="m-0 text-base font-medium">{t('archive.section.title')}</h3>
    <FieldHint>{t('archive.section.note')}</FieldHint>
    {dirty && <FieldHint>{t('archive.section.dirty')}</FieldHint>}
    <Button variant="outline" disabled={blocked} onClick={() => { archive.reset(); setOpen(true); }}>{checking ? t('reader:recovery.check') : t('archive.section.action')}</Button>
    {open && <ArchiveProjectDialog title={project.title} onOpenChange={setOpen}
      pending={blocked} onArchive={() => { if (!blocked) archive.mutate(undefined, {
        onSuccess: () => { setOpen(false); onArchived(); },
      }); }} checking={checking} failure={archive.error} refusal={archiveRefusal(archive.error, serverReadFacts(client)?.tasks)} />}
  </section>;
}
