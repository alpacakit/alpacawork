import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOfflineShown } from "@/data/reach";
import { cn } from "@/lib/utils";
import { Message, type MessageSize } from "./message";
import { describeProblem, issueText, problemText } from "@/features/forms/problem-text";
import { ApiError } from "@/data/client";
import { PLACEHOLDER_WAIT_MS, RegionSkeleton, type SkeletonShape } from "./skeleton";

/** One wait policy for an initial resource or a missing part: fast reads never flash a placeholder. */
export function useWaited(pending: boolean) {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!pending) { setWaited(false); return; }
    const timer = setTimeout(() => setWaited(true), PLACEHOLDER_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  return pending && waited;
}

/**
 * A still missing part of an otherwise readable region; retained content is never replaced by this wait. With `waitFrom`
 * the part is the rest of a wait already under way, shown on that wait's time (RegionSkeleton).
 */
export function PendingRegion({ pending, shape, waitFrom }: { pending: boolean; shape: SkeletonShape; waitFrom?: number }) {
  const waited = useWaited(pending && waitFrom === undefined);
  if (pending && waitFrom !== undefined) return <RegionSkeleton shape={shape} waitFrom={waitFrom} />;
  return waited ? <RegionSkeleton shape={shape} /> : null;
}

type Query<T> = { data: T | undefined; isPending: boolean; isError: boolean; isFetching: boolean;
  isPlaceholderData?: boolean; error: Error | null; refetch: () => unknown };

/**
 * The one way a read that failed is said where its content was to be: what could not be read (`what`, the place's own
 * words, when the failure alone does not say it), the failure in the person's words (problemText), what is shown
 * meanwhile (`note`), and asking again. A read is a state of its place, not a one-time result, so it is not a toast
 * (lib/notify.ts); its cause is recorded once by the query cache (data/query-client.ts). Every list, reader, file,
 * search and settings place that cannot read says it this way.
 */
/** A reading surface may reselect its saved position before any explicit acquisition retry. */
export const ReadRetryContext = createContext<(() => void) | null>(null);

/** `disabled`: the retry can't start now (the same read, or another answer, is already awaited from here or elsewhere). */
export function ReadFailure({ error, what, note, retry, disabled, className, size = "line" }: {
  error?: unknown; what?: string; note?: string; retry?: () => unknown; disabled?: boolean; className?: string; size?: MessageSize;
}) {
  const { t } = useTranslation();
  const reselect = useContext(ReadRetryContext);
  // Under a retry the failure's own "try again" is the button: only serve's reason (what is wrong) is said, and the place's note.
  // Without the place's own words the failure's words are the heading.
  const reason = error === undefined ? undefined : what && retry ? readFailureReason(error) : problemText(error);
  const why = [reason, note].filter(Boolean).join(" ");
  return <Message data-read-failure tone="error" size={size} className={className} title={what ?? why} description={what ? why || undefined : undefined}
    action={retry && { label: t("retry"), disabled, run: () => { reselect?.(); return retry(); } }} />;
}

/** Why a read failed, when serve said why (a reason, or what was wrong in what was asked); nothing when only "try again". */
export function readFailureReason(error: unknown): string {
  const issues = error instanceof ApiError ? error.issues.map(issueText) : [];
  return issues.length ? issues.join(" ") : describeProblem(error).detail;
}

/** An unacquired region is explicit; it never masquerades as a successful empty read. */
export function ReadNote({ kind, className, children }: { kind: "absent"; className?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  // While the feed is still opening nothing is out of reach yet; what is not held is on its way (the progress line).
  if (!useOfflineShown()) return null;
  return <Message data-read-note={kind} live tone="info" icon="offline" size="line" className={className} title={children ?? t("read.absent")} />;
}

/** Initial wait, refresh, error and empty content use one timing and recovery policy. */
export function Loadable<T>({ query, skeleton, empty, children, unwrapped = false }: {
  query: Query<T>; skeleton: ReactNode; empty: ReactNode; children: (data: T) => ReactNode;
  unwrapped?: boolean;
}) {
  const missing = query.data === undefined && query.isPending && !query.isError;
  // A wait under 150ms shows nothing; a longer one shows the skeleton, whose blocks come in slowly (`animate-placeholder`)
  // so a read that ends as they come is hardly seen. What arrives is drawn at once: the skeleton never holds it back.
  const waited = useWaited(missing);
  const dim = useWaited(!!query.isPlaceholderData && query.isFetching);
  if (query.isError && query.data === undefined) return <ReadFailure size="region" error={query.error} retry={() => void query.refetch()} />;
  if (missing && waited) return <>{skeleton}</>;
  if (query.data === undefined) return null;
  const content = children(query.data);
  if (unwrapped && !dim) return <>{content || empty}</>;
  return <div className={dim ? "opacity-50" : undefined}>{content || empty}</div>;
}
