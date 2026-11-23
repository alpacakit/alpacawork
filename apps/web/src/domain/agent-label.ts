import type { ControlRunDTO, PlacementDTO } from "@alpacawork/contract/control";
import { i18n } from "@alpacawork/i18n";
import type { PeopleIndex } from "./people";

/** A model ID, or its rendered agent text with the original model ID kept alongside it. */
export type ModelName = string | { model: string; full: string };
export type ModelLabel = { short: string; full: string; collision: boolean; name: string; suffix: string };

/** Resolve collisions in the actual displayed names, then retain effort as a separate, non-shrinking suffix. */
export function modelLabel(full: string, peers: readonly ModelName[] = []): ModelLabel {
  const split = (name: string) => {
    const slash = name.indexOf("/");
    return slash < 0 || slash === name.length - 1 ? { provider: "", model: name } : { provider: name.slice(0, slash), model: name.slice(slash + 1) };
  };
  const original = peers.find((name): name is Exclude<ModelName, string> => typeof name !== "string" && name.full === full)?.model ?? full;
  const suffix = full.slice(original.length);
  const models = new Set<string>();
  models.add(original);
  for (const name of peers) models.add(typeof name === "string" ? name : name.model);
  const names = Array.from(models, full => {
    const parts = split(full);
    return { full, ...parts, shown: parts.model, collision: false };
  });
  const collisions = () => {
    const groups = new Map<string, typeof names>();
    for (const name of names) {
      const group = groups.get(name.shown);
      if (group) group.push(name); else groups.set(name.shown, [name]);
    }
    return [...groups.values()].filter(group => group.length > 1);
  };
  const providerText = (provider: string, others: readonly string[]) => {
    if (provider.length <= 8) return provider;
    let length = 4;
    while (length < provider.length && others.some(other => other !== provider && other.startsWith(provider.slice(0, length)))) length++;
    const short = provider.slice(0, length) + (length < provider.length ? "…" : "");
    return provider.length - short.length >= 3 ? short : provider;
  };
  for (const group of collisions()) {
    const providers = group.map(name => name.provider);
    for (const name of group) {
      name.collision = true;
      if (name.provider) name.shown = `${providerText(name.provider, providers)}/${name.model}`;
    }
  }
  // Restoring a provider may collide with a nested name. Full names are unique, so each round makes progress.
  for (let groups = collisions(); groups.length; groups = collisions()) for (const group of groups) for (const name of group) {
    name.collision = true;
    name.shown = name.full;
  }
  const resolved = names.find(name => name.full === original)!;
  return { short: resolved.shown + suffix, full, collision: resolved.collision, name: resolved.shown, suffix };
}

/** Agent text has one owner. A placement without a Run has no committed launch choices. */
export function agentLabel(model: string | null | undefined, effort: string | null | undefined,
  fallback: string, started = true): string {
  if (!started) return `${fallback}(${i18n.t("people:agentLabel.unstarted")})`;
  return `${model || fallback}(${effort || i18n.t("people:agentLabel.unknown")})`;
}

/** Retain model identity beside the rendered text; no caller has to parse an effort suffix back out. */
export function agentModelName(model: string | null | undefined, effort: string | null | undefined,
  fallback: string, started = true): Exclude<ModelName, string> {
  return { model: started ? model || fallback : fallback, full: agentLabel(model, effort, fallback, started) };
}

/** Keep metadata only for names actually drawn; a server index supplies identity, never the display scope. */
export function visibleAgentNames(fullNames: readonly string[], known: readonly ModelName[]): ModelName[] {
  const byFull = new Map<string, ModelName>();
  for (const name of known) byFull.set(typeof name === "string" ? name : name.full, name);
  return [...new Set(fullNames)].map(full => byFull.get(full) ?? full);
}

export const runAgentLabel = (run: Pick<ControlRunDTO, "agent" | "modelId" | "effort">): string =>
  agentLabel(run.modelId, run.effort, run.agent);

