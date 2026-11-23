import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const map = <T extends z.ZodType>(entry: T) => z.record(z.string(), entry).nullish();
const serveConfig = z.object({
  AllowFunnel: map(z.boolean()),
  Web: map(z.object({ Handlers: map(z.object({ Proxy: z.string().optional() })) })),
  TCP: map(z.object({ TCPForward: z.string().optional() })),
  Foreground: map(z.unknown()),
}).loose();
type Exposure = 'private' | 'funnel' | 'unknown';
const readStatus = promisify(execFile);

function targetPort(target: string): number | null {
  if (target.startsWith('unix:')) return 0;
  if (/^\d+$/.test(target)) return Number(target);
  try {
    const url = new URL(target.includes('://') ? target : 'http://' + target);
    switch (url.protocol) {
      case 'https+insecure:':
      case 'https:': return Number(url.port || 443);
      case 'http:': return Number(url.port || 80);
      default: return null;
    }
  } catch { return null; }
}

/** Compare enabled Funnel handlers' target ports, which can differ from the port on the public URL. */
export function mcpFunnelExposure(raw: unknown, port: number): Exposure {
  const configs: z.infer<typeof serveConfig>[] = [];
  const pending: unknown[] = [raw ?? {}];
  let unknown = false;
  while (pending.length) {
    const parsed = serveConfig.safeParse(pending.pop());
    if (!parsed.success) { unknown = true; continue; }
    if (Object.keys(parsed.data).some(key => !['AllowFunnel', 'Web', 'TCP', 'Foreground', 'Services', 'ETag'].includes(key))) unknown = true;
    configs.push(parsed.data);
    for (const session of Object.values(parsed.data.Foreground ?? {})) pending.push(session);
  }
  for (const config of configs) {
    for (const [publicAddress, on] of Object.entries(config.AllowFunnel ?? {})) {
      if (!on) continue;
      const publicPort = /:(\d+)$/.exec(publicAddress)?.[1];
      let found = false;
      for (const current of configs) {
        const web = current.Web?.[publicAddress]?.Handlers;
        const tcp = publicPort ? current.TCP?.[publicPort]?.TCPForward : undefined;
        if (web || tcp) found = true;
        for (const target of [...Object.values(web ?? {}).map(handler => handler.Proxy), tcp]) {
          if (!target) continue;
          const destination = targetPort(target);
          if (destination === port) return 'funnel';
          if (destination === null) unknown = true;
        }
      }
      if (!found) unknown = true;
    }
  }
  return unknown ? 'unknown' : 'private';
}

export async function inspectMcpTailnet(port: number, env: Readonly<Record<string, string | undefined>>): Promise<Exposure> {
  try {
    const { stdout } = await readStatus('tailscale', ['serve', 'status', '--json'],
      { env, timeout: 3000, maxBuffer: 1024 * 1024 });
    return mcpFunnelExposure(JSON.parse(stdout), port);
  } catch { return 'unknown'; }
}
