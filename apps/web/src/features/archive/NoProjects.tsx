import { useTranslation } from "react-i18next";
import { Message } from "@/components/ui/message";

/** The list's place when no project is shown: every one is archived, or none was made. Both ways out (the settings' Archive tab, Create project), and no count. */
export function NoProjects({ onOpenArchive, onCreateProject }: { onOpenArchive: () => void; onCreateProject: () => void }) {
  const { t } = useTranslation("panels");
  return <section data-no-projects className="px-4 pt-16 narrow:pt-10">
    <Message tone="empty" icon="archive" title={t("archive.empty.title")}
      action={{ label: t("archive.empty.open"), icon: "archive", run: onOpenArchive }}
      secondary={{ label: t("chrome:projects.new"), icon: "plus", run: onCreateProject }} />
  </section>;
}
