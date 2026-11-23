import { z } from 'zod';

export const mcpPath = '/mcp';
export const mcpSourceHeader = 'X-Alpacawork-Mcp';
export const mcpRelayHeader = 'X-Alpacawork-Mcp-Relay';
export const mcpProtocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const mcpReadTool = 'alpacawork_read';
export const mcpWriteTool = 'alpacawork_write';
export const mcpInlineFileBytes = 8 * 1024 * 1024;
export const mcpRequestBytes = Math.ceil(mcpInlineFileBytes / 3) * 4 + 64 * 1024;
export const mcpFlagGuide = 'CLI flags are input keys: --foo-bar is fooBar, --no-foo is false, and --foo null is null. ' +
  'For --x-file use x with the file contents, a string for text or a JSON value for values and plan. ' +
  'For writes use the tool’s opId and restoreId. For operation get use input.opId.';

export const mcpGuideName = z.enum([
  'SKILL.md', 'references/coordinator.md', 'references/owner.md', 'references/member.md',
  'references/config.md', 'references/setup.md', 'references/request.md', 'references/lifecycle.md', 'references/troubleshoot.md',
]);
export const mcpFileReadOptions = z.object({
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().positive().max(32 * 1024).optional(),
  version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  encoding: z.enum(['text', 'base64']).optional(),
  digest: z.boolean().optional(),
});
export type McpFileReadOptions = z.infer<typeof mcpFileReadOptions>;
