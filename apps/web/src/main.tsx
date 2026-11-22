import { startReadScheduler } from '@/data/read-scheduler';
import { watchUndoOffers } from '@/features/undo/undo-toast';
import { recordFailure } from '@/lib/notify';
import { restoreReadPersistence, startReadPersistence } from '@/data/read-persistence';
import { observeReadRefusals, onReadEvent, startRequiredReadSession } from '@/data/resources';
import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { i18n, startI18n } from "@alpacawork/i18n";
import { Toaster } from "@/components/ui/toaster";
import { queryClient } from "@/data/query-client";
import { Workspace } from "@/data/Workspace";
import { Workbench } from "@/features/shell/Workbench";
import { useEntrance } from "@/features/setup/entrance";
import { registerServiceWorker } from "@/data/push";
import { takeInitialShared } from "@/features/coordinator/shared";
import { guardPinchZoom } from "@/lib/pinch-zoom";
import { watchDesktopApp } from "@/lib/desktop-app";
import "./styles.css";

// index.html is written in English; the document follows the running language.
i18n.on("languageChanged", (locale) => {
  document.documentElement.lang = locale;
});
startI18n();
watchUndoOffers();
registerServiceWorker();
guardPinchZoom(window);
// Before anything is awaited: the browser offers to install the page soon after it loads.
watchDesktopApp();
void takeInitialShared();

// The setup is its own chunk, fetched only on its address, before the data provider that draws it mounts.
const Setup = useEntrance.getState().setup ? (await import("@/features/setup/SetupScreen")).SetupScreen : null;
// What this browser stored is restored beside startup, never before it: the restore gives way to every read this
// session makes (read-persistence).
void restoreReadPersistence(queryClient, error => recordFailure(error, 'read storage'));
startRequiredReadSession(queryClient);
startReadScheduler(queryClient);
startReadPersistence(queryClient, changed => onReadEvent(queryClient, changed));
observeReadRefusals(queryClient);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Workspace><Entrance Setup={Setup} /></Workspace>
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);

/** The setup until it is finished, then the page, in the same document. */
function Entrance({ Setup }: { Setup: ComponentType | null }) {
  const setup = useEntrance(state => state.setup);
  return setup && Setup ? <Setup /> : <Workbench />;
}
