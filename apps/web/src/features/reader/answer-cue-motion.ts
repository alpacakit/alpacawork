/** Geometry and appearance along one uninterrupted leg. Positions are centres in viewport pixels. */
export type Point = { x: number; y: number };
export type Box = Point & { width: number; height: number };
export type Sample = { box: Box; look: number; lift: number; cardWords: number; chipWords: number; opacity: number };
export type Leg = { from: Sample; toward: 0 | 1; velocity: Box | null; length: number; correction: { at: number; span: number; offset: Box; velocity: Box } | null };
export const mix = (a: number, b: number, k: number) => a + (b - a) * k;
export const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** cubic-bezier(0.3, 0, 0.2, 1): gathers speed, carries it through the middle and settles into place. */
function fromRest(x: number) {
  const at = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t * t + t ** 3;
  const slope = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * (1 - t) * t + 3 * (1 - b) * t * t;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const d = slope(0.3, 0.2, t);
    if (Math.abs(d) < 1e-6) break;
    t -= (at(0.3, 0.2, t) - x) / d;
  }
  return at(0, 1, clamp(t));
}

export const lengthFor = (slow: number, from: Point, to: Point) => slow * (1.6 + Math.min(1, Math.hypot(to.x - from.x, to.y - from.y) / 1000) * 0.6);
export const resting = (box: Box, look: 0 | 1): Sample => ({ box, look, lift: 0, cardWords: 1 - look, chipWords: look, opacity: 1 });

/** A new direction starts a leg; a different answer keeps its current clock. */
export function transition(current: 0 | 1 | null, toward: 0 | 1, changed: boolean) {
  return current === null ? 'start' : current !== toward ? 'turn' : changed ? 'retarget' : 'continue';
}

export function sampleAt(leg: Leg, to: Box, progress: number): Sample {
  const t = clamp(progress), e = leg.velocity ? 1 - (1 - t) ** 3 : fromRest(t);
  const from = leg.from.box, dx = to.x - from.x, dy = to.y - from.y;
  const bow = Math.min(60, Math.hypot(dx, dy) * 0.12);
  // A turn's near handle preserves the measured velocity: the time curve's initial slope is 3.
  const p1 = leg.velocity ? { x: from.x + leg.velocity.x * leg.length / 9, y: from.y + leg.velocity.y * leg.length / 9 }
    : { x: from.x + dx / 3, y: from.y + dy / 3 - bow };
  const p2 = { x: from.x + dx * 2 / 3, y: from.y + dy * 2 / 3 - bow }, u = 1 - e;
  const size = (key: 'width' | 'height') => leg.velocity
    ? u ** 3 * from[key] + 3 * u * u * e * (from[key] + leg.velocity[key] * leg.length / 9)
      + 3 * u * e * e * (from[key] + (to[key] - from[key]) * 2 / 3) + e ** 3 * to[key]
    : mix(from[key], to[key], e);
  const box = { x: u ** 3 * from.x + 3 * u * u * e * p1.x + 3 * u * e * e * p2.x + e ** 3 * to.x,
    y: u ** 3 * from.y + 3 * u * u * e * p1.y + 3 * u * e * e * p2.y + e ** 3 * to.y,
    width: size('width'), height: size('height') };
  if (leg.correction) {
    const { at, span, offset, velocity } = leg.correction, q = clamp((progress - at) / span);
    const remaining = leg.length * span;
    for (const key of ['x', 'y', 'width', 'height'] as const)
      box[key] += offset[key] * (1 - 3 * q * q + 2 * q ** 3) + velocity[key] * remaining * (q - 2 * q * q + q ** 3);
  }
  const look = mix(leg.from.look, leg.toward, e);
  const departing = !leg.velocity && leg.from.look === 0 && leg.toward === 1;
  const fading = (k: number) => clamp(k / 0.35);
  return { box, look, chipWords: clamp((look - 0.14) / 0.21),
    cardWords: departing ? clamp(1 - look / 0.13) : Math.min(leg.from.cardWords * (1 - e), clamp(1 - look / 0.13)),
    opacity: departing ? 1 : clamp(fading(look) + (leg.from.opacity - fading(leg.from.look)) * (1 - e)),
    lift: Math.sin(Math.PI * e) * (1 - leg.from.lift) + leg.from.lift * (1 - e) };
}


/** The base clock stays intact. Only a correction too close to landing extends the physical arrival. */
export const endOf = (leg: Leg) => leg.correction ? Math.max(1, leg.correction.at + leg.correction.span) : 1;

/** Keep the leg's clock and path, reserving enough time to join the new destination without a jump. */
export function retarget(leg: Leg, to: Box, progress: number, drawn: Box, velocity: Box, minimum: number): Leg {
  const base = { ...leg, correction: null }, at = Math.max(0, progress);
  const before = Math.max(0, at - 0.0001), after = at + 0.0001;
  const box = sampleAt(base, to, at).box, a = sampleAt(base, to, before).box, b = sampleAt(base, to, after).box;
  const offset = { ...box }, change = { ...box };
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    offset[key] = drawn[key] - box[key];
    change[key] = velocity[key] - (b[key] - a[key]) / ((after - before) * leg.length);
  }
  const needsTime = Object.values(offset).some(value => Math.abs(value) > 0.5);
  const span = Math.max(endOf(leg) - at, needsTime ? minimum / leg.length : 0);
  return span > 0 ? { ...base, correction: { at, span, offset, velocity: change } } : base;
}


type Surface = { radius: number; background: string; ground: string; border: string };
/** The same unscaled, opaque surface changes size, corners and colours from card to chip. */
export function shapeStyle(card: Surface, chip: Surface, { box, look }: Sample) {
  const blend = (from: string, to: string) => `color-mix(in oklab, ${to} ${look * 100}%, ${from})`;
  const tint = blend(card.background, chip.background), ground = blend(card.ground, chip.ground);
  return {
    width: `${box.width}px`, height: `${box.height}px`,
    transform: `translate3d(${box.x - box.width / 2}px, ${box.y - box.height / 2}px, 0)`,
    borderRadius: `${mix(card.radius, Math.min(chip.radius, box.height / 2), look)}px`,
    backgroundColor: 'var(--lit)',
    backgroundImage: `linear-gradient(${tint}, ${tint}), linear-gradient(${ground}, ${ground})`,
    borderColor: blend(card.border, chip.border),
  };
}
