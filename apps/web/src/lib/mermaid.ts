/** Reader-side owner of the one reusable renderer, its deadline, serial queue and theme cache.
 * Mermaid never runs in this realm. The frame's HTTP CSP owns resource access for every diagram type.
 */
import { MERMAID_CHANNEL, MERMAID_FRAME_PATH, MERMAID_TIMEOUT_MS, isFrameReply, type FrameRequest, type FrameResult, type DiagramPalette, type DiagramSize } from "./mermaid-protocol";
export type DiagramResult = ({ ok: true; src: string } & DiagramSize) | { ok: false; reason: string };
let client: DiagramFrame | undefined;
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;
const cache = new Map<string, { palette: string; result: Promise<DiagramResult> }>();
const CACHE_LIMIT = 64;

class DiagramFrame {
  private frame = document.createElement("iframe");
  private ready = false;
  private pending?: { request: FrameRequest; resolve: (result: FrameResult) => void; timer: ReturnType<typeof setTimeout> };
  get connected() { return this.frame.isConnected; }
  constructor() {
    this.frame.src = MERMAID_FRAME_PATH;
    this.frame.dataset.mermaidFrame = "";
    this.frame.title = "Diagram renderer";
    this.frame.setAttribute("aria-hidden", "true");
    this.frame.tabIndex = -1;
    // Layout is an invariant of the renderer, never a hidden input from the reader's viewport/cache.
    // Keep the desktop drawing width; the reader/slider own fitting and zooming the resulting image.
    this.frame.style.cssText = "position:fixed;left:-100000px;top:0;width:1280px;height:100%;border:0;visibility:hidden;pointer-events:none";
    window.addEventListener("message", this.receive);
    window.addEventListener("pagehide", this.pagehide);
    this.frame.addEventListener("error", this.loadError);
    try { document.body.append(this.frame); }
    catch (error) { this.close("Could not create diagram frame"); throw error; }
  }
  render(request: FrameRequest): Promise<FrameResult> {
    return new Promise(resolve => {
      const timer = setTimeout(() => this.close("Diagram frame timed out"), MERMAID_TIMEOUT_MS);
      this.pending = { request, resolve, timer };
      if (this.ready) this.send();
    });
  }
  private send() {
    try { this.frame.contentWindow!.postMessage(this.pending!.request, window.location.origin); }
    catch { this.close("Could not send to diagram frame"); }
  }
  private receive = (event: MessageEvent<unknown>) => {
    if (event.source !== this.frame.contentWindow || event.origin !== window.location.origin) return;
    const data = event.data;
    if (data && typeof data === "object" && "channel" in data && data.channel === MERMAID_CHANNEL && "ready" in data && data.ready === true) {
      // A repeated ready message cannot submit a pending render twice.
      if (!this.ready) { this.ready = true; if (this.pending) this.send(); }
    } else if (isFrameReply(data) && data.id === this.pending?.request.id) this.finish(data.result);
  };
  private finish(result: FrameResult) {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.resolve(result); }
  }
  private loadError = () => this.close("Could not load diagram frame");
  private pagehide = () => this.close("Diagram page closed");
  private close(reason: string) {
    window.removeEventListener("message", this.receive);
    window.removeEventListener("pagehide", this.pagehide);
    this.frame.removeEventListener("error", this.loadError);
    this.frame.remove();
    this.finish({ ok: false, reason });
  }
}

export function renderMermaid(source: string, palette: DiagramPalette): Promise<DiagramResult> {
  const key = JSON.stringify([source, palette.theme]), signature = JSON.stringify(palette);
  const kept = cache.get(key);
  if (kept?.palette === signature) return kept.result;
  const result = queue.then(async (): Promise<DiagramResult> => {
    try {
      if (!client?.connected) client = new DiagramFrame();
      const rendered = await client.render({ channel: MERMAID_CHANNEL, id: ++sequence, source, palette });
      if (!rendered.ok) return rendered;
      const { svg, ...size } = rendered;
      // Keep the final SVG-as-img boundary: no scripts, links or events from the frame enter the app DOM.
      return { ...size, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  queue = result;
  cache.set(key, { palette: signature, result });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}
