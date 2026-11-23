import { Problem, PROBLEM_CODE } from '@alpacawork/core';

// Increment only when old skills/CLIs would act incorrectly: removed/renamed arguments or changed meanings,
// defaults, state transitions or response shapes. Adding optional fields alone does not require an increment.
export const CLI_CONTRACT = 2;
export const CONTRACT_HEADER = 'X-Alpacawork-Contract';

/** The caller supplies installation guidance; this contract owns the one compatibility decision. */
export function clientContractRefusal(clientContract: string | null, serverVersion: string, repairCommand: () => string): Problem | null {
  if (clientContract === String(CLI_CONTRACT)) return null;
  const command = repairCommand();
  return new Problem(PROBLEM_CODE.invalidInput,
    `CLI contract mismatch: server ${serverVersion} requires contract ${CLI_CONTRACT} (CLI contract: ${clientContract ?? 'missing'}). Run on the CLI's PC to update both CLI and skills: ${command}. Then reread the skills and send again.`,
    { serverVersion, serverContract: CLI_CONTRACT, clientContract, command });
}
