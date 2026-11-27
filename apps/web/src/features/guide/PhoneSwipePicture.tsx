import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { stampInk } from "@/features/reader/stamp";

/**
 * Answering on a phone, drawn small in a guide balloon's colours and played over and over: a finger picks a choice on
 * the question's card, swipes the card to the right, the send's own stamp is pressed on over the screen, the card goes,
 * and the next card comes. Words are skimmed; this shows at a glance what the phone is for. The stamp's words and ink are the
 * phone's own (the reader's swipe). The balloon's words say the same, so the picture is hidden from a screen reader.
 * With motion reduced it stands still at the swipe, stamp on (styles/parts.css).
 */
export function PhoneSwipePicture() {
  const { t } = useTranslation("reader");
  return <div aria-hidden="true" data-guide-phone-swipe className="flex justify-center pt-1 pb-2">
    {/* The phone: its outline, and the screen in it, which the card does not leave. */}
    <div className="relative h-36 w-22 overflow-hidden rounded-[14px] border-2 border-bg/60 bg-bg/10">
      <span className="absolute top-1.5 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-bg/40" />
      <div data-guide-swipe-card className="absolute inset-x-2 top-5 bottom-3 flex flex-col gap-1.5 rounded-md bg-bg p-1.5">
        <span className="h-1.5 w-4/5 rounded-full bg-ink/70" />
        <span className="h-1 w-3/5 rounded-full bg-ink/25" />
        <span data-guide-swipe-choice className="mt-1 h-4 rounded border border-ink/25" />
        <span className="h-4 rounded border border-ink/25" />
      </div>
      {/* The stamp stands where the screen is, not on the moving card, as the phone's own does. */}
      <span data-guide-swipe-stamp className={cn("absolute top-9 left-1/2 flex -translate-x-1/2 -rotate-12 items-center gap-0.5 rounded border-2 border-current bg-stamp px-1 py-0.5 text-micro font-extrabold whitespace-nowrap", stampInk.send)}>
        <Icon name="plane" className="size-[1em] stroke-[2.75]" />{t("swipe.send")}
      </span>
      {/* The finger: a round mark where it touches. */}
      <span data-guide-swipe-finger className="absolute top-0 left-0 size-5 rounded-full border-2 border-ink/45 bg-ink/15 outline-2 outline-bg" />
    </div>
  </div>;
}
