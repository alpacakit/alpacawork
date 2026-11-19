import { shapeStyle, type Box, type Sample } from "./answer-cue-motion";

/** How a card or a chip looks: what the flying shape takes from each end. */
export type Look = { tokens: [string, string][]; ground: string; background: string; border: string; radius: number; content: Node[]; padding: string; gap: string; weight: string; color: string; layout: Partial<CSSStyleDeclaration> };
/** The first solid colour behind an element: what a see-through background (a chosen card's tint) lies on. */
function groundOf(element: Element | null): string {
  for (let at = element; at; at = at.parentElement) {
    const colour = getComputedStyle(at).backgroundColor;
    if (colour && colour !== "transparent" && !/rgba\(.*,\s*0\)$/.test(colour)) return colour;
  }
  return "var(--lit)";
}
/**
 * The custom properties an element's place gives it (a held task's grey turn, say), as they differ from the body's.
 * A copy appended to the body carries them, so its words and edges keep the colours they had where they were.
 */
function tokensOf(style: CSSStyleDeclaration): [string, string][] {
  const body = getComputedStyle(document.body);
  return [...style].filter(name => name.startsWith("--") && style.getPropertyValue(name) !== body.getPropertyValue(name))
    .map(name => [name, style.getPropertyValue(name)]);
}
const carry = (element: HTMLElement, tokens: [string, string][]) => { for (const [name, value] of tokens) element.style.setProperty(name, value); };
export function lookOf(element: HTMLElement): Look {
  const style = getComputedStyle(element), box = element.getBoundingClientRect();
  return { tokens: tokensOf(style), ground: groundOf(element.parentElement), background: style.backgroundColor, border: style.borderTopColor, radius: Number.parseFloat(style.borderTopLeftRadius) || 0,
    content: [...element.cloneNode(true).childNodes], padding: `0 ${style.paddingRight} 0 ${style.paddingLeft}`, gap: style.columnGap, weight: style.fontWeight, color: style.color,
    layout: { width: `${box.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)}px`,
      height: `${box.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)}px`, boxSizing: 'border-box',
      padding: style.padding, display: style.display, alignItems: style.alignItems, justifyContent: style.justifyContent,
      whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, wordBreak: style.wordBreak, hyphens: style.hyphens, lineHeight: style.lineHeight, textAlign: style.textAlign, fontSize: style.fontSize,
      fontFamily: style.fontFamily, letterSpacing: style.letterSpacing, flexDirection: style.flexDirection, flexWrap: style.flexWrap } };
}
export const boxOf = (element: Element): Box => { const r = element.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height }; };

/**
 * The shape that flies: a box whose size, corners and colours are set each frame between the card's and the chip's,
 * holding both sets of words, the card's fading as the chip's come in. Its words are never scaled, only uncovered or
 * clipped, so they never stretch.
 */
export function shapeOf(key: string, card: Look, chip: Look) {
  const shape = document.createElement("div");
  shape.setAttribute("aria-hidden", "true");
  shape.dataset.cueCopy = key;
  shape.inert = true;
  // The one shadow (styles.css), as much of it as the shape has lifted (--lift, set as it is drawn).
  shape.className = "shadow-float text-sm";
  Object.assign(shape.style, { position: "fixed", left: "0px", top: "0px", zIndex: "26", pointerEvents: "none", overflow: "hidden",
    borderStyle: "solid", borderWidth: "1px", boxSizing: "border-box", willChange: "transform, width, height" });
  const layer = (look: Look, fixed = false) => {
    const words = document.createElement("span");
    Object.assign(words.style, { position: "absolute", inset: "0", display: "flex", alignItems: "center", whiteSpace: "nowrap",
      padding: look.padding, columnGap: look.gap, fontWeight: look.weight, color: look.color });
    if (fixed) Object.assign(words.style, look.layout);
    carry(words, look.tokens);
    words.append(...look.content.map(node => node.cloneNode(true)));
    shape.append(words);
    return words;
  };
  const words = { card: layer(card, true), chip: layer(chip) };
  document.body.append(shape);
  return { shape, words, looks: { card, chip } };
}
export type Shape = ReturnType<typeof shapeOf>;
/** Draw geometry without scaling either layer of words. The solid ground covers everything below the shape. */
export function draw({ shape, words, looks }: Shape, sample: Sample) {
  Object.assign(shape.style, shapeStyle(looks.card, looks.chip, sample));
  shape.style.setProperty("--lift", String(sample.lift));
  words.card.style.opacity = String(sample.cardWords);
  words.chip.style.opacity = String(sample.chipWords);
  shape.style.opacity = String(sample.opacity);
}


/** A still copy of the chip being replaced, where it is, above the hidden chip. */
export function stillOf(face: HTMLElement, key: string) {
  const copy = face.cloneNode(true) as HTMLElement;
  carry(copy, tokensOf(getComputedStyle(face)));
  copy.setAttribute("aria-hidden", "true");
  copy.dataset.cueLeaving = key;
  copy.inert = true;
  const box = face.getBoundingClientRect();
  Object.assign(copy.style, { position: "fixed", left: "0px", top: "0px", margin: "0", zIndex: "25", pointerEvents: "none",
    transform: `translate3d(${box.left}px, ${box.top}px, 0)` });
  document.body.append(copy);
  return copy;
}

/** Replace the chip's words and measured look without replacing the travelling shape. */
export function become(view: Shape, face: HTMLElement) {
  const chip = lookOf(face);
  for (const [name] of view.looks.chip.tokens) view.words.chip.style.removeProperty(name);
  view.looks.chip = chip;
  carry(view.words.chip, chip.tokens);
  view.words.chip.replaceChildren(...chip.content.map(node => node.cloneNode(true)));
}
