/* Hallmark · component: agent picker · genre: modern-minimal (utilitarian) · theme: the app's tokens
 * states: default · hover · focus · active · disabled · open · selected
 */
import { countUse } from '@/features/telemetry/count';
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { isComposingKey } from "@/components/ui/composing";
import { Icon } from "@/components/ui/icon";
import { MENU_GROUP, MenuTick, menuRow } from "@/components/ui/menu-rows";
import { agentModelChoices, agentModelName, kindToName, listedLabel } from "@/domain/agent-label";
import { AgentLabel } from "@/features/people/AgentLabel";
import { Popup } from "@/components/ui/popup";
import { FieldError } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { offeredChoices } from "@alpacawork/contract/agent-selection";
import type { LaunchChoice } from "./launch-choice";
import { useChoiceText } from "./choice-text";
import { modelCandidates, problemsToSay } from "./launch-selection";
import { stepColumns, stepOrder } from "./launch-steps";

type Choice = LaunchChoice;

/**
 * The picker's heading names what this launch asks for. A value left out (`-`) is not asked for, so it is left out
 * with its brackets, never said "unknown" as a Run record says of an effort nobody knows.
 */
export function chosenName(selected: Choice["selected"], profile: string) {
  return selected.effort == null ? { model: selected.model ?? profile, full: selected.model ?? profile }
    : agentModelName(selected.model, selected.effort, profile);
}

/**
 * What a send starts with, as one chip in every prompt input's send row: the agent a first send places, or the model
 * and effort of the agent an input goes to. The person thinks "which agent", not "which kind, then which model", so
 * the popover lists every kind × model it offers as one choice, grouped by kind. The other launch choices the chosen
 * kind and model offer (effort, tier…) are below, already filled: most sends never open it.
 */
/** `className`: the place's own look for the trigger (the coordinator's input draws it as one of its quiet tools).
 * `open`/`onOpenChange`: given by a sender that opens it when a send cannot go yet (selectionReady). */
