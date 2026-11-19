/** The application's visit owns the agent view (`?agent=1`: an agent checking the screen), including surfaces hosted in a PiP about:blank document. */
export const isAgentView = () => new URL(window.location.href).searchParams.has("agent");
