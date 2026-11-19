/** Public local command, shared by send refusal and operation resumption guidance. */
export function skillsUpdateCommand(version: string): string {
  // This value enters a shell command shown to the person, so accept package version syntax only.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid expected package version');
  return `npx --yes --package=alpacawork@${version} alpacawork skills update --package-version ${version}`;
}

/** A CLI on another PC needs its executable aligned as well as its bundled skills. */
export function cliRepairCommand(version: string): string {
  return `npm install -g alpacawork@${version} && ${skillsUpdateCommand(version)}`;
}
