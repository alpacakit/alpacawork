import { fileURLToPath } from 'node:url';
import { releaseForEntry } from '@alpacawork/core';
export { releaseForEntry } from '@alpacawork/core';
export const thisRelease = () => releaseForEntry(fileURLToPath(import.meta.url));
