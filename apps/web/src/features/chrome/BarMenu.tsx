import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogCloseButton, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { menuRow } from "@/components/ui/menu-rows";
import { Switch } from "@/components/ui/switch";
import { FaceSwitch } from "@/features/analysis/FaceSwitch";
import { UpdateMark, useGearLabel, useOpenSettingsFromGear } from "@/features/update/UpdateView";
import { countUse } from "@/features/telemetry/count";
import { useTimeView } from "@/state/time-view";
import { useNarrow } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { moveMenuFocus } from "./menu-move";
import { PresenceGlyph, PresencePopup, usePresenceWords } from "./PresenceMenu";
import { ProjectChoices } from "./ProjectMenu";

/* Hallmark · component: the folded bar's menu · genre: modern-minimal · theme: the app's own tokens (raised, line, hover) */

/**
 * The folded bar's ☰ and the menu it opens from the screen's start edge (AppBar folds the bar). It holds what the
 * bar no longer shows: the faces at its top, the projects as the name's menu lists them (the only part that scrolls), and
 * at its foot the time strips (a phone's), the notification state and the settings. The notification state's menu
 * stands by ☰, the button that is seen. The guide's settings part is ☰ while the gear is folded into it.
 */
export function BarMenu({ open, onOpenChange, present }: { open: boolean; onOpenChange: (open: boolean) => void; present: () => Promise<void> }) {
  const { t } = useTranslation("chrome");
  const { t: tt } = useTranslation("tree");
  const narrow = useNarrow();
  const strips = useTimeView(state => state.strips);
  const gearLabel = useGearLabel();
  const openSettings = useOpenSettingsFromGear();
  const { presence, short } = usePresenceWords();
  const [presenceOpen, setPresenceOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => onOpenChange(false);
  // What opens a surface of its own does so once the menu has gone, so the focus comes back to ☰ first.
  const then = (action: () => void) => { close(); requestAnimationFrame(action); };
  const row = (mark: string, icon: ReactNode, label: ReactNode, action: () => void, end?: ReactNode, name?: string) =>
    <button type="button" role="menuitem" {...{ [`data-bar-menu-${mark}`]: "" }} aria-label={name} onClick={action} className={cn(menuRow(false), "gap-3 px-2.5")}>
      <span className="flex size-5 flex-none items-center justify-center text-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {end}
    </button>;
  return <>
    <Button ref={trigger} variant="ghost" size="bar" data-bar-menu-trigger data-guide-part="settings" aria-haspopup="dialog" aria-expanded={open}
      aria-label={t("appBar.menu")} title={t("appBar.menu")} className="flex-none narrow:-ms-2 narrow:w-9" onClick={() => onOpenChange(!open)}>
      {/* A new version is told by ☰'s corner while the gear is in the menu. */}
      <span className="relative inline-flex"><Icon name="menu" /><UpdateMark /></span>
    </Button>
    {/* Mounted while open, as every dialog here is: closing unmounts it, and the focus goes back to what opened it. */}
    {open && <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-bar-menu className="inset-y-0 start-0 end-auto m-0 h-dvh max-h-none w-[min(22rem,88vw)] max-w-none animate-drawer rounded-none border-0 border-e pb-[env(safe-area-inset-bottom)] narrow:max-h-none narrow:max-w-none">
        <div className="flex h-13.5 flex-none items-center justify-between gap-2 ps-4 pe-3">
          <DialogTitle className="text-base font-semibold">alpacawork</DialogTitle>
          <DialogCloseButton />
        </div>
        <FaceSwitch className="flex-none px-3 pb-2" onChose={close} />
        <div role="menu" aria-label={t("projects.menu")} onKeyDown={moveMenuFocus}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line p-1">
          <ProjectChoices onDone={close} focusBack={trigger} />
        </div>
        <div role="menu" aria-label={t("appBar.menu")} onKeyDown={moveMenuFocus} className="flex-none border-t border-line p-1">
          {/* A computer shows the strips from the list's own row; a phone asks for them here. */}
          {narrow && <button type="button" role="menuitemcheckbox" aria-checked={strips} data-strips className={cn(menuRow(false), "gap-3 px-2.5")}
            onClick={() => { countUse("strips"); useTimeView.getState().setStrips(!strips); }}>
            <span className="flex size-5 flex-none items-center justify-center text-muted"><Icon name="activity" className="size-4" /></span>
            <span className="min-w-0 flex-1 truncate">{tt("timeView.time")}</span>
            <Switch checked={strips} tabIndex={-1} aria-hidden="true" className="pointer-events-none" />
          </button>}
          {row("presence", <PresenceGlyph state={presence.state} />, t("presence.menuLabel"), () => then(() => setPresenceOpen(true)),
            <span className="flex flex-none items-center gap-1 text-sm text-soft">{short}<Icon name="right" className="size-4" /></span>)}
          {row("settings", <span className="relative inline-flex"><Icon name="settings" className="size-4" /><UpdateMark /></span>,
            t("appBar.settings"), () => then(openSettings), undefined, gearLabel)}
        </div>
      </DialogContent>
    </Dialog>}
    {presenceOpen && <PresencePopup anchorRef={trigger} align="start" present={present} onClose={() => setPresenceOpen(false)} />}
  </>;
}
