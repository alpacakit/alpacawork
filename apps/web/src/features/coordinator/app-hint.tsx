import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { deviceValue, useDeviceValue } from "@/lib/device-storage";
import { useCoarsePointer, useInstalledApp } from "@/lib/input-capabilities";
import { openSettings } from "@/state/dialog-store";

/**
 * Whether this browser is done with the pointer to the phone and app guide. It is done once it is pressed or closed,
 * or once its conversation holds a message: the pointer belongs to the first empty conversation only, so a person
 * already at work never sees it.
 */
export const appHintDone = deviceValue("alpacawork.appHintDone", { read: (raw) => raw === "1" || null, write: () => "1" }, false);
export const finishAppHint = () => { appHintDone.set(true); };

/**
 * A small drawing of the two places the guide leads to: a computer's window with alpacawork's rows, and a phone in
 * front of it showing the same rows. It is what catches the eye under the examples, which are words only; it carries
 * no meaning of its own, so it is hidden from a screen reader. Drawn in the ink colours; at this size its stroke comes
 * out at the icon set's 1.5px.
 */
function AppHintPicture() {
  return <svg viewBox="0 0 64 44" aria-hidden="true" fill="none" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round"
    className="h-14 w-20 flex-none">
    <g className="stroke-muted">
      <rect x="1.75" y="3.75" width="46.5" height="31.5" rx="3" className="fill-lit" />
      <path d="M1.75 10.25h46.5" />
      <path d="M5.5 7h.01M8.5 7h.01M11.5 7h.01" />
      <path d="M7 16h20M7 21.5h16M7 27h18" className="stroke-soft" />
    </g>
    <g className="stroke-ink">
      <rect x="42.75" y="14.75" width="18.5" height="27.5" rx="3.5" className="fill-raised" />
      <path d="M47 21.5h10M47 26.5h8M47 31.5h9" className="stroke-soft" />
      <path d="M49.5 38.5h5" />
    </g>
  </svg>;
}

/**
 * Under the greeting of a first conversation, a picture of a computer's window and a phone with one line beside it:
 * it opens the settings' guide to using alpacawork from a phone or as an installed app, which nothing else on the
 * first screen points to. The picture is what makes it seen among the examples' words; it has no frame or fill of its
 * own, so it does not read as one more example. Not drawn where that guide is not (a touch screen) or not needed
 * (already the installed app).
 */
export function AppHint() {
  const { t } = useTranslation("ui");
  const done = useDeviceValue(appHintDone);
  const coarse = useCoarsePointer();
  const installed = useInstalledApp();
  const id = useId();
  if (done || coarse || installed) return null;
  return <div data-app-hint className="mt-4 flex items-center gap-1">
    <Button variant="ghost" aria-labelledby={`${id}-open`} aria-describedby={`${id}-detail`}
      className="min-w-0 flex-1 justify-start gap-3 rounded-lg py-2 pr-3 pl-2 text-left whitespace-normal [word-break:auto-phrase]"
      onClick={() => { finishAppHint(); openSettings("apps"); }}>
      <AppHintPicture />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={`${id}-open`} className="text-base font-medium text-ink">{t("coordinatorCard.appHint.open")}</span>
        <span id={`${id}-detail`} className="text-sm text-pretty text-soft">{t("coordinatorCard.appHint.detail")}</span>
      </span>
      <Icon name="arrowRight" className="size-4 flex-none text-soft" />
    </Button>
    <Button variant="quiet" size="icon" aria-label={t("coordinatorCard.appHint.close")} title={t("coordinatorCard.appHint.close")}
      onClick={finishAppHint}>
      <Icon name="close" className="size-4" />
    </Button>
  </div>;
}