export function AgentPicker({ choice, disabled = false, className, open: shown, onOpenChange }: { choice: Choice; disabled?: boolean;
  className?: string; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const { t } = useTranslation("forms");
  const text = useChoiceText();
  const [own, setOwn] = useState(false);
  const open = shown ?? own, setOpen = onOpenChange ?? setOwn;
  const problems = problemsToSay(choice.problems);
  const options = agentModelChoices(choice.profiles.map(profile => ({ key: profile.key, models: modelCandidates(profile.offer) })));
  const selected = listedLabel(options, choice.profile, chosenName(choice.selected, choice.profile));
  const kind = kindToName(options, choice.profile, choice.selected.model);
  const named = kind ? `${kind} ${selected.full}` : selected.full;
  const trigger = useRef<HTMLButtonElement>(null);
  // A press on the open menu's own button closes it as a press outside (the popover's), so the click that ends that
  // press must not open it again: it goes by how the menu stood when the press began. A click without a press (the
  // keys, a reader) goes by how it stands.
  const pressedOpen = useRef<boolean | null>(null);
  return <Popup open={open} onOpenChange={setOpen} label={t("agentPicker.pickerTitle")} align="end" anchorRef={trigger} className="w-88"
    anchor={<div className="inline-flex min-w-0 max-w-full flex-col">
      <button ref={trigger} type="button" data-agent-picker disabled={disabled} aria-invalid={!choice.ready || undefined}
        aria-haspopup="dialog" aria-expanded={open} data-state={open ? "open" : "closed"}
        title={named} aria-label={t("agentPicker.pickerLabel", { agent: named })}
        onPointerDown={() => { pressedOpen.current = open; }}
        onClick={() => { setOpen(!(pressedOpen.current ?? open)); pressedOpen.current = null; }}
        className={cn("inline-flex self-start min-h-control-xs min-w-0 max-w-full cursor-pointer items-center gap-1.5 narrow:gap-1 rounded-sm border border-line bg-lit px-2 text-sm text-ink hover:bg-hover active:bg-line disabled:cursor-default disabled:opacity-38 data-[state=open]:border-muted aria-invalid:border-warn", className)}>
        <Icon name="agent" className="size-3.5 flex-none text-muted" />
        {/* A computer has the width for the kind and the name on one line, the kind giving way first. A phone's button
            has the height instead: what does not fit goes on a second line rather than be cut to its start (the kind
            whole, never broken). */}
        <span className="flex min-w-0 items-baseline gap-1 narrow:line-clamp-2 narrow:text-left narrow:whitespace-normal narrow:[overflow-wrap:anywhere]">
          {kind && <span data-agent-kind aria-hidden="true" className="max-w-full min-w-0 shrink-[99] truncate after:ms-1 after:content-['·'] narrow:inline-block narrow:align-bottom narrow:after:me-1">{kind}</span>}
          <AgentLabel label={selected} className="narrow:inline narrow:[&>*]:inline narrow:[&>[data-agent-name]]:whitespace-normal" />
        </span>
        <Icon name="down" className="size-3 flex-none text-muted" />
      </button>
      {/* Closed, the first thing to settle stays said under it; open, the list's foot says them all. */}
      {!open && choice.gone && <FieldError data-selection-problem className="mt-0 truncate text-xs" title={text.gone(choice.gone)}>{text.brief.gone()}</FieldError>}
      {!open && !choice.gone && problems.length > 0 && <FieldError data-selection-problem className="mt-0 truncate text-xs" title={text.problem(problems[0]!)}>{text.brief(problems[0]!)}</FieldError>}
    </div>}>
    {open && <AgentMenu choice={choice} disabled={disabled} options={options} close={() => setOpen(false)} />}
  </Popup>;
}

/** The least room the list keeps, however low the window: a kind's name and a model and a half under it (px), or all
 * it holds when that is less. What then does not fit is reached by scrolling the surface. */
const LIST_FLOOR = 76;
const NONE: ReadonlySet<string> = new Set();
/** How much of the list's foot fades out while it goes on below (px): less when less is left. */
const FADE = 40;

/** The surface's own room round what it holds (the popover's p-3, the sheet's p-4): a part that reaches its edges. */
const TO_EDGES = "-mx-3 in-data-[slot=sheet]:-mx-4";

/**
 * The open picker, on the state card's frame (rows, a rule, a named group): the models scroll, what goes with the chosen
 * one stays at the foot. The list is at most half a screen and each kind's name stays at its head while its models pass,
 * so rows met mid-list still say whose they are; a rule under that name says rows went under it, and a list that goes
 * on below fades out at its foot (less of it as less is left). The menu keeps the height it opened with (the list gives way to a low window first):
 * a kind with more rows at the foot takes their room from the list, so no row moves from under the press that chose it. Each hidden radio stands in its own
 * row (relative), so none reaches past the list to make the menu scroll when it fits. Opened, the chosen model stands
 * mid-list with the focus (data-popup-focus).
 */
function AgentMenu({ choice, disabled, options, close }: { choice: Choice; disabled: boolean; options: ReturnType<typeof agentModelChoices>; close: () => void }) {
  const { t } = useTranslation("forms");
  const text = useChoiceText();
  const problems = problemsToSay(choice.problems);
  const pick = (profile: string, model?: string | null) => {
    const values: Record<string, string | null> = model === undefined ? {} : { model };
    if (profile !== choice.profile) choice.chooseProfile(profile, values);
    else choice.setSelected(values);
  };
  // Below the models, every other row the chosen kind's settings write with something to choose (effort, fast, a row a
  // setting adds…), each as one row of buttons. A row the chosen model leaves out stays, saying so, so the menu keeps
  // its shape from model to model; a row to choose again is asked for even with one value.
  const settle = new Set(choice.problems.map(problem => problem.key));
  const offer = choice.profiles.find(profile => profile.key === choice.profile)?.offer;
  const offered = new Map(choice.choices.map(row => [row.key, row]));
  const steps = (offer ? offeredChoices(offer) : []).filter(row => row.key !== "model" && (row.candidates.length > 1 || settle.has(row.key)));
  const menu = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null), rows = useRef<HTMLDivElement>(null);
  // What the list hides: the kind whose rows went under its name at the head, and how far it goes on below (to FADE).
  // And the least room it keeps (LIST_FLOOR).
  const [hidden, setHidden] = useState<{ under: string | null; below: number; floor: number }>({ under: null, below: 0, floor: 0 });
  const [height, setHeight] = useState<number>();
  // The kinds and models the menu was measured with: another set (the settings changed under the open menu) is
  // measured anew.
  const measured = options.map(option => `${option.profile}/${option.model ?? ""}`).join("\n");
  useLayoutEffect(() => setHeight(undefined), [measured]);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const read = () => {
      const top = el.scrollTop, left = el.scrollHeight - top - el.clientHeight, below = left > 1 ? Math.min(FADE, Math.round(left)) : 0;
      const under = top < 1 ? null : [...el.querySelectorAll<HTMLElement>("[data-agent-kind-rows]")]
        .find(group => group.offsetTop <= top && group.offsetTop + group.offsetHeight > top)?.dataset.agentKindRows ?? null;
      const floor = Math.min(LIST_FLOOR, el.scrollHeight);
      setHidden(now => now.under === under && now.below === below && now.floor === floor ? now : { under, below, floor });
      // The surface holds the menu a frame after it opens; from then its height is kept. A height that no longer
      // holds what the menu has (the list at its least, more rows at the foot) is let go, and measured anew once it does.
      const root = menu.current;
      if (root?.offsetHeight) { const over = root.scrollHeight > root.clientHeight + 1; setHeight(now => over ? undefined : now ?? root.offsetHeight); }
    };
    // The chosen row stays in sight when the list's room changes under it (a kind with more rows at the foot took
    // some): clear of the kind's name at the head and of the fade at the foot.
    const reveal = () => {
      const row = el.querySelector("input:checked")?.closest<HTMLElement>("label");
      if (!row) return;
      const head = el.querySelector<HTMLElement>("[data-agent-kind-name]")?.offsetHeight ?? 0;
      const last = row.offsetTop + row.offsetHeight >= el.scrollHeight - FADE;
      const least = row.offsetTop + row.offsetHeight + (last ? 0 : FADE) - el.clientHeight, most = row.offsetTop - head;
      if (el.scrollTop < least) el.scrollTop = Math.min(least, most);
      else if (el.scrollTop > most) el.scrollTop = most;
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    // What the list has room for, and what it holds: its rows change with the settings.
    const room = new ResizeObserver(() => { reveal(); read(); }), held = new ResizeObserver(read);
    room.observe(el);
    if (rows.current) held.observe(rows.current);
    return () => { el.removeEventListener("scroll", read); room.disconnect(); held.disconnect(); };
  }, []);
  // A value that came with another kind, not from a press on it, is pointed out as its row comes in: the effort the
  // person had set is not the one this kind starts with. Said once: it is forgotten when its ring has gone.
  const [said, setSaid] = useState<{ profile: string; selected: Choice["selected"]; came: ReadonlySet<string> }>({ profile: choice.profile, selected: choice.selected, came: NONE });
  if (said.selected !== choice.selected) {
    const moved = Object.keys(choice.selected).filter(key => said.selected[key] !== choice.selected[key]);
    setSaid({ profile: choice.profile, selected: choice.selected, came: said.profile !== choice.profile
      ? new Set(moved.filter(key => key !== "model" && Object.hasOwn(said.selected, key))) : moved.length ? NONE : said.came });
  }
  const came = said.came;
  // Enter takes the choice and closes; Tab past either end closes too, and the focus goes back to the button (the
  // surface's own closing), not out of the page.
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isComposingKey(event)) return;
    // Not `instanceof`: in the conversation's own window the radio is that window's element.
    if (event.key === "Enter" && (event.target as Element).matches?.("input[type=radio]")) { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    // A radio group is one stop: its checked radio, else its first.
    const groups = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=radiogroup]:has(input:enabled)")];
    const at = groups.findIndex(group => group.contains(event.target as Node));
    if (at === (event.shiftKey ? 0 : groups.length - 1)) { event.preventDefault(); close(); }
  };
  return <div ref={menu} data-agent-picker-menu className="flex max-h-[calc(var(--radix-popover-content-available-height)-1.5rem-2px)] flex-col" style={{ height }} onKeyDown={keys}>
    <div ref={list} role="radiogroup" aria-label={text.row("model")} data-more-below={hidden.below || undefined} style={{ "--fade": `${hidden.below}px`, minHeight: hidden.floor } as CSSProperties}
      className={cn(TO_EDGES, "relative -mt-2 min-h-0 flex-1", height === undefined && "max-h-[min(28rem,50dvh)]", "scroll-pt-8 scroll-pb-10 overflow-y-auto overscroll-contain pb-1 data-more-below:[mask-image:linear-gradient(to_bottom,#000_calc(100%-var(--fade)),transparent)]")}>
      <div ref={rows}>{choice.profiles.map(profile => {
        const row = offeredChoices(profile.offer).find(each => each.key === "model");
        const named = options.filter(option => option.profile === profile.key);
        // "None" (a written `-`) where the settings offer leaving the model out and there are models to name; a kind
        // without any is its own one row.
        const rows: { model: string | null | undefined; name: string | null }[] = [
          ...(row?.candidates.includes(null) && named.some(option => option.model !== undefined) ? [{ model: null, name: null }] : []),
          ...named.map(({ model, name }) => ({ model, name })),
        ];
        return <div key={profile.key} role="group" aria-label={profile.key} data-agent-kind-rows={profile.key} className="px-1 pb-1 in-data-[slot=sheet]:px-2">
          <div aria-hidden="true" data-agent-kind-name className={cn(MENU_GROUP, "sticky top-0 z-1 bg-raised", hidden.under === profile.key && "after:absolute after:inset-x-0 after:top-full after:h-px after:bg-line")}>{profile.key}</div>
          {rows.map(({ model, name }) => {
            const checked = choice.profile === profile.key && (model === undefined || choice.selected.model === model);
            const label = name === null ? null : listedLabel(options, profile.key, name);
            return <label key={model === undefined ? "" : model ?? "-"} title={label?.full} className={menuRow(checked)}>
              <input type="radio" name="agent-pick" className="sr-only" checked={checked} disabled={disabled} aria-label={label?.full ?? text(null)}
                data-popup-focus={checked || undefined}
                onChange={() => { countUse('pick.model'); pick(profile.key, model); }} />
              <MenuTick checked={checked} />
              {/* The list has the room for a long name in full, on as many lines as it takes. */}
              <span className="min-w-0 flex-1 py-1 [overflow-wrap:anywhere]">{label ? label.short : text(null)}</span>
            </label>;
          })}
        </div>;
      })}</div>
    </div>
    {steps.length > 0 && <div className={cn(TO_EDGES, "flex flex-none flex-col gap-2 border-t border-line px-3 pt-1 in-data-[slot=sheet]:px-4")}>
      {steps.map(({ key }) => {
        const row = offered.get(key);
        const values = row ? stepOrder(row.candidates) : [];
        return <div key={`${choice.profile}:${key}`} role="radiogroup" aria-label={text.row(key)} className="flex flex-col gap-1">
          <div aria-hidden="true" className={cn(MENU_GROUP, "-mx-2 first-letter:uppercase")}>{text.row(key)}</div>
          {/* A row too long for one line goes on below; every line is filled, its buttons sharing its width evenly. */}
          {row ? <div className="flex flex-wrap gap-0.5 rounded-md bg-well p-0.5" style={{ "--steps": stepColumns(values.length) } as CSSProperties}>
            {values.map(value => {
              const on = Object.hasOwn(choice.selected, key) && choice.selected[key] === value;
              return <label key={value ?? "-"} title={text(value)} onAnimationEnd={() => setSaid(now => ({ ...now, came: NONE }))} className={cn("relative flex min-h-control-xs min-w-0 grow basis-[calc((100%_-_(var(--steps)_-_1)_*_2px)_/_var(--steps))] cursor-pointer items-center justify-center rounded-sm px-1.5 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-muted narrow:min-h-control-md pointer-coarse:min-h-control-md",
                on ? "bg-raised font-semibold text-ink ring-1 ring-line" : "text-muted hover:bg-hover hover:text-ink", on && came.has(key) && "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:animate-noted")}>
                <input type="radio" className="sr-only" name={`agent-${key}`} checked={on} disabled={disabled}
                  onChange={() => { countUse('pick.option'); choice.setSelected({ [key]: value }); }} />
                <span className="truncate">{text(value)}</span>
              </label>;
            })}
          </div> : <p className="m-0 rounded-md bg-well p-0.5 text-sm text-muted"><span className="flex min-h-control-xs items-center justify-center narrow:min-h-control-md pointer-coarse:min-h-control-md">{t("agentPicker.notOffered")}</span></p>}
        </div>;
      })}
    </div>}
    {(choice.gone || problems.length > 0) && <div data-selection-problems className={cn(TO_EDGES, "mt-3 flex flex-none flex-col gap-1 border-t border-line px-3 pt-2 in-data-[slot=sheet]:px-4")}>
      {choice.gone && <FieldError className="mt-0">{text.gone(choice.gone)}</FieldError>}
      {problems.map(problem => <FieldError key={problem.key} className="mt-0">{text.problem(problem)}</FieldError>)}
    </div>}
  </div>;
}
