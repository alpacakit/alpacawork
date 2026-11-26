import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm, useFormState, type ControllerRenderProps, type DefaultValues, type FieldErrors,
  type FieldPath, type FieldValues, type Resolver, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";
import { toIssues } from "@alpacawork/contract/problem";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { ApiError, retryOf } from "@/data/client";
import { notify, recordFailure } from "@/lib/notify";
import { describeProblem, isAppFailure, issueText } from "./problem-text";
import { useReloadHolds } from "@/features/update/update-state";

export type ServerForm<T extends FieldValues> = UseFormReturn<T> & {
  save: () => Promise<boolean>;
  blocked: boolean;
  clearFailure: () => void;
  retainCheckFailure: (error: unknown) => boolean;
};

export function useServerForm<T extends FieldValues>({ schema, defaultValues, submit, onInvalid, rereadBlocks = true, fieldPaths, issueField }: {
  schema: z.ZodType<T, T>;
  defaultValues?: DefaultValues<T>;
  submit: (values: T) => Promise<unknown>;
  onInvalid?: (errors: FieldErrors<T>) => void;
  /** A change made elsewhere stops this form until it reads the latest; false for a form with no such read to lift the stop. */
  rereadBlocks?: boolean;
  fieldPaths?: readonly string[];
  /** The field a path serve names stands for, when the form draws it under another name or shape; none: said by the form. */
  issueField?: (path: string) => FieldPath<T> | undefined;
}): ServerForm<T> {
  const baseResolver = zodResolver(schema) as Resolver<T>;
  const resolver: Resolver<T> = async (values, context, options) => {
    const result = await baseResolver(values, context, options);
    const parsed = schema.safeParse(values);
    if (!parsed.success) for (const issue of toIssues(parsed.error.issues)) {
      const parts = issue.path.split(".");
      let field: unknown = result.errors;
      for (const part of parts) field = field && typeof field === "object" ? (field as Record<string, unknown>)[part] : undefined;
      if (field && typeof field === "object" && "message" in field)
        (field as { message: string }).message = issueText(issue);
    }
    return result;
  };
  const form = useForm<T>({ resolver, defaultValues,
    mode: "onSubmit", reValidateMode: "onChange" });
  // What is typed and not saved lives only in this page: it holds the page from loading a new version by itself.
  const holdKey = useId(), hold = useReloadHolds((state) => state.hold);
  const { isDirty } = useFormState({ control: form.control });
  useEffect(() => { hold(holdKey, isDirty); return () => hold(holdKey, false); }, [isDirty]);
  const [blocked, setBlocked] = useState(false);
  const blockedRef = useRef(false);
  const save = async () => {
    if (blockedRef.current || form.formState.isSubmitting) return false;
    let success = false;
    // The fields hold still while the form is sent (FormDialog), which takes the focus from them: a refused form gives
    // it back to the first field the server named, else to where it was.
    const focused = document.activeElement;
    let named: FieldPath<T> | undefined;
    await form.handleSubmit(async values => {
      form.clearErrors("root.server");
      try {
        success = await submit(values) !== false;
      } catch (error) {
        // The form says what is about what was written, where it is put right: a field, serve's refusal of it, a change
        // made elsewhere to read, a result to check. What is not (no answer to try again later, a fault in this screen)
        // is the app's, said as a toast like any other.
        if (isAppFailure(error)) { notify.failure(error, { about: "form save" }); return; }
        recordFailure(error, "form save");
        const retry = retryOf(error);
        if (retry === "check" || (retry === "reread" && rereadBlocks)) {
          blockedRef.current = true;
          setBlocked(true);
        }
        const unmatched: string[] = [];
        if (error instanceof ApiError) for (const issue of error.issues) {
          if (issueField) {
            const field = issueField(issue.path);
            if (field) { form.setError(field, { type: "server", message: issueText(issue) }); named ??= field; }
            else unmatched.push(issueText(issue));
            continue;
          }
          const path = issue.path as FieldPath<T>;
          const fieldValue = path ? form.getValues(path) : undefined;
          if (path && (fieldPaths === undefined || fieldPaths.includes(path))
            && fieldValue !== undefined && (fieldValue === null || typeof fieldValue !== "object"))
          { form.setError(path, { type: "server", message: issueText(issue) }); named ??= path; }
          else unmatched.push(issueText(issue));
        }
        if (unmatched.length || !error || !(error instanceof ApiError) || !error.issues.length || retry !== "fix") {
          const { title, detail } = describeProblem(error);
          form.setError("root.server", { type: "server", message: [title, ...unmatched, detail].filter(Boolean).join(" ") });
        }
      }
    }, onInvalid)();
    if (!success && (named || focused instanceof HTMLElement)) requestAnimationFrame(() => {
      if (named) form.setFocus(named);
      else if (focused instanceof HTMLElement && focused.isConnected && document.activeElement === document.body) focused.focus();
    });
    return success;
  };
  // An unknown check still waits. A restore refusal is a result to retain and explain, not a successful read
  // that can reset its operation or draft. Unlike uncertainty, that refusal allows a distinct explicit save.
  const retainCheckFailure = (error: unknown) => {
    if (retryOf(error) === "check") return true;
    if (!(error instanceof ApiError) || error.code !== "restore_changed") return false;
    blockedRef.current = false; setBlocked(false);
    const { title, detail } = describeProblem(error);
    form.setError("root.server", { type: "server", message: [title, detail].filter(Boolean).join(" ") });
    return true;
  };
  return { ...form, save, blocked, retainCheckFailure, clearFailure: () => { blockedRef.current = false; setBlocked(false); form.clearErrors("root.server"); } };
}

