import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";

/** A settings save whose answer was lost: it is not known what it came to until the latest is read. */
export function SaveUnconfirmed({ onReread, unproven = false }: { onReread: () => void; unproven?: boolean }) {
  const { t } = useTranslation("panels");
  return <FieldError className="flex items-center gap-3">
    <span>{t(unproven ? "forms:writeFailure.unproven" : "forms:writeFailure.unconfirmed")}</span>
    {!unproven && <Button variant="outline" onClick={onReread}>{t("settings.server.reload")}</Button>}
  </FieldError>;
}
