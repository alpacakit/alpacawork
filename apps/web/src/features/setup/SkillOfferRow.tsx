import type * as React from "react";
import { Trans, useTranslation } from "react-i18next";
import type { SKILL_OFFERS } from "@alpacawork/contract";
import { BetaMark, RecommendedMark } from "./parts";
import { CapCentred } from "@/components/ui/text-mark";

type Offer = typeof SKILL_OFFERS[number];

/**
 * One offered skill, as setup and Settings both show it: what it changes, then how, then which skill and where it
 * comes from (the name means little before it is used). `state` stands at the end of the heading's line, dropping under
 * it where the heading leaves no room (a phone); `marked` shows the
 * recommended mark (setup, where it urges a tick).
 */
export function SkillOfferText({ offer, state, marked = false }: { offer: Offer; state?: React.ReactNode; marked?: boolean }) {
  const { t } = useTranslation("setup");
  return <span className="block min-w-0">
    <span className="flex flex-wrap items-baseline gap-x-3">
      <span className="font-semibold [word-break:auto-phrase]">{t(`skills.items.${offer.name}.title`)}</span>
      {/* Marked only where nothing is given up for it: a recommended one that costs time and tokens is ticked, not urged. */}
      {marked && offer.recommended && !offer.cost && <CapCentred><RecommendedMark /></CapCentred>}
      {offer.beta && <CapCentred><BetaMark /></CapCentred>}
      {state}
    </span>
    <span className="mt-0.5 block text-sm text-muted [word-break:auto-phrase]">{t(`skills.items.${offer.name}.what`)}</span>
    <span className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-soft">
      <code className="font-mono [overflow-wrap:anywhere]">{offer.name}</code>
      {/* Only a skill fetched from elsewhere says where from; one that comes with alpacawork needs no word. */}
      {offer.from.kind === "repo" && <span className="[word-break:auto-phrase]">
        <Trans t={t} i18nKey="skills.from.repo" values={{ repo: offer.from.repo }}
          components={{ repo: <a className="inline-link" href={`https://github.com/${offer.from.repo}`} target="_blank" rel="noreferrer" /> }} /></span>}
    </span>
  </span>;
}
