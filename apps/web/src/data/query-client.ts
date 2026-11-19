import { bindWriteAccess, type WriteBasis } from './connection';
import { MutationCache, notifyManager, QueryCache, QueryClient } from "@tanstack/react-query";
import { observeReadProofs } from './read-model';
import { readDeadlinePassed, requireWriteAccess } from './client';
import { notify, recordFailure } from "@/lib/notify";
import { later } from "@/lib/later";

// A read's readers draw in a task of their own already (the default is a timer); this lets a waiting key go first.
notifyManager.setScheduler(later);


declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      /**
       * `false` when the screen shows this mutation's failure itself (inside a
       * form); the shared toast then stays silent. Omitted means toast.
       */
      errorToast?: false;
    };
  }
}
/**
 * A read the server stayed silent on is asked again a few times, with Query's growing wait, before its failure is said where
 * it is read: a request made while the server is busy would otherwise fail for good moments before it answers again.
 */
const READ_RETRIES = 3;
export const queryClient = new QueryClient({
  // A read that fails is said where it is read (a list's line, the reader); its cause is kept here, once a fetch.
  queryCache: new QueryCache({ onError: (error, query) => recordFailure(error, `read ${JSON.stringify(query.queryKey)}`) }),
  // Every failed mutation is toasted, unless it opts out with `meta.errorToast`.
  mutationCache: new MutationCache({
    onMutate: (variables) => { requireWriteAccess(variables && typeof variables === 'object' && 'basis' in variables ? variables.basis as WriteBasis : undefined); },
    // Recorded always; a screen that says the failure itself (a form) opts out of the toast only.
    onError: (error, _variables, _result, mutation) => {
      const about = `mutation ${JSON.stringify(mutation.options.mutationKey ?? "")}`;
      if (mutation.meta?.errorToast === false) recordFailure(error, about);
      else notify.failure(error, { about });
    },
  }),
  defaultOptions: {
    queries: { networkMode: "always", retry: (count, error) => count < READ_RETRIES && readDeadlinePassed(error), refetchOnReconnect: false, refetchOnWindowFocus: false },
    mutations: { networkMode: "always", retry: false },
  },
});

observeReadProofs(queryClient);

bindWriteAccess(queryClient);
