import { createContext, useContext } from 'react';

/** React context crosses portals; DOM fieldset inheritance alone cannot own editing permission. */
export const AgentSettingsDisabled = createContext(false);
export const useAgentSettingsDisabled = () => useContext(AgentSettingsDisabled);
