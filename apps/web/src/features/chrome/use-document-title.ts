import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useHomeList } from "@/data/queries";
import { useViewName } from "./ProjectMenu";

/**
 * Keep the project and waiting count visible in tabs, with the product name even outside its own project. The count of
 * Your turn in view is the home list's.
 */
export function useDocumentTitle() {
  const { t } = useTranslation("chrome");
  const name = useViewName();
  const waiting = useHomeList().counts.review;
  const page = name && name !== "alpacawork" ? `${name} · alpacawork` : "alpacawork";
  const counts = [waiting ? t("documentTitle.waiting", { count: waiting }) : ""]
    .filter(Boolean)
    .join(t("documentTitle.separator"));
  const title = counts ? t("documentTitle.withCounts", { counts, page }) : page;

  useEffect(() => {
    document.title = title;
  }, [title]);
}
