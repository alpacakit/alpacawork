import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { textClip } from "@/lib/clipboard";
import { useWorkspaceInfo } from "@/data/queries";
import { useDialogStore } from "@/state/dialog-store";

/** The folder this server reads, in small muted type at the foot of Server settings: looked up, not set. */
export function WorkspaceFolderLine() {
  const { t } = useTranslation("panels");
  const root = useWorkspaceInfo((info) => info.root);
  return (
    <div data-workspace-folder className="mt-8 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-x-1">
        <span>{t("settings.server.folder")}</span>
        {/* The path and its copy mark wrap as one, so the mark stays beside what it copies. */}
        <span className="flex min-w-0 items-center gap-1">
          <span data-workspace-root className="min-w-0 font-mono [overflow-wrap:anywhere]">{root}</span>
          <CopyButton clip={() => textClip(root)} label={t("settings.server.folderCopy")} className="size-6 min-h-6 flex-none narrow:size-11 narrow:min-h-11" />
        </span>
      </div>
      {/* Problems show themselves above the list (WorkspaceNotice); this is the way in while all is well.
          On a phone its press reaches 44px high without making the line taller. */}
      <Button variant="ref" className="relative text-muted hover:text-ink narrow:after:absolute narrow:after:-inset-y-3.5 narrow:after:inset-x-0 narrow:after:content-['']" onClick={() => useDialogStore.getState().open("diagnostics")}>{t("settings.server.diagnostics")}</Button>
    </div>
  );
}
