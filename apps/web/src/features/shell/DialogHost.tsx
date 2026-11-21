import { useDialogStore } from "@/state/dialog-store";
import { RunFormDialog } from "@/features/forms/RunFormDialog";
import { SettingsDialog } from "@/features/panels/SettingsDialog";
import { DiagnosticsDialog } from "@/features/panels/DiagnosticsDialog";
import { ProjectDialog } from "@/features/panels/ProjectDialog";

/**
 * The one open dialog. Each dialog renders its
 * own `<Dialog open>` and closes with `useDialogStore.close`. Keyed so that
 * switching between two confirmations starts a fresh one. An input drawn in
 * place is not a dialog: the part of the screen it belongs to draws it.
 */
export function DialogHost() {
  const dialog = useDialogStore((state) => state.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "input":
      return null;
    case "run":
      return <RunFormDialog key={dialog.runId} target={dialog} />;
    case "settings":
      return <SettingsDialog initialTab={dialog.tab} request={dialog.request} focusNotifications={dialog.focusNotifications} />;
    case "diagnostics":
      return <DiagnosticsDialog />;
    case "project":
      return <ProjectDialog key={dialog.project === undefined ? "new" : dialog.project ?? "all"} project={dialog.project} />;
  }
}
