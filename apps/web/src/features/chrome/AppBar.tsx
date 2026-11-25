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
// Equal space for the project and actions centres search. Where space is tight, status and actions get their own row.
const PROJECT = "flex min-w-0 flex-[1_1_17rem] items-center gap-3 @min-[60rem]:w-[min(20rem,28cqw)] @min-[60rem]:flex-none narrow:gap-2 @max-[27rem]:basis-full @max-[27rem]:justify-between";
const ACTIONS = "flex min-w-[min(20rem,28cqw)] flex-none items-center justify-end gap-1.5 @max-[60rem]:min-w-0 @max-[27rem]:basis-full @max-[27rem]:justify-between narrow:gap-0";
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
      <div className="flex w-full min-w-0 items-center gap-3 narrow:gap-0.5 @max-[27rem]:flex-wrap @max-[27rem]:gap-y-0">
        <div className={PROJECT}>
          {ready ? <><ProjectMenu className={NAME} /><FaceSwitch /></> : <RegionSkeleton shape="title" />}
        </div>
        <SearchField className="mx-auto w-full max-w-120 min-w-50 flex-[1_1_16rem] compactbar:hidden" />
        <div className={ACTIONS}>
          <div className="flex min-w-0 items-center gap-1.5 narrow:gap-0 @max-[27rem]:-ms-2">
            {offline && <OfflineMark />}
            <LimitsMenu />
          </div>
          <div className="flex flex-none items-center gap-1.5 narrow:gap-0">
            <Button variant="ghost" size="bar" data-search-toggle aria-label={t("toolbar.searchLabel")} title={t("toolbar.searchLabel")}
              aria-expanded={searchShown} className="hidden flex-none compactbar:flex narrow:w-9"
              onClick={() => { if (searchShown) cancelPendingSearch(); flushSync(() => useViewStore.getState().toggleSearch()); if (!searchShown) { countUse('search'); focusSearchInput(); } }}>
              <Icon name="search" />
            </Button>
            <Button variant="ghost" size="icon" data-strips aria-pressed={strips} aria-label={tt("timeView.time")} title={tt("timeView.time")}
              className="hidden size-8 flex-none border border-solid border-transparent p-0 narrow:mx-0.5 narrow:flex aria-pressed:border-lit-line aria-pressed:bg-hover"
              onClick={() => { countUse('strips'); useTimeView.getState().setStrips(!strips); }}>
              <Icon name="activity" />
            </Button>
            <PresenceMenu />
            <Button
              variant="ghost"
              size="bar"
              className="press-end narrow:me-[-0.75rem] narrow:w-9"
              aria-label={gearLabel}
              title={gearLabel}
              data-guide-part="settings"
              onClick={() => open("settings")}
            >
              <span className="relative inline-flex"><Icon name="settings" /><UpdateMark /></span>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
