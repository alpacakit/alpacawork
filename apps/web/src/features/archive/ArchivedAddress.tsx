import type { ProjectShelfInfo } from '@alpacawork/contract/control';
import { ReadFailure } from '@/components/ui/loadable';
import { openSettings } from '@/state/dialog-store';
import { ArchivedNotice } from './ArchivedNotice';
import { useArchiveCatalog } from './use-archive-catalog';

/** A refused URL supplies the explanation; only the separately acquired catalog supplies restoration authority. */
export function ArchivedAddress({ subject, shelf, placement }: {
  subject: { id: string; title: string; projectId?: string }; shelf: ProjectShelfInfo; placement: 'reader' | 'list';
}) {
  const catalog = useArchiveCatalog();
  const current = catalog.shelf.data?.projects.find(project => project.id === (subject.projectId ?? subject.id));
  // For a Task the catalog names its containing project through the refusal's outermost restore target.
  const target = current?.shelf.restoreTarget ?? catalog.shelf.data?.projects.find(project => project.id === shelf.restoreTarget?.id)?.shelf.restoreTarget;
  const displayed = current?.shelf ?? shelf;
  return <>
    {placement === 'reader' && <h2 className="m-0 mb-3 text-lg [overflow-wrap:anywhere]" data-archive-subject>
      <span className="mr-2 text-sm text-muted tabular-nums">{subject.id}</span>{subject.title}
    </h2>}
    <ArchivedNotice title={subject.title} shelf={displayed} placement={placement}
      onOpenArchive={() => openSettings('projects')}
      onRestore={() => { if (target) catalog.onRestore(target); }}
      restoreDisabled={catalog.restoreDisabled || !target} restoring={!!catalog.restoring}
      failure={catalog.restoreFailure?.error} />
    {catalog.shelf.isError && <ReadFailure error={catalog.shelf.error} retry={() => void catalog.shelf.refetch()} className="mt-2" />}
  </>;
}
