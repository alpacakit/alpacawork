import { useContext, useEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isComposingKey, isComposingTarget } from "@/components/ui/composing";
import { FieldError } from "@/components/ui/field";
import { useWriteDisabled } from "@/data/queries";
import { continuesInputSession } from "@/state/open-input";
import { OpeningForm, focusOpeningForm, useOpeningFocus } from "@/lib/opening-focus";
import { cn } from "@/lib/utils";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";

/** The ground of a form that stands as a section under the reader's head (who is responsible, the parent). */
export const INPUT_SECTION = "mx-5 mt-2 flex-none rounded-sm border border-line bg-bg p-2.5 narrow:mx-4";

type Recovery = { readOnly: boolean; discard: () => boolean; rebase?: (() => boolean | Promise<boolean>) | undefined; status: string };
/** Shared editing surface and actions. Enter alone never submits; ⌘/Ctrl+Enter does. */
export function InlineForm({
  submitLabel, error, pending, disabled = false, note, onSubmit, onCancel, onOutside = onCancel,
  className, children, recovery,
}: {
  submitLabel: string; error: string | undefined; pending: boolean; disabled?: boolean;
  note?: ReactNode; onSubmit: () => void; onCancel?: () => void; onOutside?: () => void;
  className?: string; children: ReactNode; recovery?: Recovery;
}) {
  const { t } = useTranslation("forms");
  const writeDisabled = useWriteDisabled();
  const localForm = useRef<HTMLFormElement>(null);
  const readerForm = useContext(OpeningForm);
  const formRef = readerForm ?? localForm;
  useEscapeLayer(!!onCancel, ESCAPE_LAYER.input, () => onCancel?.());
  useOpeningFocus(readerForm ? null : true, () => () => ({ complete: !!formRef.current, focus: () => { focusOpeningForm(formRef.current); } }));
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && continuesInputSession(event.target)) return;
      // The popover or sheet it stands in is its own: a press on its edges (or on a grown popover's guard) is not outside.
      const surface = formRef.current?.closest("[data-slot=popover-content], [data-slot=sheet]") ?? formRef.current;
      if (event.target instanceof Node && !surface?.contains(event.target)) onOutside?.();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onOutside]);
  // Closing keeps what was typed only where a draft holds it.
  const cancelLabel = recovery ? t("draft.closeKeep") : t("inlineForm.cancel");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isComposingTarget(document.activeElement) || writeDisabled || disabled || pending) return;
    onSubmit();
  };
  const keys = (event: KeyboardEvent<HTMLFormElement>) => {
    if (isComposingKey(event)) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); formRef.current?.requestSubmit(); }
  };
  return (
    <form ref={formRef} data-inline-form data-edit-surface aria-busy={pending || undefined}
      onSubmit={submit} onKeyDown={keys} className={cn("relative rounded-md bg-raised text-base", className)}>
      {children}
      {error && <FieldError>{error}</FieldError>}
      {recovery?.rebase && <Button type="button" variant="ghost" className="min-h-control-xs" onClick={() => { void recovery.rebase?.(); }}>{t("draft.reviewLatest")}</Button>}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2" data-draft-actions>
        {note && <span className="mr-auto text-xs text-muted [overflow-wrap:anywhere]">{note}</span>}
        {pending && <span role="status" className="mr-auto text-xs text-muted">{t("draft.saving")}</span>}
        {recovery && !recovery.readOnly && <Button type="button" variant="ghost" className="mr-auto min-h-control-xs"
          onClick={() => { if (window.confirm(t("draft.discardConfirm")) && recovery.discard()) onCancel?.(); }}>{t("draft.discard")}</Button>}
        {onCancel && <Button type="button" variant="ghost" className="min-h-control-xs" onClick={onCancel}
          aria-label={cancelLabel} title={cancelLabel}>
          {cancelLabel}
        </Button>}
        <Button type="submit" className="min-h-control-xs" disabled={pending || disabled || writeDisabled}
          aria-label={submitLabel} title={submitLabel}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
