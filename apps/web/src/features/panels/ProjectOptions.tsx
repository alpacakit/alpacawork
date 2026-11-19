import { useTranslation } from "react-i18next";
import type { WorkspaceInfo } from "@/data/types";

/** The listed projects as a select's options: each by its title and ID, under the project it is in. */
export function ProjectOptions({ projects }: { projects: WorkspaceInfo["projects"] }) {
  const { t } = useTranslation("panels");
  return projects.map(({ id, title, depth }) => <option key={id} value={id}>{"  ".repeat(depth)}{t("project.named", { title, id })}</option>);
}
