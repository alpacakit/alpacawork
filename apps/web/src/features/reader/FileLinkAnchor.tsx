import { useTranslation } from "react-i18next";
import type { FileLink } from "@/data/task-file-url";

/** A link to a file itself, named for what following it does: open it in a new tab, or save its original. */
export function FileLinkAnchor({ link, className }: { link: FileLink; className?: string }) {
  const { t } = useTranslation("reader");
  return link.saves
    ? <a href={link.href} download className={className}>{t("image.saveFile")}</a>
    : <a href={link.href} target="_blank" rel="noopener noreferrer" className={className}>{t("image.openFile")}</a>;
}
