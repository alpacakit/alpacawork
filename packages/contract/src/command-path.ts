/** Paths shared by the adapters and clients of the command tree. */
export const commandPrefix = 'commands';
export const commandRoute = (name: string) => `${commandPrefix}/${name}`;
export const commandPath = (name: string) => '/api/' + commandRoute(name);
