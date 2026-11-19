import { MERMAID_CHANNEL, isFrameRequest } from "./lib/mermaid-protocol";
import { renderMermaidSvg } from "./lib/mermaid-renderer";

// The parent serializes requests; keep the frame serialized too, so a duplicate message cannot overlap Mermaid's DB.
let queue: Promise<unknown> = Promise.resolve();
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || event.origin !== window.location.origin || !isFrameRequest(event.data)) return;
  const { id, source, palette } = event.data;
  queue = queue.then(async () => {
    const result = await renderMermaidSvg(source, palette);
    window.parent.postMessage({ channel: MERMAID_CHANNEL, id, result }, window.location.origin);
  });
});
window.parent.postMessage({ channel: MERMAID_CHANNEL, ready: true }, window.location.origin);