export function placementAgentLabel(placement: PlacementDTO, people: PeopleIndex): string {
  const latest = people.runsByPlacement.get(placement.id)?.at(-1);
  return latest ? runAgentLabel(latest) : agentLabel(null, null, placement.profileKey, false);
}

/** Identity metadata from the index. Callers select visible names before deciding any collision. */
const namesByPeople = new WeakMap<object, { language: string | undefined; names: Exclude<ModelName, string>[] }>();
export function peopleAgentNames(people: Pick<PeopleIndex, "placements" | "runsByPlacement">): readonly Exclude<ModelName, string>[] {
  const known = namesByPeople.get(people), language = i18n.resolvedLanguage;
  if (known && known.language === language) return known.names;
  const byFull = new Map<string, Exclude<ModelName, string>>();
  for (const runs of people.runsByPlacement.values()) for (const run of runs) {
    const name = agentModelName(run.modelId, run.effort, run.agent);
    byFull.set(name.full, name);
  }
  for (const placement of people.placements.values()) {
    if (people.runsByPlacement.get(placement.id)?.length) continue;
    const unstarted = agentModelName(null, null, placement.profileKey, false);
    const unknown = agentModelName(null, null, placement.profileKey);
    byFull.set(unstarted.full, unstarted);
    byFull.set(unknown.full, unknown);
  }
  const names = [...byFull.values()];
  namesByPeople.set(people, { language, names });
  return names;
}

/** A newly colliding provider must also redraw a memoized feed whose own Runs did not change. */
export function samePeopleAgentNames(a: PeopleIndex, b: PeopleIndex): boolean {
  if (a === b) return true;
  const left = peopleAgentNames(a), right = peopleAgentNames(b);
  return left.length === right.length && left.every((name, at) => name.full === right[at]!.full && name.model === right[at]!.model);
}

/** Only selectable labels that would look identical get a shortest unique placement suffix. */
export function selectionAgentLabels(placements: readonly PlacementDTO[], people: PeopleIndex,
  detail: (placement: PlacementDTO) => string = () => ""): ReadonlyMap<string, ModelLabel> {
  const peers = visibleAgentNames(placements.map(placement => placementAgentLabel(placement, people)), peopleAgentNames(people));
  const labels = placements.map((placement) => {
    const agent = modelLabel(placementAgentLabel(placement, people), peers);
    const tail = detail(placement);
    return { placement, agent, tail, text: `${agent.short}${tail}` };
  });
  const byText = new Map<string, string[]>();
  for (const { placement, text } of labels) {
    const ids = byText.get(text);
    if (ids) ids.push(placement.id); else byText.set(text, [placement.id]);
  }
  return new Map(labels.map(({ placement, agent, tail, text }) => {
    const ids = byText.get(text)!;
    const withoutPrefix = (id: string) => id.startsWith("P") ? id.slice(1) : id;
    const id = withoutPrefix(placement.id);
    let prefix = "";
    if (ids.length > 1) {
      let length = Math.min(4, id.length);
      while (ids.some((other) => other !== placement.id && withoutPrefix(other).slice(0, length) === id.slice(0, length))) length++;
      prefix = `#${id.slice(0, length)} · `;
    }
    return [placement.id, { ...agent, name: prefix + agent.name, suffix: agent.suffix + tail,
      short: prefix + text, full: prefix + agent.full + tail }];
  }));
}

/**
 * What a launch's values are called: the model and its effort, or the agent's name where it has no model. An effort
 * left out (`-`) is not asked for, so it is left out with its brackets, never said "unknown" as a Run record says of an
 * effort nobody knows.
 */
export function launchName(agent: string, values: Readonly<Record<string, string | null>>): Exclude<ModelName, string> {
  const model = values.model ?? agent;
  return values.effort == null ? { model, full: model } : agentModelName(values.model, values.effort, agent);
}
