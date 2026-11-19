/** Shared colour math; CSS is resolved by the browser, never by Mermaid/khroma. */
const contexts = new WeakMap<Document, CanvasRenderingContext2D>();
export function srgb(color: string, at: Document, ground?: string): string {
  if (!at.defaultView!.CSS.supports("color", color)) throw new Error(`Invalid diagram colour: ${color}`);
  let context = contexts.get(at);
  if (!context) {
    context = at.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    if (!context) throw new Error("Diagram colours require a canvas colour context");
    contexts.set(at, context);
  }
  context.clearRect(0, 0, 1, 1);
  if (ground) { context.fillStyle = ground; context.fillRect(0, 0, 1, 1); }
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1).data;
  let hex = "#";
  for (let i = 0; i < 3 && i < data.length; i++) hex += data[i]!.toString(16).padStart(2, "0");
  return hex;
}
const channels = (hex: string) => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
const luminance = (hex: string) => channels(hex).reduce((sum, channel, i) => {
  const n = channel / 255;
  const linear = n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  return sum + linear * [0.2126, 0.7152, 0.0722][i]!;
}, 0);
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function tint(color: string, ground: string, amount: number): string {
  const base = channels(ground);
  return "#" + channels(color).map((n, i) => Math.round(n * amount + base[i]! * (1 - amount)).toString(16).padStart(2, "0")).join("");
}
