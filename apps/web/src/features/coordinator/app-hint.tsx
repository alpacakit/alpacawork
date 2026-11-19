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
 * One quiet line under the greeting of a first conversation: it opens the settings' guide to using alpacawork from a
 * phone or as an installed app, which nothing else on the first screen points to. Not drawn where that guide is not
 * (a touch screen) or not needed (already the installed app).
 */
export function AppHint() {
  const { t } = useTranslation("ui");
  const done = useDeviceValue(appHintDone);
  const coarse = useCoarsePointer();
  const installed = useInstalledApp();
  if (done || coarse || installed) return null;
  return <div data-app-hint className="mt-3 flex items-center gap-1">
    <Button variant="outline" className="min-w-0 flex-1 justify-start whitespace-normal text-left [word-break:auto-phrase]"
      onClick={() => { finishAppHint(); openSettings("apps"); }}>
      <Icon name="download" className="size-4 flex-none text-soft" />
      <span className="min-w-0 flex-1">{t("coordinatorCard.appHint.open")}</span>
      <Icon name="arrowRight" className="size-4 flex-none text-soft" />
    </Button>
    <Button variant="quiet" size="icon" aria-label={t("coordinatorCard.appHint.close")} title={t("coordinatorCard.appHint.close")}
      onClick={finishAppHint}>
      <Icon name="close" className="size-4" />
    </Button>
  </div>;
}
