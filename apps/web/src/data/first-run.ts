import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { firstRunRequestSchema, firstRunResponseSchema, type FirstRunChange, type FirstRunResponse } from "@alpacawork/contract";
import { workspaceWriteBasis } from "./connection";
import { useWorkspaceInfo } from "./queries";
import { api } from "./resources";

const firstRunKey = (root: string | undefined) => ["first-run", root] as const;

/** The setup of this workspace (`state: null` for one made before setup existed: nothing to set up). */
export function useFirstRun() {
  const root = useWorkspaceInfo((info) => info.root);
  return useQuery({
    queryKey: firstRunKey(root),
    queryFn: ({ signal }) => api.request("first-run", firstRunResponseSchema, signal),
    staleTime: Infinity,
  });
}

/** Writes one change; the answer is the state as saved, which the read shows from then on. */
export function useFirstRunChange() {
  const client = useQueryClient();
  const root = useWorkspaceInfo((info) => info.root);
  return useMutation({ meta: { errorToast: false },
    mutationFn: (change: FirstRunChange) => api.request("first-run", firstRunResponseSchema, undefined,
      firstRunRequestSchema.parse({ change }), crypto.randomUUID(), workspaceWriteBasis()),
    onSuccess: (response: FirstRunResponse) => client.setQueryData(firstRunKey(root), response),
  });
}
