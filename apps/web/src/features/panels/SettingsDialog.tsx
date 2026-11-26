import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCoarsePointer } from "@/lib/input-capabilities";
import { FieldHint } from "@/components/ui/field";
import { useDialogStore, type SettingsFocus, type SettingsTab } from "@/state/dialog-store";
import { HostTab } from "./HostTab";
import { DialogBody } from "@/components/ui/dialog";
import { PanelDialog } from "./PanelDialog";
import { GeneralSettingsTab, NotificationSettingsTab } from "./PersonalSettingsTab";
import { AdvancedServerOptions, AiSettingsTab, ServerDraftProvider, ServerFolderLines } from "./ServerSettingsTab";
import { AppGuideTab } from "./AppGuideTab";
import { ProjectsSettingsTab } from "./ProjectsSettingsTab";
import { UpdateConfirmDialog, UpdateStateLine, VersionLine } from "@/features/update/UpdateView";

/**
 * Settings, in tabs named for what they hold, in the order they are looked for. This PC's config.yaml is one draft for
 * the dialog, read with its hash when it opens: AI shows its AI and agents, General's Advanced options its limits, each
 * with the same save row, and General ends on the folder the server reads. Notifications and General's own values save
 * at once; Projects lists every project, archived ones marked, each opening its own settings, which are the project
 * dialog's, not here; App & phone guides installing the app and opening it from a phone; Resources is read-only.
 * Updates have no tab: their one status line (with its one action) above the tabs and the running version at the foot.
 */
export function SettingsDialog({ initialTab = "ai", request, focus }: { initialTab?: SettingsTab; request?: number; focus?: SettingsFocus } = {}) {
  const { t } = useTranslation("panels");
  return (
    <PanelDialog title={t("settings.title")} size="large" ownBody>
      <SettingsBody initialTab={initialTab} request={request} focus={focus} />
      <UpdateConfirmDialog />
    </PanelDialog>
  );
}

const TABS = ["ai", "notifications", "projects", "general", "apps", "host"] as const satisfies readonly SettingsTab[];

export function SettingsBody({ initialTab = "ai", request, focus }: { initialTab?: SettingsTab; request?: number; focus?: SettingsFocus }) {
  const focusNotifications = focus === "notifications";
  const focusStack = focus === "tasksAi" ? "tasks" : focus === "coordinatorAi" ? "coordinator" : undefined;
  const { t } = useTranslation("panels");
  const coarsePointer = useCoarsePointer();
  // The guide is read at a computer: a phone that opens this is past every step of it.
  const availableTabs = TABS.filter((value) => value !== "apps" || !coarsePointer);
  const [selected, setTab] = useState<SettingsTab>(initialTab);
  // A later request for a tab (a host push tapped while the dialog is open) moves there; drafts in the other tabs stay.
  const [seen, setSeen] = useState(request);
  const requested = request !== seen ? initialTab : selected;
  // A remembered tab, a later request and an input change all follow the same available-tab rule.
  const tab = availableTabs.includes(requested) ? requested : availableTabs[0]!;
  if (request !== seen || selected !== tab) {
    setSeen(request);
    setTab(tab);
  }
  // The gear reopens the usual tab this one was last on.
  useEffect(() => useDialogStore.getState().rememberSettingsTab(tab), [tab]);
  const list = useRef<HTMLDivElement>(null);
  // Each tab is read from its top: the place scrolled to in one tab means nothing in the next.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [tab]);
  useEffect(() => {
    if (focusNotifications) document.getElementById("settings-notifications")?.focus();
  }, [focusNotifications]);
  // On narrow screens the row scrolls sideways and keeps the chosen tab in view.
  // Only the row scrolls, so the dialog keeps the place Notifications was focused at.
  useEffect(() => {
    const row = list.current, active = row?.querySelector('[data-state="active"]');
    if (!row || !active) return;
    const bounds = row.getBoundingClientRect(), chosen = active.getBoundingClientRect();
    if (chosen.left < bounds.left) row.scrollLeft -= bounds.left - chosen.left;
    else if (chosen.right > bounds.right) row.scrollLeft += chosen.right - bounds.right;
  }, [tab]);
  return (
    <ServerDraftProvider show={setTab} focusStack={focusStack ? { kind: focusStack, request: request ?? 0 } : undefined}>
    <Tabs value={tab} onValueChange={(value) => setTab(value as SettingsTab)} className="min-h-0 flex-1">
      {/* The tabs stay with the head; only the tab shown scrolls under them. */}
      <div className="flex-none px-6 narrow:px-4.5">
        <UpdateStateLine />
        {/* The rule under the tabs is as wide as the rows below; the row itself reaches a little past both ends, so
            the first tab's face starts on the title's edge and its focus ring is drawn whole. */}
        <div className="border-b border-line">
          <TabsList ref={list} className="-mx-1 border-b-0">
            {/* Mapped over TABS itself: i18n:extract reads each `settings.tabs.*` key from this constant list, not a filtered copy. */}
            {TABS.map((value) => availableTabs.includes(value) && <TabsTrigger key={value} value={value}>
              {t(`settings.tabs.${value}`)}
            </TabsTrigger>)}
          </TabsList>
        </div>
      </div>
      <DialogBody ref={body} className="flex flex-col border-t-0 pt-5">
      {/* The two tabs showing the draft stay mounted while hidden, so a refused save can take the eye into either. */}
      <TabsContent value="ai" forceMount hidden={tab !== "ai"}>
        <AiSettingsTab />
      </TabsContent>
      <TabsContent value="notifications">
        <NotificationSettingsTab focusNotifications={focusNotifications} />
      </TabsContent>
      <TabsContent value="projects">
        <ProjectsSettingsTab />
      </TabsContent>
      <TabsContent value="general" forceMount hidden={tab !== "general"}>
        <GeneralSettingsTab><AdvancedServerOptions /></GeneralSettingsTab>
        <ServerFolderLines />
      </TabsContent>
      {availableTabs.includes("apps") && <TabsContent value="apps">
        <AppGuideTab />
      </TabsContent>}
      <TabsContent value="host">
        <HostTab />
      </TabsContent>
      {/* At the foot of the box when the tab shown is short, after its last line when it is long. */}
      <div className="mt-auto"><VersionLine /></div>
      </DialogBody>
    </Tabs>
    </ServerDraftProvider>
  );
}
