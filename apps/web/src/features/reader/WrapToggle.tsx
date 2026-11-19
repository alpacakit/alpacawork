import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/**
 * The wrap mark: fold a block's long lines at its edge or keep them whole. Its look is the copy mark's (CopyButton, the
 * quiet icon button), pressed or not, and so is its size: the place it stands passes that (`className`), as it does a
 * copy mark's. Its name and tip say what a press does next; whether the lines are folded is its pressed state and its
 * glyph (the lines folded, or run on past the edge), as the copy mark says it copied by its glyph alone. The block it
 * folds owns the state.
 */
export function WrapToggle({ wrapped, onWrap, className }: { wrapped: boolean; onWrap: (wrapped: boolean) => void; className?: string }) {
  const { t } = useTranslation("reader");
  const next = wrapped ? t("wrapToggle.unwrap") : t("wrapToggle.wrap");
  return <Button variant="quiet" size="icon" aria-pressed={wrapped} aria-label={next} title={next} onClick={() => onWrap(!wrapped)} className={className}>
    <Icon name={wrapped ? "wrap" : "unwrap"} className="size-3.5" />
  </Button>;
}
