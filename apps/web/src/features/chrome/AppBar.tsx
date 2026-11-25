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
import { UpdateMark, useGearLabel } from "@/features/update/UpdateView";

/**
 * The header: the name of what the list shows in the brand's type, which is the project filter (`ProjectMenu`: All
 * projects or a project's name; its place a skeleton until the first index; cut with an ellipsis at its own reading
 * end, the whole of it in the tooltip, so the buttons keep to the right whatever its length or script), the search box
 * (⌘K; on a phone a button that opens its row), then what asks for the reader and what they start:
 * Your turn is not in the bar: its count and the way into it are the list's heading, and the detail's ‹ n/N ›.
 * Out of reach, the screen's one offline mark comes before the person's own buttons. Then settings and the
 * coordinator. Opens dialogs through `useDialogStore`.
 */
// One rule for every width, by the room the bar has (its container, so a task open beside the list counts too):
// - Under 37.5rem the bar is two rows, each in the same order: the name and the faces, then the plan limits and the buttons.
// - The name is as wide as it is, and gives way only once the search box is down to its least (12.5rem): the search
//   box takes what is left over. In a bar of 60rem and more both sides are at least as wide as each other, so the search
//   box stands in the middle of the bar and stays there when a button comes late (the plan limits) or goes (offline).
// The name cuts itself (`ProjectMenu`); the heading clips nothing, so the dot over the name's line is drawn whole.
const PROJECT = "flex min-w-0 flex-[0_1_auto] items-center gap-3 narrow:gap-2 @min-[60rem]:min-w-[min(20rem,28cqw)] @max-[37.5rem]:basis-full @max-[37.5rem]:justify-between";
const SEARCH = "mx-auto max-w-120 min-w-50 flex-[1_0_12.5rem] compactbar:hidden";
const ACTIONS = "ms-auto flex min-w-0 flex-none items-center justify-end gap-1.5 narrow:gap-0 @min-[60rem]:min-w-[min(20rem,28cqw)] @max-[37.5rem]:basis-full @max-[37.5rem]:justify-between";
const NAME = "min-w-0 text-left text-lg font-semibold";

export function AppBar() {
  const { t } = useTranslation("chrome");
  const { t: tt } = useTranslation("tree");
  const strips = useTimeView((state) => state.strips);
  const searchShown = useViewStore(isSearchShown);
  const readerOpen = useViewStore(state => state.reader.open);
  const narrow = useNarrow();
  const ready = useFrameSelector(data => data !== null);
  const { open } = useDialogStore.getState();
  const offline = useOfflineShown();
  const gearLabel = useGearLabel();

  return (
    <header className={cn("@container flex min-h-bar w-full flex-none items-center px-6 py-2 narrow:min-h-13.5 narrow:px-3",
      readerOpen && !narrow && "pr-[calc(var(--window-reserve)+36px)]")}>
      <div className="flex w-full min-w-0 items-center gap-3 narrow:gap-0.5 @max-[37.5rem]:flex-wrap @max-[37.5rem]:gap-y-0">
        <div className={PROJECT}>
          {ready ? <><ProjectMenu className={NAME} /><FaceSwitch /></> : <RegionSkeleton shape="title" />}
        </div>
        <SearchField className={SEARCH} />
        <div className={ACTIONS}>
          {/* What the bar reports comes first: out of reach, the screen's one offline mark; then how much of its plan the
              agent work goes on with has used (a press shows every agent's). On their own row they start where the name does. */}
          <div className="flex min-w-0 items-center gap-1.5 narrow:gap-0 @max-[37.5rem]:-ms-2">
            {offline && <OfflineMark />}
            <LimitsMenu />
          </div>
          {/* The bar's face. On a phone every button here is a 36px place (44px tall), so their marks stand 20px apart. */}
          <div className="flex flex-none items-center gap-1.5 narrow:gap-0">
            <Button variant="ghost" size="bar" data-search-toggle aria-label={t("toolbar.searchLabel")} title={t("toolbar.searchLabel")}
              aria-expanded={searchShown} className="hidden flex-none compactbar:flex narrow:w-9"
              onClick={() => { if (searchShown) cancelPendingSearch(); flushSync(() => useViewStore.getState().toggleSearch()); if (!searchShown) { countUse('search'); focusSearchInput(); } }}>
              <Icon name="search" />
            </Button>
            {/* On a phone the time strips are asked for here, not on a row of their own. It is an icon button's own 32px, and
                what is pressed is what is seen: the hover tone, with an edge while the strips are shown. Its margin makes
                the 36px place of its neighbours. */}
            <Button variant="ghost" size="icon" data-strips aria-pressed={strips} aria-label={tt("timeView.time")} title={tt("timeView.time")}
              className="hidden size-8 flex-none border border-solid border-transparent p-0 narrow:mx-0.5 narrow:flex aria-pressed:border-lit-line aria-pressed:bg-hover"
              onClick={() => { countUse('strips'); useTimeView.getState().setStrips(!strips); }}>
              <Icon name="activity" />
            </Button>
            <PresenceMenu />
            {/* The gear ends its icon on the list's right edge, as each line's last icon does (press-end); on a phone its
                36px place ends at the screen's edge, so its icon ends as near the edge as the name starts from the other. */}
            <Button
              variant="ghost"
              size="bar"
              className="press-end narrow:me-[-0.75rem] narrow:w-9"
              aria-label={gearLabel}
              title={gearLabel}
              data-guide-part="settings"
              onClick={() => open("settings")}
            >
              {/* A new version, one under way or one that failed is told by the gear's corner mark. */}
              <span className="relative inline-flex"><Icon name="settings" /><UpdateMark /></span>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
