import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FIELD_LIMITS, isPlaceableField, isSystemField } from "@alpacawork/contract";
import { Button } from "@/components/ui/button";
import { Caret } from "@/components/ui/caret";
import { FieldHint } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { NativeSelect } from "@/components/ui/native-select";
import type { FieldView } from "@/data/fields";
import { cn } from "@/lib/utils";
import { shownField } from "@/domain/field-display";
import { FieldDefEditor } from "./FieldDefEditor";

/** The list clips to its rounded edge, so a keyboard ring is drawn inside what it marks. */
const RING_INSIDE = "focus-visible:-outline-offset-2";
/** A row's move and remove buttons: a step stronger than the lit row they sit on, so the one under the pointer stands out. */
const ROW_ACTION = cn("min-h-7 w-7 hover:bg-line disabled:hover:bg-transparent", RING_INSIDE);

/** A field's kind as the list names it (each a literal key, so the translations are kept by their extraction). */
function KindLabel({ view }: { view: FieldView }) {
  const { t } = useTranslation("panels");
  if (view.type === "text") return view.many ? t("fields.kind.list") : t("fields.kind.text");
  return view.many ? t("fields.kind.schemaList") : t("fields.kind.schema");
}

type Props = {
  /** The fields in the draft, in order. */
  fields: string[];
  /** Whether they are the project's own (false: inherited, as `inherited` names them). */
  own: boolean;
  /** The workspace's definitions (`field list`). */
  views: FieldView[];
  /** Where the fields come from when inherited: a project's title, or null for the app's default. */
  inheritedFrom: string | null;
  /** The fields the project would inherit. */
  inherited: string[] | undefined;
  onChange: (fields: string[], own: boolean) => void;
};

/**
 * The fields a project's Tasks use, in order: move one up or down, take one out (not a system field: the lock says
 * so), add one (an existing definition or a new one), open one to put its shared definition right, or inherit again.
 * Any change makes the list the project's own; it is saved with the project.
 */
export function SchemaFields({ fields, own, views, inheritedFrom, inherited, onChange }: Props) {
  const { t } = useTranslation("panels");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<"closed" | "choose" | "new">("closed");
  const byId = new Map(views.map(view => [view.id, view]));
  const change = (next: string[]) => onChange(next, true);
  /** A field added goes before the notes, the last thing written, where it is read with the others. */
  const add = (id: string) => {
    const notes = fields.indexOf("notes");
    change(notes < 0 ? [...fields, id] : [...fields.slice(0, notes), id, ...fields.slice(notes)]);
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...fields], to = index + by;
    [next[index], next[to]] = [next[to]!, next[index]!];
    change(next);
  };
  const addable = views.filter(view => !fields.includes(view.id) && isPlaceableField(view.id));
  const full = fields.length >= FIELD_LIMITS.fields;
  return <div data-schema-fields>
    <FieldHint className="mt-0 mb-2" data-schema-source>
      {own ? t("fields.own") : inheritedFrom ? t("fields.inheritsFrom", { project: inheritedFrom }) : t("fields.inheritsDefault")}
    </FieldHint>
    <ul className="m-0 list-none overflow-hidden rounded-sm border border-line p-0">
      {fields.map((id, index) => {
        const view = byId.get(id), system = isSystemField(id), expanded = open === id;
        // The whole row lights under the pointer, its buttons too; an opened field is one sunk block, its row and
        // definition together.
        return <li key={id} data-schema-field={id} className={cn("border-b border-line last:border-b-0", expanded && "bg-bg")}>
          <div className="flex items-center gap-1 pr-1.5 hover:bg-hover">
            <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : id)}
              className={cn("flex min-h-control-sm min-w-0 flex-1 cursor-pointer touch-manipulation items-center gap-2 self-stretch rounded-sm py-1 pr-1 pl-3 text-left text-base narrow:min-h-10", RING_INSIDE)}>
              <Caret open={expanded} />
              {/* On a phone the kind goes under the name, so neither is cut short. */}
              <span className="flex min-w-0 flex-1 items-center gap-2 narrow:flex-col narrow:items-start narrow:gap-0">
                <span className="min-w-0 max-w-full flex-auto truncate narrow:flex-none">{view ? shownField(view).title : id}</span>
                <span className="flex max-w-full flex-none items-center gap-2 text-xs text-soft">
                  <span className="min-w-0 truncate">{view && <KindLabel view={view} />}</span>
                  {system && <span className="flex-none" title={t("fields.system")} aria-label={t("fields.system")} data-system-field><Icon name="lock" className="size-3.5" /></span>}
                </span>
              </span>
            </button>
            <span className="flex flex-none gap-0.5">
              <Button type="button" variant="ghost" size="icon" className={ROW_ACTION} aria-label={t("settings.up")} title={t("settings.up")} disabled={index === 0} onClick={() => move(index, -1)}><Icon name="up" className="size-3" /></Button>
              <Button type="button" variant="ghost" size="icon" className={ROW_ACTION} aria-label={t("settings.down")} title={t("settings.down")} disabled={index === fields.length - 1} onClick={() => move(index, 1)}><Icon name="down" className="size-3" /></Button>
              <Button type="button" variant="ghost" size="icon" className={ROW_ACTION} aria-label={t("fields.remove")} title={system ? t("fields.system") : t("fields.removeHint")} disabled={system}
                onClick={() => { change(fields.filter(field => field !== id)); if (expanded) setOpen(null); }}><Icon name="close" className="size-3" /></Button>
            </span>
          </div>
          {expanded && view && <div className="px-3 pt-1 pb-3">
            <FieldDefEditor key={id} view={view} onSaved={() => setOpen(null)} />
          </div>}
        </li>;
      })}
      <li className="px-1" data-schema-add>
        {adding === "closed" && <Button type="button" variant="ghost" disabled={full} onClick={() => setAdding(addable.length ? "choose" : "new")} className={cn("w-full justify-start gap-1.5 text-muted hover:bg-transparent hover:text-ink", RING_INSIDE)}>
          <Icon name="plus" className="size-3.5" />{t("fields.add")}
        </Button>}
        {adding === "choose" && <div className="flex flex-wrap items-center gap-2 py-2">
          <NativeSelect aria-label={t("fields.choose")} defaultValue="" onChange={event => {
            const id = event.target.value;
            if (!id) return;
            if (id === "__new") { setAdding("new"); return; }
            add(id); setAdding("closed");
          }}>
            <option value="" disabled>{t("fields.choose")}</option>
            {addable.map(view => <option key={view.id} value={view.id}>{shownField(view).title}</option>)}
            <option value="__new">{t("fields.createNew")}</option>
          </NativeSelect>
          <Button type="button" variant="quiet" className="min-h-control-xs" onClick={() => setAdding("closed")}>{t("fields.def.cancel")}</Button>
        </div>}
        {adding === "new" && <div className="px-2 py-2">
          <FieldDefEditor view={null} onCancel={() => setAdding("closed")} onSaved={def => { add(def.id); setAdding("closed"); }} />
        </div>}
      </li>
    </ul>
    {own && <div className="mt-2.5 flex flex-wrap gap-2">
      <Button type="button" variant="quiet" className="min-h-control-xs" disabled={!inherited} data-schema-inherit
        onClick={() => { if (inherited) onChange([...inherited], false); setOpen(null); }}>{t("fields.inherit")}</Button>
    </div>}
  </div>;
}
