// Node preloads run before the Playwright loader or any backend ESM imports.
import { loadGuard } from './guard.ts';
await loadGuard();
