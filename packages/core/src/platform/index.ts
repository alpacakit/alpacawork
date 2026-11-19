/** Select one host implementation before storage or Run control starts. */
import { PROBLEM_CODE, Problem } from '../errors.js';
import { darwinAdapter } from './darwin.js';
import { linuxAdapter } from './linux.js';
import type { HostAdapter } from './types.js';

function selectHost(): HostAdapter {
  if (process.platform === 'darwin' && process.arch === 'arm64') return darwinAdapter;
  if (process.platform === 'linux' && process.arch === 'x64') return linuxAdapter;
  throw new Problem(PROBLEM_CODE.unsupportedPlatform,
    `alpacawork requires macOS arm64 or Linux x64; ${process.platform} ${process.arch} is unsupported`);
}

export const platform = selectHost();
