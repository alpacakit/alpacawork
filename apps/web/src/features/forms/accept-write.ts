import { captureReadBoundary, sameReadSession } from '@/data/read-model';
import { queryClient } from '@/data/query-client';
import { useDialogStore } from '@/state/dialog-store';
import { useViewStore } from '@/state/view-store';
import { admissionError, type Submission } from '@/data/write-intent';
import { notify } from '@/lib/notify';

const currentView = () => { const { selected, project } = useViewStore.getState(); return { selected, project }; };
/** Calls `moved` once the person opens a dialog, or another task or project, after this moment. */
function watchPersonMoved(moved: () => void) {
  const { selected, project } = currentView();
  const offDialog = useDialogStore.subscribe(state => { if (state.dialog !== null) moved(); });
  const offView = useViewStore.subscribe(state => { if (state.selected !== selected || state.project !== project) moved(); });
  return () => { offDialog(); offView(); };
}

/** The view moves once `ready` holds (at once if it does), unless the person moved or the read session changed first. */
export function navigateWhen(ready: () => boolean, navigate: () => void) {
  if (ready()) { navigate(); return; }
  const boundary = captureReadBoundary(queryClient);
  const stop = () => { offCache(); offPerson(); };
  const offPerson = watchPersonMoved(stop);
  const offCache = queryClient.getQueryCache().subscribe(() => {
    if (!sameReadSession(queryClient, boundary)) { stop(); return; }
    if (!ready()) return;
    stop();
    navigate();
  });
}

/** A saved form closes at admission; later delivery cannot close or navigate a newer opening. */
export function acceptFormWrite<T>(submission: Submission<T>, accepted: () => void, confirmed?: (result: T, mayChangeView: boolean) => void) {
  if (submission.kind === 'rejected') throw admissionError(submission.reason);
  const boundary = captureReadBoundary(queryClient), view = currentView();
  accepted();
  let mayChangeView = useDialogStore.getState().dialog === null && currentView().selected === view.selected && currentView().project === view.project;
  const offPerson = watchPersonMoved(() => { mayChangeView = false; });
  void submission.result.then(result => {
    if (sameReadSession(queryClient, boundary)) confirmed?.(result, mayChangeView);
  }, () => { /* The saved result's observer owns refusal, unknown outcomes and cancellation. */ }).catch(error => {
    notify.failure(error, { about: 'saved form completion', id: `write-intent:${submission.id}` });
  }).finally(offPerson);
  return true;
}
