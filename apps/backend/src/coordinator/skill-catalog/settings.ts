import { resolve } from 'node:path';
import { Files, CatalogUnavailable } from './files.js';
import { parseToml } from './toml.js';
export async function jsonSettings(files: Files, path: string): Promise<Record<string, any>> {
  const raw = await files.text(path); if (raw === null) return {};
  try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new CatalogUnavailable('settings'); }
}
export function claudeSettings(settings: Record<string, any>) {
  if (settings.enabledPlugins && Object.values(settings.enabledPlugins).some(value => value !== false)) throw new CatalogUnavailable('plugins');
  if (settings.skillOverrides || settings.permissions?.additionalDirectories?.length || settings.additionalDirectories?.length) throw new CatalogUnavailable('settings');
  if (Object.keys(settings.env ?? {}).some(name => /^(?:CLAUDE_CONFIG_DIR|CLAUDE_CODE_.*(?:SKILL|PLUGIN|SIMPLE|SAFE_MODE)|HOME)$/.test(name))) throw new CatalogUnavailable('settings');
}
export async function codexSettings(files: Files, path: string): Promise<Set<string>> {
  const raw = await files.text(path), settings = raw === null ? {} : parseToml(raw);
  if (Object.values(settings.plugins ?? {}).some((value: any) => value?.enabled !== false) || settings.apps && Object.keys(settings.apps).length) throw new CatalogUnavailable('plugins');
  if (settings.features && Object.keys(settings.features).some(key => /skill|plugin|app/.test(key))) throw new CatalogUnavailable('settings');
  if (settings.skills && Object.keys(settings.skills).some(key => key !== 'config')) throw new CatalogUnavailable('settings');
  if (settings.profile) throw new CatalogUnavailable('settings');
  const disabled = new Set<string>();
  for (const config of settings.skills?.config ?? []) {
    if (!config || typeof config.path !== 'string' || typeof config.enabled !== 'boolean' || Object.keys(config).some(key => !['path', 'enabled'].includes(key))) throw new CatalogUnavailable('settings');
    // Codex expects absolute paths; relative enablement depends on configuration-layer provenance.
    if (!config.path.startsWith('/')) throw new CatalogUnavailable('settings');
    if (!config.enabled) disabled.add(await files.kind(config.path) ? await files.canonical(config.path) : resolve(config.path));
  }
  return disabled;
}
