import { useState } from "react";
import { useTranslation } from "react-i18next";
import { fieldDefSchema, fieldIdSchema, FIELD_LIMITS, hardLimit, type FieldDef } from "@alpacawork/contract";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldHint } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, errorText } from "@/data/client";
import { focusSoon } from "@/lib/focus-soon";
import { notify } from "@/lib/notify";
import { useSaveField, type FieldView } from "@/data/fields";
import { shownField, shownSizeNote } from "@/domain/field-display";

/** A new field's definition before it is named: one text of about 100 characters (as `field set` makes one). */
const NEW_FIELD: FieldDef = { id: "", title: "", type: "text", many: false, maxChars: 100, maxItems: null, hint: "", members: [], required: false, direction: false };
/** A list's size when one is made a list: 5 items (as `field set` gives one). */
const LIST_ITEMS = 5;

type Kind = "text" | "list" | "schema" | "schemaList";
const kindOf = (def: FieldDef): Kind => def.type === "text" ? (def.many ? "list" : "text") : (def.many ? "schemaList" : "schema");

/**
 * One field's definition to read or put right: its title, kind, limits and how to write it. It is the workspace's,
 * shared by every project that uses it, so it is saved here at once (`field set`), apart from the project's save.
 * A shipped field's definition is the app's: it reads in the reader's language and only `required` changes.
 */
