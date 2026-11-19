import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

/**
 * The third lane: rendered component behaviour under server answers the real
 * server cannot be asked for on demand (a write whose outcome is unknown, a
 * stale precondition). It reuses the application's own Vite pipeline so a test
 * sees the same transform as the shipped bundle.
 *
 * Looks and geometry stay with Playwright. jsdom reports every rectangle as
 * zero, so an assertion about layout or motion would be a lie here.
 */
export default mergeConfig(
  viteConfig({ command: "serve", mode: "test", isSsrBuild: false, isPreview: false }),
  defineConfig({
    test: {
      pool: "vmThreads",
      // Recycle retained VM contexts below the worker's V8 heap limit.
      vmMemoryLimit: "1GiB",
      environment: "jsdom",
      setupFiles: ["./tests/setup.ts"],
      include: ["tests/**/*.test.tsx"],
      css: false,
      restoreMocks: true,
    },
  }),
);
