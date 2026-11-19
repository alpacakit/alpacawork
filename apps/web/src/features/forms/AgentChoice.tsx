import { useState } from "react";
import { NativeSelect } from "@/components/ui/native-select";
import { useWorkspaceInfo } from "@/data/queries";
import { useTranslation } from "react-i18next";
import { FieldError } from "@/components/ui/field";
import { modelLabel } from "@/domain/agent-label";
import { agentOffers } from "./agent-offers";
import { launchSelection, modelCandidates, problemsToSay, selectionReady } from "./launch-selection";
import { useChoiceText } from "./choice-text";

type Values = Record<string, string | null>;
/** A select's value for "none" (a written `-`), and for a value to choose again: never a candidate, which is nonblank and trimmed. */
const UNSPECIFIED = "", UNSETTLED = " ";

/**
 * A new placement's launch: config order is the choice order and each row starts at its first value. Changing a kind
 * starts from that kind's first values; changing a row keeps the others while they are still offered, and only the
 * rows the chosen model makes active have a value (no effort for a fixed model). Kept here, not on this device: the
 * server keeps what the placement starts with.
 */
export function useAgentChoice(initial?: { profile: string; selected: Values }) {
  const offers = agentOffers(useWorkspaceInfo((info) => info.profiles));
  const [profile, setProfile] = useState(initial?.profile ?? offers[0]?.key ?? "");
  const [changes, setChanges] = useState<Values>(initial?.selected ?? {});
  const offer = offers.find(item => item.key === profile);
  const view = offer ? launchSelection(offer.offer, { kind: "new", hints: {} }, changes) : { choices: [], shown: {}, send: {}, problems: [] };
  const chooseProfile = (key: string, overrides: Values = {}) => { setProfile(key); setChanges(overrides); };
  // A change the settings stop offering stays to choose again (launchSelection), even when another row changes.
  const setSelected = (update: Values) => setChanges(before => ({ ...before, ...update }));
  return { profiles: offers, profile, choices: view.choices, selected: view.shown, problems: view.problems, ready: selectionReady(view),
    send: view.send, setSelected, chooseProfile };
}

export function AgentChoiceFields({ choice, disabled = false }: {
  choice: ReturnType<typeof useAgentChoice> & { issues?: { profile?: string } };
  disabled?: boolean;
}) {
  const { t } = useTranslation("forms");
  const text = useChoiceText();
  const offer = choice.profiles.find(item => item.key === choice.profile);
  const models = offer ? modelCandidates(offer.offer) : [];
  return <div className="flex flex-wrap items-end gap-2">
    <label className="flex flex-col gap-1 text-xs text-muted">
      <span>{t("responsibleForm.type")}</span>
      <NativeSelect value={choice.profile} disabled={disabled || !choice.profiles.length} aria-invalid={!!choice.issues?.profile}
        aria-label={t("responsibleForm.type")}
        onChange={event => choice.chooseProfile(event.target.value)} className="text-sm">
        {choice.profiles.map(item => <option key={item.key} value={item.key}>{item.key}</option>)}
      </NativeSelect>
      {choice.issues?.profile && <FieldError className="mt-0">{choice.issues.profile}</FieldError>}
    </label>
    {/* A row with nothing written to choose (an omittable row left empty) is not asked for, unless to choose again. */}
    {choice.choices.filter(({ key, candidates }) => candidates.some(value => value !== null) || !Object.hasOwn(choice.selected, key))
      .map(({ key, candidates }) => <label key={`${choice.profile}:${key}`}
      className="flex flex-col gap-1 text-xs text-muted">
      <span>{text.row(key)}</span>
      <NativeSelect value={!Object.hasOwn(choice.selected, key) ? UNSETTLED : choice.selected[key] ?? UNSPECIFIED} disabled={disabled}
        aria-invalid={!Object.hasOwn(choice.selected, key) || undefined} title={text(choice.selected[key] ?? null)}
        onChange={event => choice.setSelected({ [key]: event.target.value === UNSPECIFIED ? null : event.target.value })} className="text-sm">
        {!Object.hasOwn(choice.selected, key) && <option value={UNSETTLED} disabled>—</option>}
        {candidates.map(value => <option key={value ?? UNSPECIFIED} value={value ?? UNSPECIFIED} title={text(value)} aria-label={text(value)}>
          {key === "model" && value !== null ? modelLabel(value, models).short : text(value)}</option>)}
      </NativeSelect>
    </label>)}
    {/* A new placement has no conversation to end: what it can say is only a value to choose again. */}
    {problemsToSay(choice.problems).map(problem => <FieldError key={problem.key} className="mt-0 w-full">{text.problem(problem)}</FieldError>)}
  </div>;
}
