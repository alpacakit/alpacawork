import { useCheckShownHere } from "@/data/write-intent";
import { useRef, type ReactNode } from "react";
import { useFormState, type FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeading,
} from "@/components/ui/dialog";
import { useWriteDisabled } from "@/data/queries";
import { useDialogStore } from "@/state/dialog-store";
import { FormError, SubmitButton, type ServerForm } from "./server-form";

/**
 * The frame of every modal form (Stop or close of a run, Create project): the dialog with its title and
 * description, the `<form>` with its fields, the one error line (`#form-error`)
 * and the footer (Cancel and the submit button). The first field takes the
 * focus; while the form is sent its fields hold still; saving while updates are
 * stopped is refused here first.
 */
export function FormDialog<T extends FieldValues>({
  title,
  description,
  submitLabel,
  pendingLabel,
  form,
  onReread,
  checkRequired,
  checkMessage,
  checking,
  fieldsDisabled = false,
  rereadLabel,
  disabled = false,
  className,
  children,
}: {
  title: string;
  description: string;
  submitLabel: string;
  /** The submit button's words while the form is sent; Saving… when left out. */
  pendingLabel?: string;
  form: ServerForm<T>;
  onReread?: () => Promise<void>;
  checkRequired?: boolean;
  checkMessage?: string;
  /** The write whose check this dialog shows while checkRequired: its toast waits while the dialog shows it. */
  checking?: string;
  fieldsDisabled?: boolean;
  rereadLabel?: string;
  disabled?: boolean;
  /** The dialog box's own classes (where it sits). */
  className?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation("forms");
  useCheckShownHere(checking, !!checkRequired);
  const close = useDialogStore((state) => state.close);
  const formRef = useRef<HTMLFormElement>(null);
  const writeDisabled = useWriteDisabled();
  const { isSubmitting } = useFormState({ control: form.control });

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className={className}
        onOpenAutoFocus={(event) => {
          // The first field takes the focus, with the caret at the start. With
          // no field (a confirmation), nothing takes focus and the title keeps it.
          const first = formRef.current?.querySelector("input, textarea, select");
          if (first instanceof HTMLInputElement && first.type === "hidden") return;
          if (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) first.setSelectionRange(0, 0);
          if (!(first instanceof HTMLElement)) return;
          event.preventDefault();
          first.focus();
        }}
      >
        <DialogHeading title={title} description={description} />
        <DialogBody>
          <form ref={formRef} onSubmit={event => { event.preventDefault(); if (!writeDisabled && !disabled) void form.save(); }}>
            {children && <fieldset disabled={isSubmitting || fieldsDisabled} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0 [&>[data-slot=field]]:m-0">{children}</fieldset>}
            <FormError form={form} onReread={onReread} checkRequired={checkRequired} checkMessage={checkMessage} rereadLabel={rereadLabel} />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t("formDialog.cancel")}
                </Button>
              </DialogClose>
              <SubmitButton form={form} label={submitLabel} pendingLabel={pendingLabel} disabled={disabled || writeDisabled} />
            </DialogFooter>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
