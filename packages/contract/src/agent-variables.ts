/** One namespace for the new settings/options contract. Old DSL is removed at the stage-3 cutover. */
export const SYSTEM_VARIABLE_NAMES = ['session', 'result', 'prompt', 'prompt_file'] as const;
export type SystemVariableName = (typeof SYSTEM_VARIABLE_NAMES)[number];
export const RESERVED_PARAM_NAMES: ReadonlySet<string> = new Set([
  ...SYSTEM_VARIABLE_NAMES, 'input', 'permission', 'start', 'resume', 'read', 'reader', 'adapter', 'enabled',
  'params', 'options', 'env', 'without', 'base', 'argv', 'path', 'values', 'mode', 'restart_argv',
]);
export const isVariableName = (name: string): boolean => /^[a-z][a-z0-9_]*$(?![\s\S])/.test(name);
export const isParamName = (name: string): boolean => isVariableName(name) && !RESERVED_PARAM_NAMES.has(name);
export const isSystemVariable = (name: string): name is SystemVariableName =>
  (SYSTEM_VARIABLE_NAMES as readonly string[]).includes(name);
