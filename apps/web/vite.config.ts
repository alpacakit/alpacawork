import { defineConfig, mergeConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { devPerformance } from './dev/performance-plugin.ts';
import { thirdPartyRecord } from '../../scripts/third-party-record.ts';

/** The CSS ground is also the source for the browser's launch and chrome colours. */
const pwaColors = {
  name: "pwa-colors",
  apply: "build" as const,
  closeBundle() {
    const css = readFileSync(fileURLToPath(new URL("./src/styles/tokens.css", import.meta.url)), "utf8");
    const backgrounds = [...css.matchAll(/--bg:\s*(#[0-9a-fA-F]{6})\s*;/g)].map(match => match[1]!.toLowerCase());
    if (backgrounds.length !== 2) throw new Error("Expected light and dark --bg colours in styles/tokens.css");
    writeFileSync(fileURLToPath(new URL("../backend/public/pwa-colors.json", import.meta.url)),
      JSON.stringify({ light: backgrounds[0], dark: backgrounds[1] }));
  },
};

/** The version this page is built as: the app's own (root package.json), drawn at the foot of settings. */
const appVersion = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")).version as string;

export function webConfig(optimized = true): UserConfig {
  const thirdParty = thirdPartyRecord({ app: new URL('.', import.meta.url), packages: ['tailwindcss'] });
  return {
  // Force React's optimized conditions even when invoked from a development shell.
  define: { __APP_VERSION__: JSON.stringify(appVersion), ...optimized ? { 'process.env.NODE_ENV': JSON.stringify('production') } : {} },
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [devPerformance(), react(), tailwind(), pwaColors, thirdParty.plugin],
  resolve: { alias: [
    { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
  ] },
  worker: { format: "es", plugins: () => [thirdParty.worker] },
  build: { rolldownOptions: { output: { entryFileNames: 'assets/[name]-[hash].js' }, input: { app: fileURLToPath(new URL("./index.html", import.meta.url)), mermaidFrame: fileURLToPath(new URL("./mermaid-frame.html", import.meta.url)) } }, manifest: "asset-manifest.json", outDir: "../backend/public", emptyOutDir: true,
  },
}; }
export default defineConfig(({ command, mode }) => {
  const config = webConfig(command === 'build');
  // Keep the existing explicit lab build used by e2e/perf. Release scripts pin --mode production;
  // diagnostic uses its separate config, so neither release edition can select this experiment.
  return mode === 'profiling' ? mergeConfig(config, { resolve: { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] },
    build: { minify: false } }) : config;
});