export function FieldDefEditor({ view, onSaved, onCancel }: { view: FieldView | null; onSaved: (def: FieldDef) => void; onCancel?: () => void }) {
  const { t } = useTranslation("panels");
  const save = useSaveField();
  const [draft, setDraft] = useState<FieldDef>(() => {
    if (!view) return NEW_FIELD;
    const shown = shownField(view);
    return { id: shown.id, title: shown.title, type: shown.type, many: shown.many, maxChars: shown.maxChars,
      maxItems: shown.maxItems, hint: shown.hint, members: shown.members, required: shown.required, direction: shown.direction };
  });
  const [problem, setProblem] = useState<string | null>(null);
  /** What is wrong with the ID being created: its letters, or another field already has it (said by the server). */
  const [idProblem, setIdProblem] = useState<string | null>(null);
  const creating = view === null, shipped = !!view?.default;
  const kind = kindOf(draft);
  // The size words writers read (in the reader's language) and the most a write may hold, made from the sizes as the server makes them.
  const note = shownSizeNote(draft);
  const limits = [draft.type === "text" && draft.maxChars !== null ? t("fields.def.limitChars", { count: hardLimit(draft.maxChars) }) : null,
    draft.many && draft.maxItems !== null ? t("fields.def.limitItems", { count: hardLimit(draft.maxItems) }) : null].filter(Boolean).join(t("fields.def.limitJoin"));
  /** The kinds a person chooses: one text or a list of them. A field group (a schema field) is not offered. */
  const setKind = (next: "text" | "list") => {
    const many = next === "list";
    setDraft({ ...draft, type: "text", many, maxChars: draft.maxChars ?? 100, maxItems: many ? draft.maxItems ?? LIST_ITEMS : null, members: [] });
  };
  const idInvalid = creating && !!draft.id && !fieldIdSchema.safeParse(draft.id).success;
  const submit = () => {
    if (idInvalid) { setIdProblem(t("fields.def.idInvalid")); focusSoon(id("id")); return; }
    // A shipped field sends only `required`: its shown texts are translations, neither checked nor sent.
    const checked = shipped ? { success: true as const, data: draft } : fieldDefSchema.safeParse(draft);
    if (!checked.success) { setProblem(t("fields.def.invalid")); return; }
    setProblem(null); setIdProblem(null);
    // Creating only adds: an ID the workspace already has is refused, not changed for every project.
    save.mutate(shipped ? { field: draft.id, required: draft.required } : { field: draft.id, title: draft.title, type: draft.type,
      many: draft.many, maxChars: draft.maxChars, maxItems: draft.maxItems, hint: draft.hint, members: draft.members,
      required: draft.required, ...creating ? { create: true } : {} },
    { onSuccess: () => { notify.success(t("fields.def.savedAll", { title: checked.data.title })); onSaved(checked.data); },
      onError: (error) => {
        if (error instanceof ApiError && error.reason?.kind === "field_exists") { setIdProblem(errorText(error)); focusSoon(id("id")); }
        else setProblem(errorText(error));
      } });
  };
  const id = (name: string) => `field-def-${view?.id ?? "new"}-${name}`;
  return <div data-field-def={view?.id ?? "new"} data-field-shipped={shipped || undefined} className="flex flex-col">
    <FieldHint className="mt-0 mb-2" data-field-shared>
      {!view ? t("fields.def.sharedNew") : shipped ? t("fields.def.shipped") : view.use.projects.length > 1
        ? t("fields.def.sharedBy", { count: view.use.projects.length }) : t("fields.def.shared")}
    </FieldHint>
    <fieldset disabled={save.isPending} className="m-0 min-w-0 border-0 p-0">
      <div className="grid grid-cols-2 gap-x-3 narrow:grid-cols-1">
        <Field label={t("fields.def.title")} htmlFor={id("title")} className="my-2">
          <Input id={id("title")} disabled={shipped} maxLength={FIELD_LIMITS.title} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} />
        </Field>
        {creating ? <Field label={t("fields.def.id")} htmlFor={id("id")} className="my-2" hint={t("fields.def.idHint")}>
          <Input id={id("id")} maxLength={40} value={draft.id} aria-invalid={idInvalid || !!idProblem}
            onChange={event => { setDraft({ ...draft, id: event.target.value }); setIdProblem(null); }} />
          {(idProblem || idInvalid) && <FieldError className="mt-0" data-field-id-problem>{idProblem ?? t("fields.def.idInvalid")}</FieldError>}
        </Field> : <Field label={t("fields.def.id")} htmlFor={id("id")} className="my-2">
          <span id={id("id")} className="py-1.5 font-mono text-sm text-muted">{draft.id}</span>
        </Field>}
        <Field label={t("fields.def.kind")} htmlFor={id("kind")} className="my-2">
          <NativeSelect id={id("kind")} variant="field" value={kind} disabled={shipped} onChange={event => setKind(event.target.value as "text" | "list")}>
            <option value="text">{t("fields.kind.text")}</option>
            <option value="list">{t("fields.kind.list")}</option>
            {/* A field group already made keeps its kind shown; it is not offered for a new choice. */}
            {kind === "schema" && <option value="schema">{t("fields.kind.schema")}</option>}
            {kind === "schemaList" && <option value="schemaList">{t("fields.kind.schemaList")}</option>}
          </NativeSelect>
        </Field>
        <div className="flex gap-3">
          {draft.type === "text" && <Field label={t("fields.def.maxChars")} htmlFor={id("chars")} className="my-2 flex-1">
            <Input id={id("chars")} type="number" disabled={shipped} min={1} max={FIELD_LIMITS.chars} value={draft.maxChars ?? ""}
              onChange={event => setDraft({ ...draft, maxChars: Number(event.target.value) || null })} />
          </Field>}
          {draft.many && <Field label={t("fields.def.maxItems")} htmlFor={id("items")} className="my-2 flex-1">
            <Input id={id("items")} type="number" disabled={shipped} min={1} max={FIELD_LIMITS.items} value={draft.maxItems ?? ""}
              onChange={event => setDraft({ ...draft, maxItems: Number(event.target.value) || null })} />
          </Field>}
        </div>
      </div>
      {note && <FieldHint className="mt-0" data-field-size>{t("fields.def.sizeHelp", { note, limits })}</FieldHint>}
      {draft.type === "schema" && <Field label={t("fields.def.members")} htmlFor={id("members")} className="my-2" hint={t("fields.def.membersHint")}>
        <Input id={id("members")} className="font-mono" value={draft.members.join(", ")} disabled={shipped}
          onChange={event => setDraft({ ...draft, members: event.target.value.split(/[\s,]+/).filter(Boolean) })} />
      </Field>}
      <Field label={t("fields.def.hint")} htmlFor={id("hint")} className="my-2" hint={t("fields.def.hintHelp")}>
        <Textarea id={id("hint")} disabled={shipped} maxLength={FIELD_LIMITS.hint} className="min-h-16" value={draft.hint}
          onChange={event => setDraft({ ...draft, hint: event.target.value })} />
      </Field>
      {/* Whether finishing waits for this field: the server refuses a done report while it is empty. */}
      <div className="my-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={id("required")} className="text-sm font-medium">{t("fields.def.required")}</label>
          <FieldHint className="mt-0.5">{t("fields.def.requiredHelp")}</FieldHint>
        </div>
        <Switch id={id("required")} checked={draft.required} onCheckedChange={required => setDraft({ ...draft, required })} />
      </div>
    </fieldset>
    {problem && <FieldError>{problem}</FieldError>}
    {<div className="mt-2 flex flex-wrap justify-end gap-2">
      {onCancel && <Button type="button" variant="outline" className="min-h-control-xs" onClick={onCancel}>{t("fields.def.cancel")}</Button>}
      <Button type="button" className="min-h-control-xs" disabled={save.isPending || !draft.title.trim() || (creating && !draft.id)} onClick={submit}>
        {creating ? t("fields.def.create") : t("fields.def.save")}
      </Button>
    </div>}
  </div>;
}
