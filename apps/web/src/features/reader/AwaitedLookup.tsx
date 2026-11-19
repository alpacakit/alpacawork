import { readErrorWithReason } from '@/data/client';
import type { ProblemReason } from '@alpacawork/contract/problem';
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loadable } from "@/components/ui/loadable";
import { useWorkspaceInfo } from "@/data/queries";
import { ArchivedAddress } from "@/features/archive/ArchivedAddress";
import { shelvedReadDetail, resources } from "@/data/resources";
import { lookUpAgain } from "@/state/bootstrap";

/**
 * What waits for a task the URL names that is still being looked up (the reader's task, the list's scope): its shape
 * until the screen shows it. A lookup that failed says so with a way to ask again, through the screen's own lookup
 * (`lookUpAgain`): the screen is what reads its answer.
 */
export function AwaitedLookup({ address, reason, skeleton, placement = "reader" }: { address: string; reason: ProblemReason; skeleton: ReactNode; placement?: "reader" | "list" }) {
  const root = useWorkspaceInfo((info) => info.root);
  const lookup = useQuery(resources.taskView(root, address));
  const shelved = shelvedReadDetail(lookup.error);
  if (shelved) return <ArchivedAddress subject={shelved.task} shelf={shelved.shelf} placement={placement} />;
  return <Loadable query={{ ...lookup, error: lookup.error ? readErrorWithReason(lookup.error, reason) : null, data: undefined, isPending: !lookup.isError, refetch: async () => { lookUpAgain(); return lookup; } }}
    skeleton={skeleton} empty={null} unwrapped>{() => null}</Loadable>;
}
