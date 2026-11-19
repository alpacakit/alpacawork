/** Bundles stop only at the two native runtime roots. Their own dependencies are copied at assembly. */
import { RUNTIME_EXTERNAL_ROOTS } from './runtime-roots.mjs';
export { RUNTIME_EXTERNAL_ROOTS } from './runtime-roots.mjs';
export const runtimeExternalPackages = () => new Set(RUNTIME_EXTERNAL_ROOTS.map(({ name }) => name));
