import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { Message } from "@/components/ui/message";
import { cn } from "@/lib/utils";

/** The buttons under a step's settings: Back on the left, then the other way on, then the step's own. A phone stacks
 * them, its own first, at the end of the content (never fixed over a field being typed in). */
export function StepButtons({ back, other, children, failure }: { back?: { onClick: () => void; disabled?: boolean }; other?: ReactNode; children: ReactNode; failure?: ReactNode }) {
  const { t } = useTranslation("setup");
  return <div className="mt-6 border-t border-line pt-5">
    {failure}
    {/* A phone reads it bottom up (the step's own button first, Back last), from the order a computer shows. */}
    <div className="flex items-center gap-3 narrow:flex-col-reverse narrow:items-stretch">
      {back && <button type="button" disabled={back.disabled} onClick={back.onClick}
        className="inline-flex min-h-8 items-center gap-1 text-muted hover:text-ink disabled:opacity-38 narrow:self-start">
        <Icon name="left" className="size-3.5" />{t("back")}</button>}
      <div className="ml-auto flex items-center gap-3 narrow:contents">{other}{children}</div>
    </div>
  </div>;
}

/** The mark on what the setup recommends: the same pill as a recommended answer to a question. */
export function RecommendedMark({ id, className }: { id?: string; className?: string }) {
  const { t } = useTranslation("setup");
  return <span id={id} data-setup-recommended className={cn("rounded-full border border-turn bg-lit px-1.5 text-xs font-normal whitespace-nowrap text-turn", className)}>{t("recommended")}</span>;
}

/** Says an offer may still change; quieter than the recommended mark, since it urges nothing. */
export function BetaMark({ className }: { className?: string }) {
  const { t } = useTranslation("setup");
  return <span data-setup-beta className={cn("rounded-full border border-line px-1.5 text-xs font-normal whitespace-nowrap text-muted", className)}>{t("beta")}</span>;
}

export function FailureLine({ text, detail }: { text: string; detail: string }) {
  return <Message tone="error" size="line" className="mb-3" title={text} description={detail || undefined} />;
}

/** A step's settings while they are read: rows in the shape they will take. */
export function Loading() {
  const { t } = useTranslation("ui");
  return <div data-setup-loading role="status" aria-label={t("loading")} aria-busy="true">
    {[0, 1].map(row => <div key={row} className="flex h-20 items-center gap-3 border-b border-line" aria-hidden="true">
      <span className="size-10 rounded-md bg-placeholder animate-placeholder" />
      <span className="flex-1 space-y-2"><span className="block h-4 w-28 rounded-sm bg-placeholder animate-placeholder" /><span className="block h-3 w-40 rounded-sm bg-placeholder animate-placeholder" /></span>
    </div>)}
  </div>;
}
