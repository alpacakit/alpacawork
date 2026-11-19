import { isDefaultField, renderContext, type FieldCatalog, type FieldDef, type TaskValues } from "@alpacawork/contract";
import { i18n } from "@alpacawork/i18n";

/**
 * How the screen shows a field's title and how-to-write text. A shipped field's texts are the app's (contract
 * DEFAULT_FIELDS, never changed by a workspace): agents read them in English (field get, launches, the server's
 * context) and the screen shows them in the reader's language. A field the workspace added shows as written.
 */
export function shownField<Def extends FieldDef>(def: Def): Def {
  if (!isDefaultField(def.id)) return def;
  return { ...def, title: i18n.t(`ui:defaultField.${def.id}.title`), hint: def.hint && i18n.t(`ui:defaultField.${def.id}.hint`) };
}

/** A catalog with every field as the screen shows it: what the screen renders values under, never what it checks with. */
export function shownCatalog(catalog: FieldCatalog): FieldCatalog {
  return new Map([...catalog].map(([id, def]) => [id, shownField(def)]));
}

/**
 * The size words in the reader's language, as contract sizeNote makes them for agents (`About 60 characters.`,
 * `About 60 characters each, up to 5 items.`, `Up to 5 items.`): the screen says what agents are told in the reader's language.
 */
export function shownSizeNote(def: FieldDef): string {
  const chars = def.type === "text" ? def.maxChars : null;
  if (!def.many || def.maxItems === null) return chars === null ? "" : i18n.t("ui:defaultField.size.text", { count: chars });
  return chars === null ? i18n.t("ui:defaultField.size.list", { count: def.maxItems })
    : i18n.t("ui:defaultField.size.textList", { chars, count: def.maxItems });
}

/**
 * A Task's values as the context tab shows them: the server's text (what launches carry) rebuilt with the titles as
 * the screen shows them. Until the workspace's definitions are read (null), or when they lack a field the values use,
 * the server's text stands as it is.
 */
export function shownContext(values: { values: Record<string, unknown>; fields: readonly string[]; context: string },
  catalog: FieldCatalog | null): string {
  if (!catalog || values.fields.some(id => values.values[id] !== undefined && !catalog.has(id))) return values.context;
  try { return renderContext(values.fields, values.values as TaskValues, shownCatalog(catalog)); }
  catch { return values.context; }
}