export function FormField<T extends FieldValues, N extends FieldPath<T> = FieldPath<T>>({ form, name, label, hint, optional, id, children, className }: {
  form: UseFormReturn<T>; name: N; label: ReactNode; hint?: ReactNode; optional?: boolean; id: string;
  className?: string;
  children: (field: ControllerRenderProps<T, N> & { "aria-invalid"?: true; "aria-describedby"?: string; id: string }) => ReactNode;
}) {
  return <Controller control={form.control} name={name} render={({ field, fieldState }) => {
    const message = fieldState.error?.message;
    // The error takes the hint's place (so the form does not grow on a mistake) and is what the control is read with.
    const describedBy = message ? `${id}-error` : hint ? `${id}-hint` : undefined;
    return <Field label={label} hint={message ? undefined : hint} optional={optional} htmlFor={id} className={className}>
      {children({ ...field, id, "aria-invalid": fieldState.invalid || undefined, "aria-describedby": describedBy })}
      {message && <FieldError id={`${id}-error`} className="mt-0">{message}</FieldError>}
    </Field>;
  }} />;
}

/** `disabled`: reading the latest can't start now (the form's owner already awaits an answer). */
export function FormError<T extends FieldValues>({ form, onReread, rereadLabel, checkRequired = false, checkMessage, disabled = false }: {
  form: ServerForm<T>; onReread?: () => Promise<void>; rereadLabel?: string; checkRequired?: boolean; checkMessage?: string; disabled?: boolean;
}) {
  const { t } = useTranslation("forms");
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  const { errors } = useFormState({ control: form.control });
  const message = checkRequired && checkMessage ? checkMessage : errors.root?.server?.message ?? (checkRequired ? t("writeFailure.unconfirmed") : undefined);
  if (!message) return null;
  return <FieldError className="flex flex-wrap items-center gap-3">
    <span>{message}</span>
    {(form.blocked || checkRequired) && onReread && <Button type="button" variant="outline" disabled={reading || disabled} onClick={() => {
      setReading(true);
      setReadError("");
      void onReread().catch(error => {
        if (isAppFailure(error)) { notify.failure(error, { about: "form read latest" }); return; }
        recordFailure(error, "form read latest");
        const { title, detail } = describeProblem(error);
        setReadError([title, detail].filter(Boolean).join(" "));
      }).finally(() => setReading(false));
    }}>{rereadLabel ?? t("writeFailure.readLatest")}</Button>}
    {readError && <span>{readError}</span>}
  </FieldError>;
}

export function SubmitButton<T extends FieldValues>({ form, label, pendingLabel, disabled, className, onClick, allowBlocked = false }: {
  form: ServerForm<T>; label: string; pendingLabel?: string; disabled?: boolean; className?: string; onClick?: () => void; allowBlocked?: boolean;
}) {
  const { t } = useTranslation("forms");
  const { isSubmitting } = useFormState({ control: form.control });
  return <Button type={onClick ? "button" : "submit"} onClick={onClick} className={className} disabled={disabled || isSubmitting || form.blocked && !allowBlocked}>
    {isSubmitting ? pendingLabel ?? t("draft.saving") : label}
  </Button>;
}
