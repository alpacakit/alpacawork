import { appRoot } from '../app-paths.js';
/** Only packaged build files are public. This never serves workspace/RAW paths. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { screenName } from "../control/project-settings.js";
import { offeredVoice } from '../voice.js';
import { createPersonSettings } from './person-state.js';
const WEB_DIRECTORY = join(appRoot(import.meta.url), 'apps/backend/public');
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
};
/** The Service Worker is written with this build's files; the manifest uses the current workspace name and theme. */
const SERVICE_WORKER = "sw.js";
const MERMAID_FRAME = "/mermaid-frame.html";
/** Explains a blank screen in a browser too old for the bundle; it sits outside `/assets/`, so it is not content-hashed. */
const BROWSER_CHECK = "/browser-check.js";
// Browser policy, independent of Mermaid grammar and diagram type. Only packaged JS can be fetched.
const MERMAID_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'none'; media-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const FOLDERS = ["assets", "icons"];
/** Placeholder in sw.js that serve replaces with `{ version, files }` for the Service Worker to keep. */
const BUILD_PLACEHOLDER = '/*__PWA_BUILD__*/{ version: "dev", files: [], precache: [] }';
/** Vite names `/assets/` files by their content, so a browser may keep them for good. */
const IMMUTABLE = "max-age=31536000, immutable";
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("base64url");
const entityTag = (bytes: Buffer) => `"${digest(bytes).slice(0, 27)}"`;
type Representation = { bytes: Buffer; tag: string };
type Asset = Representation & { type: string; gzip?: Representation };
/** An explicit refusal wins over a wildcard; absent negotiation keeps the identity representation. */
function acceptsGzip(header: string | undefined): boolean {
  const qualities = new Map<string, number>();
  for (const item of header?.split(',') ?? []) {
    const [coding, ...parameters] = item.trim().toLowerCase().split(';').map(part => part.trim());
    const quality = parameters.find(parameter => parameter.startsWith('q='))?.slice(2) ?? '1';
    qualities.set(coding!, /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality) ? Number(quality) : 0);
  }
  const gzip = qualities.get('gzip') ?? qualities.get('*') ?? 0;
  return gzip > 0 && gzip >= (qualities.get('identity') ?? 0);
}
const htmlEscape = (value: string) => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

