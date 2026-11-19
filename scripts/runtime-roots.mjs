// `from` names the installed workspace that declares a root unavailable at the repo root.
export const RUNTIME_EXTERNAL_ROOTS = [
  { name: '@github/copilot-sdk', from: 'apps/agent-cli' },
  { name: 'koffi', from: '.' },
];
