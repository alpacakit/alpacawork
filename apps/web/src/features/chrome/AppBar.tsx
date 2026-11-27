import { countUse } from '@/features/telemetry/count';
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useFrameSelector } from "@/data/workspace-store";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { useDialogStore } from "@/state/dialog-store";
import { isSearchShown, useNarrow, useViewStore } from "@/state/view-store";
import { useTimeView } from "@/state/time-view";
import { flushSync } from "react-dom";
import { cancelPendingSearch, focusSearchInput } from "./search-ref";
import { cn } from "@/lib/utils";
import { SearchField } from "./SearchField";
import { PresenceMenu } from './PresenceMenu';
import { LimitsMenu } from './LimitsMenu';
import { ProjectMenu } from "./ProjectMenu";
import { FaceSwitch } from "@/features/analysis/FaceSwitch";
import { OfflineMark } from "./OfflineMark";
import { useOfflineShown } from "@/data/reach";
import { UpdateMark, useGearLabel, useOpenSettingsFromGear } from "@/features/update/UpdateView";
import { BarMenu } from "./BarMenu";
import { usePresenceActivity } from "@/data/presence";
import { useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";

/**
 * The header: the name of what the list shows in the brand's type, which is the project filter (`ProjectMenu`: All
 * projects or a project's name; its place a skeleton until the first index; cut with an ellipsis at its own reading
 * end, the whole of it in the tooltip, so the buttons keep to the right whatever its length or script), the search box
 * (⌘K; on a phone a button that opens its row), then what asks for the reader and what they start:
 * Your turn is not in the bar: its count and the way into it are the list's heading, and the detail's ‹ n/N ›.
 * Out of reach, the screen's one offline mark comes before the person's own buttons. Then settings and the
 * coordinator. Opens dialogs through `useDialogStore`.
 */
// One row at every width. Folded (barFolds), the faces, the time strips, the notification state and settings go into
// the menu ☰ opens at the bar's start (BarMenu), and the name opens that menu too; the name and the plan limits stay.
// - The name is as wide as it is, and gives way only once the search box is down to its least (12.5rem): the search
//   box takes what is left over. In a bar of 60rem and more both sides are at least as wide as each other, so the search
//   box stands in the middle of the bar and stays there when a button comes late (the plan limits) or goes (offline).
// The name cuts itself (`ProjectMenu`); the heading clips nothing, so the dot over the name's line is drawn whole.
const PROJECT = "flex min-w-0 flex-[0_1_auto] items-center gap-3 narrow:gap-2 @min-[60rem]:min-w-[min(20rem,28cqw)]";
const SEARCH = "mx-auto max-w-120 min-w-50 flex-[1_0_12.5rem] compactbar:hidden";
const ACTIONS = "ms-auto flex min-w-0 flex-none items-center justify-end gap-1.5 narrow:gap-0 @min-[60rem]:min-w-[min(20rem,28cqw)]";
const NAME = "min-w-0 text-left text-lg font-semibold";

/**
 * Whether the bar folds: under 34rem of its own width (a phone, or a computer's list beside a wide detail) the bar on
 * one row would leave the name about eight characters, so what is not read at a glance goes into the menu.
 */
const barFolds = (width: number, rem: number): boolean => width < 34 * rem;

/** barFolds for the bar's box, measured before it is painted and again as it is resized. */
function useFolded(bar: React.RefObject<HTMLElement | null>): boolean {
  const [folded, setFolded] = useState(false);
  useLayoutEffect(() => {
    const box = bar.current;
    if (!box) return;
    const measure = () => {
      // A box not laid out yet (no width) is not a limit.
      if (!box.clientWidth) return;
      const style = getComputedStyle(box);
      const width = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setFolded(barFolds(width, parseFloat(getComputedStyle(document.documentElement).fontSize)));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    return () => watch.disconnect();
  }, [bar]);
  return folded;
}

/** The bar across the page's top; `docked`: a window stands at the page's right (Workbench), and the bar gives it its room. */
export function AppBar({ docked = false }: { docked?: boolean }) {
  const { t } = useTranslation("chrome");
  const { t: tt } = useTranslation("tree");
  const strips = useTimeView((state) => state.strips);
  const searchShown = useViewStore(isSearchShown);
  const narrow = useNarrow();
  const ready = useFrameSelector(data => data !== null);
  const { open } = useDialogStore.getState();
  const offline = useOfflineShown();
  const gearLabel = useGearLabel();
  const openSettings = useOpenSettingsFromGear();
  const bar = useRef<HTMLElement>(null);
  const folded = useFolded(bar);
  const [menu, setMenu] = useState(false);
  // The page reports the person's presence while it is open, whether the notification button is in the bar or folded.
  const present = usePresenceActivity();
  // The menu is the folded bar's: unfolded, it has closed, and folding again does not open it.
  if (!folded && menu) setMenu(false);

  return (
    <header ref={bar} data-bar-folded={folded || undefined} className={cn("@container flex min-h-bar w-full flex-none items-center px-6 py-2 narrow:min-h-13.5 narrow:px-3",
      docked && "pr-[calc(var(--window-reserve)+36px)]")}>
      <div className="flex w-full min-w-0 items-center gap-3 narrow:gap-0.5">
        <div className={PROJECT}>
          {folded && <BarMenu open={menu} onOpenChange={setMenu} present={present} />}
          {ready ? <>
            <ProjectMenu className={NAME} onOpen={folded ? () => setMenu(true) : undefined} />
            {!folded && <FaceSwitch />}
          </> : <RegionSkeleton shape="title" />}
        </div>
        <SearchField className={SEARCH} />
        <div className={ACTIONS}>
          {/* What the bar reports comes first: out of reach, the screen's one offline mark; then how much of its plan the
              agent work goes on with has used (a press shows every agent's). */}
          <div className="flex min-w-0 items-center gap-1.5 narrow:gap-0">
            {offline && <OfflineMark />}
            <LimitsMenu />
          </div>
          {/* The bar's face. On a phone every button here is a 36px place (44px tall), so their marks stand 20px apart. */}
          <div className="flex flex-none items-center gap-1.5 narrow:gap-0">
            <Button variant="ghost" size="bar" data-search-toggle aria-label={t("toolbar.searchLabel")} title={t("toolbar.searchLabel")}
              aria-expanded={searchShown} className={cn("hidden flex-none compactbar:flex narrow:w-9", folded && "press-end narrow:me-[-0.75rem]")}
              onClick={() => { if (searchShown) cancelPendingSearch(); flushSync(() => useViewStore.getState().toggleSearch()); if (!searchShown) { countUse('search'); focusSearchInput(); } }}>
              <Icon name="search" />
            </Button>
            {!folded && <>
              {/* On a phone the time strips are asked for here, not on a row of their own. It is an icon button's own 32px, and
                  what is pressed is what is seen: the hover tone, with an edge while the strips are shown. Its margin makes
                  the 36px place of its neighbours. */}
              <Button variant="ghost" size="icon" data-strips aria-pressed={strips} aria-label={tt("timeView.time")} title={tt("timeView.time")}
                className="hidden size-8 flex-none border border-solid border-transparent p-0 narrow:mx-0.5 narrow:flex aria-pressed:border-lit-line aria-pressed:bg-hover"
                onClick={() => { countUse('strips'); useTimeView.getState().setStrips(!strips); }}>
                <Icon name="activity" />
              </Button>
              <PresenceMenu present={present} />
              {/* The gear ends its icon on the list's right edge, as each line's last icon does (press-end); on a phone its
                  36px place ends at the screen's edge, so its icon ends as near the edge as the name starts from the other. */}
              <Button
                variant="ghost"
                size="bar"
                className="press-end narrow:me-[-0.75rem] narrow:w-9"
                aria-label={gearLabel}
                title={gearLabel}
                data-guide-part="settings"
                onClick={openSettings}
              >
                {/* A new version, one under way or one that failed is told by the gear's corner mark. */}
                <span className="relative inline-flex"><Icon name="settings" /><UpdateMark /></span>
              </Button>
            </>}
          </div>
        </div>
      </div>
    </header>
  );
}