export function createWebAssets(root: string, directory = WEB_DIRECTORY) {
  // Exact build manifest avoids arbitrary path resolution or SPA fallback into private files.
  const assets = new Map<string, Asset>();
  let index: string | undefined;
  let manifest: Record<string, unknown> | undefined;
  let colors: { light: string; dark: string } | undefined;
  let version: string | undefined;
  const person = createPersonSettings(root);
  const add = (pathname: string, file: string) => {
    const type = types[extname(file)];
    if (!type) return;
    const bytes = readFileSync(file);
    assets.set(pathname, { bytes, type, tag: entityTag(bytes) });
  };
  try {
    index = readFileSync(join(directory, "index.html"), "utf8");
    manifest = JSON.parse(readFileSync(join(directory, "manifest.webmanifest"), "utf8"));
    colors = JSON.parse(readFileSync(join(directory, "pwa-colors.json"), "utf8"));
    for (const folder of FOLDERS) {
      let entries;
      try { entries = readdirSync(join(directory, folder), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; continue; }
      for (const entry of entries) if (entry.isFile()) add(`/${folder}/${entry.name}`, join(directory, folder, entry.name));
    }
    for (const pathname of [MERMAID_FRAME, BROWSER_CHECK]) {
      try { add(pathname, join(directory, pathname.slice(1))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    // Vite's static imports and explicit startup dependencies are the offline startup set. Dynamic imports remain in `files`, so the
    // worker caches them on first use without downloading every optional renderer at each upgrade.
    const build = (() => {
      try {
        return JSON.parse(readFileSync(join(directory, "asset-manifest.json"), "utf8")) as Record<string,
          { file: string; isEntry?: boolean; imports?: string[]; startup?: string[]; css?: string[]; assets?: string[] }>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return null;
      }
    })();
    // A build without Vite metadata still serves its worker and keeps every known file.
    const precache = new Set(["/", ...[...assets.keys()].filter(path => !build || (!path.startsWith("/assets/") && path !== MERMAID_FRAME))]);
    const visited = new Set<string>();
    const keepEntry = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);
      const entry = build?.[key];
      if (!entry) throw new Error(`Missing Vite build entry: ${key}`);
      for (const file of [entry.file, ...entry.css ?? [], ...entry.assets ?? []]) {
        if (!assets.has("/" + file)) throw new Error(`Missing Vite startup asset: ${file}`);
        precache.add("/" + file);
      }
      for (const imported of [...entry.imports ?? [], ...entry.startup ?? []]) keepEntry(imported);
    };
    if (build) {
      if (!build["index.html"]?.isEntry) throw new Error("Missing Vite HTML entry: index.html");
      keepEntry("index.html");
    }
    // One identity covers the offline shell, its graph and the worker's storage policy.
    const kept = [...assets.keys()].sort();
    try {
      const source = readFileSync(join(directory, SERVICE_WORKER), "utf8");
      if (!source.includes(BUILD_PLACEHOLDER)) throw new Error(`${SERVICE_WORKER} has lost its build placeholder`);
      const startup = [...precache].sort();
      version = digest(JSON.stringify([index, manifest, colors, source, MERMAID_CSP, startup,
        kept.map(pathname => [pathname, assets.get(pathname)!.tag])])).slice(0, 16);
      const bytes = Buffer.from(source.replace(BUILD_PLACEHOLDER, () => JSON.stringify({ version, files: ["/", ...kept], precache: startup })));
      assets.set("/" + SERVICE_WORKER, { bytes, type: types[".js"]!, tag: entityTag(bytes) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return (pathname: string, headers: IncomingHttpHeaders, response: ServerResponse): boolean => {
    let asset = assets.get(pathname);
    const voice = pathname === '/' ? offeredVoice(root) : null;
    if (index && manifest && colors && (pathname === "/" || pathname === "/manifest.webmanifest")) {
      const name = screenName(root);
      // The saved theme is the one choice that holds between visits, so the page starts in it: its first frame and the
      // window's bar take their colour from the document's first parse, and a browser can miss a later change of the bar.
      const theme = person.values().theme;
      const saved = theme === "dark" || theme === "light" ? theme : null;
      if (pathname === "/") {
        const bytes = Buffer.from(index.replace('</head>', voice ? '<meta name="alpacawork-voice" content="enabled"></head>' : '</head>')
          .replace("__PWA_THEME__", saved ?? "system").replaceAll("__PWA_LIGHT__", saved ? colors[saved] : colors.light)
          .replaceAll("__PWA_DARK__", saved ? colors[saved] : colors.dark).replaceAll("__PWA_NAME__", htmlEscape(name)));
        asset = { bytes, type: "text/html; charset=utf-8", tag: entityTag(bytes) };
      } else {
        // An installed app keeps these colours from its last update and paints Android's navigation bar with theme_color;
        // the page cannot change it at runtime.
        const color = saved === "dark" ? colors.dark : colors.light;
        const bytes = Buffer.from(JSON.stringify({ ...manifest, name, short_name: name,
          theme_color: color, background_color: color }));
        asset = { bytes, type: "application/manifest+json; charset=utf-8", tag: entityTag(bytes) };
      }
    }
    if (!asset) return false;
    // Compress a packaged text representation once, when first requested. Its decoded bytes and the
    // Service Worker's build identity stay canonical; optional chunks need no eager compression work.
    const compressible = asset.type.startsWith('text/') || ['image/svg+xml; charset=utf-8', 'application/manifest+json; charset=utf-8'].includes(asset.type);
    const compressed = compressible && acceptsGzip(headers['accept-encoding']);
    if (compressed && !asset.gzip) {
      const bytes = gzipSync(asset.bytes);
      asset.gzip = { bytes, tag: entityTag(bytes) };
    }
    const representation = compressed ? asset.gzip! : asset;
    // Files outside `/assets/` may be kept but are checked each time; an unchanged one costs a 304.
    const ifNoneMatch = headers['if-none-match'];
    const fresh = ifNoneMatch !== undefined && ifNoneMatch.split(",").some(tag => tag.trim().replace(/^W\//, "") === representation.tag);
    response.writeHead(fresh ? 304 : 200, {
      "Content-Type": asset.type,
      "Cache-Control": pathname.startsWith("/assets/") ? IMMUTABLE : "no-cache",
      ETag: representation.tag,
      ...(version ? { 'X-Alpacawork-Build': version } : {}),
      ...(compressible ? { Vary: 'Accept-Encoding' } : {}),
      ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": pathname === MERMAID_FRAME ? MERMAID_CSP :
        `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'${voice && voice.provider !== 'local' ? ` ${new URL(voice.endpoint).origin}` : ''}; img-src 'self' data:; media-src 'self'; frame-src 'self'; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    });
    response.end(fresh ? undefined : representation.bytes);
    return true;
  };
}
