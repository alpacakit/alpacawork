import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Label } from "./label";

/**
 * A form field: a label over a control, with an optional hint below.
 * The control is the child (Input, Textarea, NativeSelect); give it the same
 * `id` as `htmlFor`; the hint's id is `<htmlFor>-hint`. Errors use `FieldError`.
 * An `optional` field says so after its label.
 */
function Field({
  label,
  htmlFor,
  hint,
  optional = false,
  className,
  children,
}: {
  label: React.ReactNode;
  htmlFor: string;
  hint?: React.ReactNode;
  optional?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("ui");
  return (
    <div data-slot="field" className={cn("my-4 flex flex-col gap-1.5", className)}>
      <Label id={`${htmlFor}-label`} htmlFor={htmlFor}>
        {label}
        {optional && <span className="ml-1.5 font-normal text-soft">{t("field.optional")}</span>}
      </Label>
      {children}
      {hint ? <FieldHint id={`${htmlFor}-hint`}>{hint}</FieldHint> : null}
    </div>
  );
}

/** A group of choices (radios) under one label, worded like Field: the legend is a Label. */
function FieldSet({
  legend,
  hint,
  className,
  children,
}: {
  legend: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset data-slot="fieldset" className={cn("my-4 flex flex-col gap-1.5 border-0 p-0", className)}>
      <Label asChild><legend className="mb-1.5 p-0">{legend}</legend></Label>
      {children}
      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </fieldset>
  );
}

function FieldHint({ className, ...props }: React.ComponentProps<"p">) {
  // Japanese wraps between phrases, not inside a word.
  return <p data-slot="field-hint" className={cn("text-sm text-muted [word-break:auto-phrase]", className)} {...props} />;
}

/** A form's error: shown under the form, announced when it changes. A block, so it may hold a list. */
function FieldError({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div role="alert" data-slot="field-error" className={cn("mt-type-close text-sm text-warn", className)} {...props} />
  );
}

export { Field, FieldError, FieldHint, FieldSet };
