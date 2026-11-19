import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FieldHint } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Pre } from "@/components/ui/pre";
import { textClip, writeClip } from "@/lib/clipboard";

/** The draft as it would be saved, with a copy button. */
export function YamlTab({ yaml }: { yaml: string }) {
  const { t } = useTranslation("panels");
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <FieldHint>{t("yaml.intro")}</FieldHint>
        <Button variant="outline" onClick={() => void writeClip(textClip(yaml))}>
          <Icon name="copy" />
          {t("yaml.copy")}
        </Button>
      </div>
      <Pre tabIndex={0} aria-label={t("yaml.label")}>
        {yaml}
      </Pre>
      <FieldHint>{t("yaml.note")}</FieldHint>
    </>
  );
}
