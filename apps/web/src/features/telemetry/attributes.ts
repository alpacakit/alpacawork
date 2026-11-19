/**
 * What a screen says of itself on each use: one reader per screen attribute of TELEMETRY_EVENT_ATTRIBUTES, so a new
 * attribute in that list is one more reader here. Only fixed names leave: never a user agent, a size or a place.
 */
import type { TelemetryScreenAttributes } from '@alpacawork/contract/telemetry';
import { i18n } from '@alpacawork/i18n';
import { usePersonalSettings } from '@/data/personal-settings';
import { isAgentView } from '@/lib/agent-view';
import { deviceOf } from './device';

const readers: { [Name in keyof TelemetryScreenAttributes]: () => TelemetryScreenAttributes[Name] } = {
  device: () => deviceOf(navigator),
  via: () => isAgentView() ? 'agent' : 'screen',
  lang: () => { const language = i18n.language?.split('-')[0]; return language === 'ja' || language === 'en' ? language : 'other'; },
  theme: () => { const theme = usePersonalSettings.getState().values.theme; return theme === 'light' || theme === 'dark' ? theme : 'system'; },
};
export function screenAttributes(): TelemetryScreenAttributes {
  return Object.fromEntries(Object.entries(readers).map(([name, read]) => [name, read()])) as TelemetryScreenAttributes;
}
