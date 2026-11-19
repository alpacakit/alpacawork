/** Migration-only historical evidence. NEVER import into ordinary settings/admission.
 * Protocol shapes copied from the fixed Git sources below; choices/model IDs are intentionally absent.
 * Production-shaped argv is synthetic, assembled from these source shapes.
 * It proves the specified migration gate, not a comparison with a live production config.
 */
import type { BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
export type LegacyArgv = (string | string[])[];
export const MIGRATION_SOURCES = {
  template: {commit:'b8633011c3e7168c2800abd84e975242f328a55d',path:'apps/backend/src/agents-settings.ts',section:'AGENTS_TEMPLATE'},
  activityTextless: {commit:'10ed809214250ec29e24fa5580f7650a392a3a7d',path:'apps/backend/src/agents-settings.ts',section:'AGENTS_TEMPLATE.read.activity (message has no text path)'},
  activityEarly: {commit:'027ea2665b210759defaafd64e3fc11008de5e7f',path:'apps/backend/src/agents-settings.ts',section:'AGENTS_TEMPLATE.read.activity'},
  activity: {commit:'55dc7463db905ab2c078ea4f4e8ae546689128d4',path:'apps/backend/src/agents-settings.ts',section:'AGENTS_TEMPLATE.read.activity'},
  integrations: {commit:'9b84ceb85fd0491f6fa055985184322dcf2fc408',path:'docs/integrations/grok-agy.yaml',section:'agents.grok/agy'},
  plan: {document:'migration plan, kept outside the repository',sha256:'35fc05289b907d82420238e4b365df88219c9c5e9c5d741c3da0616d38527f3a',section:'§4.1/4.2 (production-shaped synthetic argv)'},
  savedLaunch: {commit:'b8633011c3e7168c2800abd84e975242f328a55d',path:'packages/contract/src/run-contract.ts',section:'runLaunchSchema.readRoots usage:string|null; launch values retained'},
  environment: {commit:'b8633011c3e7168c2800abd84e975242f328a55d',path:'apps/backend/src/runs/env.ts',section:'ALLOWED (historical global forwarding, excluding base environment)'},
} as const;
export type MigrationSource = keyof typeof MIGRATION_SOURCES;
export const LEGACY_PROTOCOLS = {
  claude: {
    input: {
      line: {
        type: 'user',
        message: { role: 'user', content: '{prompt}' },
        parent_tool_use_id: null,
        uuid: '{input}'
      },
      taken: { where: { type: 'command_lifecycle', state: 'started' }, path: 'command_uuid' },
      done: { where: { type: 'result' } }
    },
    read: {
      stdout: 'jsonl',
      session: { from: 'assigned' },
      completion: {
        event: {
          where: { type: 'result', session_id: '$session' },
          take: 'last_valid',
          require: { is_error: 'boolean', result: 'string' }
        },
        success: { is_error: false }
      },
      reply: { from: 'completion', path: 'result' },
      usage: {
        scope: 'conversation',
        event: { where: { type: 'result', session_id: '$session' }, take: 'last' },
        fields: {
          input: { sum: 'modelUsage.*.inputTokens' },
          cacheRead: { sum: 'modelUsage.*.cacheReadInputTokens' },
          cacheWrite: { sum: 'modelUsage.*.cacheCreationInputTokens' },
          output: { sum: 'modelUsage.*.outputTokens' }
        }
      }
    }
  },
  codex: {
    input: {
      line: { id: '{input}', text: '{prompt}' },
      taken: { where: { type: 'input.taken' }, path: 'id' },
      refused: { where: { type: 'input.refused' }, path: 'id' },
      done: { where: { type: [ 'turn.completed', 'turn.failed' ] } }
    },
    read: {
      stdout: 'jsonl',
      session: {
        from: 'stdout',
        event: {
          where: { type: 'thread.started' },
          take: 'first_line',
          path: 'thread_id',
          require: 'string'
        }
      },
      completion: { require_session: true },
      reply: { from: 'result_file' },
      on_exit: [
        {
          when: { resume: true, code: 1, signal: null, stderr_contains: 'already has an active writer' },
          state: 'needs_review',
          reason: 'conversation_busy'
        }
      ],
      usage: {
        scope: 'conversation',
        event: { where: { type: 'turn.completed' }, take: 'last', path: 'usage' },
        fields: {
          input: { sub: [ 'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens' ] },
          cacheRead: 'cached_input_tokens',
          cacheWrite: 'cache_write_input_tokens',
          output: 'output_tokens'
        }
      }
    }
  },
  grok: {
    input: {
      line: { id: '{input}', text: '{prompt}' },
      taken: { where: { type: 'input.taken' }, path: 'id' },
      done: { where: { type: [ 'turn.completed', 'turn.failed' ] } }
    },
    read: {
      stdout: 'jsonl',
      session: {
        from: 'stdout',
        event: { where: { type: 'thread.started' }, take: 'first', path: 'thread_id', require: 'string' }
      },
      completion: { require_session: true },
      reply: { from: 'result_file' }
    }
  },
  agy: {
    input: {
      line: { id: '{input}', text: '{prompt}' },
      taken: { where: { type: 'input.taken' }, path: 'id' },
      done: { where: { type: [ 'turn.completed', 'turn.failed' ] } }
    },
    read: {
      stdout: 'jsonl',
      session: {
        from: 'stdout',
        event: { where: { type: 'thread.started' }, take: 'first', path: 'thread_id', require: 'string' }
      },
      completion: { require_session: true },
      reply: { from: 'result_file' }
    }
  }
};
export const LEGACY_ACTIVITY = {
  claude: {
    timestamp: { path: 'timestamp', format: 'iso', otherwise: 'received' },
    expand: 'message.content.*',
    rules: [
      { when: { type: 'result', is_error: true }, kind: 'error' },
      { when: { type: 'result' }, kind: 'result' },
      {
        when: {
          type: 'assistant',
          parent_tool_use_id: null,
          'block.type': 'tool_use',
          'block.name': 'Bash'
        },
        kind: 'tool_start',
        tool: 'block.name',
        remember: { id: 'block.id', name: 'block.name' },
        shell: 'block.input.command'
      },
      {
        when: { type: 'assistant', 'block.type': 'tool_use' },
        kind: 'tool_start',
        tool: 'block.name',
        remember: { id: 'block.id', name: 'block.name' }
      },
      {
        when: { type: 'user', 'block.type': 'tool_result' },
        kind: 'tool_end',
        recall: 'block.tool_use_id'
      },
      {
        when: { type: 'assistant', parent_tool_use_id: null, 'block.type': 'text' },
        kind: 'message',
        text: 'block.text'
      }
    ],
    otherwise: 'output'
  },
  codex: {
    timestamp: 'received',
    rules: [
      { when: { type: [ 'error', 'turn.failed' ] }, kind: 'error' },
      { when: { 'item.type': 'error' }, kind: 'error' },
      { when: { type: 'turn.completed' }, kind: 'result' },
      {
        when: { type: 'item.started', 'item.type': 'command_execution' },
        kind: 'tool_start',
        tool: 'item.type',
        remember: { id: 'item.id', name: 'item.type' },
        shell: 'item.command'
      },
      {
        when: {
          type: 'item.started',
          'item.type': [ 'file_change', 'web_search', 'mcp_tool_call', 'collab_tool_call' ]
        },
        kind: 'tool_start',
        tool: 'item.type',
        remember: { id: 'item.id', name: 'item.type' }
      },
      {
        when: {
          type: 'item.completed',
          'item.type': [ 'command_execution', 'file_change', 'web_search', 'mcp_tool_call', 'collab_tool_call' ]
        },
        kind: 'tool_end',
        tool: 'item.type',
        recall: 'item.id'
      },
      { when: { 'item.type': 'agent_message' }, kind: 'message', text: 'item.text' }
    ],
    otherwise: 'output'
  }
};
export type MigrationDefault = {id:string; adapter:BuiltinAdapterId; source:MigrationSource; start:LegacyArgv; resume:LegacyArgv};
export const MIGRATION_DEFAULTS: readonly MigrationDefault[] = [
  {
    id: 'template-claude',
    adapter: 'claude',
    source: 'template',
    start: [
      'claude',
      '-p',
      '--session-id',
      '{session}',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--permission-prompts',
      'none'
    ],
    resume: [
      'claude',
      '-p',
      '--resume',
      '{session}',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--permission-prompts',
      'none'
    ]
  },
  {
    id: 'template-codex',
    adapter: 'codex',
    source: 'template',
    start: [
      'alpacawork-agent',
      'codex',
      '-s',
      'danger-full-access',
      '--skip-git-repo-check',
      '--json',
      '-o',
      '{result}'
    ],
    resume: [
      'alpacawork-agent',
      'codex',
      '-s',
      'danger-full-access',
      'resume',
      '--skip-git-repo-check',
      '--json',
      '-o',
      '{result}',
      '--',
      '{session}'
    ]
  },
  {
    id: 'opt-in-grok',
    adapter: 'grok',
    source: 'integrations',
    start: [ 'alpacawork-agent', 'grok', '--model', '{model}', '--effort', '{effort}', '-o', '{result}' ],
    resume: [
      'alpacawork-agent',
      'grok',
      '--model',
      '{model}',
      '--effort',
      '{effort}',
      '--session',
      '{session}',
      '-o',
      '{result}'
    ]
  },
  {
    id: 'opt-in-agy',
    adapter: 'agy',
    source: 'integrations',
    start: [ 'alpacawork-agent', 'agy', '--model', '{model}', [ '--effort', '{effort}' ], '-o', '{result}' ],
    resume: [
      'alpacawork-agent',
      'agy',
      '--model',
      '{model}',
      [ '--effort', '{effort}' ],
      '--conversation',
      '{session}',
      '-o',
      '{result}'
    ]
  },
  {
    id: 'production-shaped-claude',
    adapter: 'claude',
    source: 'plan',
    start: [
      'claude',            '--effort',
      '{effort}',          '--model',
      '{model}',           '-p',
      '--session-id',      '{session}',
      '--input-format',    'stream-json',
      '--output-format',   'stream-json',
      '--verbose',         '--permission-mode',
      'bypassPermissions', '--permission-prompts',
      'none'
    ],
    resume: [
      'claude',            '--effort',
      '{effort}',          '--model',
      '{model}',           '-p',
      '--resume',          '{session}',
      '--input-format',    'stream-json',
      '--output-format',   'stream-json',
      '--verbose',         '--permission-mode',
      'bypassPermissions', '--permission-prompts',
      'none'
    ]
  },
  {
    id: 'production-shaped-codex',
    adapter: 'codex',
    source: 'plan',
    start: [
      'alpacawork-agent',
      'codex',
      '-m',
      '{model}',
      '-c',
      'model_reasoning_effort={effort}',
      '-c',
      'service_tier={speed}',
      '-s',
      'danger-full-access',
      '--skip-git-repo-check',
      '--json',
      '-o',
      '{result}'
    ],
    resume: [
      'alpacawork-agent',
      'codex',
      '-m',
      '{model}',
      '-c',
      'model_reasoning_effort={effort}',
      '-c',
      'service_tier={speed}',
      '-s',
      'danger-full-access',
      'resume',
      '--skip-git-repo-check',
      '--json',
      '-o',
      '{result}',
      '--',
      '{session}'
    ]
  }
];
/** Old global allowlist; names only. Not the defaults for creating a new agent. */
export const LEGACY_FORWARDED_ENV = ('ANTHROPIC_API_KEY OPENAI_API_KEY API_SERVER_KEY QWEN_SERVER_TOKEN ' +
  'OPENCODE_SERVER_USERNAME OPENCODE_SERVER_PASSWORD CLAUDE_CONFIG_DIR CODEX_HOME ' +
  'DEEPSEEK_API_KEY DSH_HOME XAI_API_KEY GROK_HOME ' +
  'GEMINI_API_KEY AGY_ADC_AUTH GOOGLE_CLOUD_QUOTA_PROJECT GOOGLE_CLOUD_LOCATION GOOGLE_APPLICATION_CREDENTIALS').split(' ');

/** Verified Git generations: same read body, with the complete older activity declaration below. */
const EARLY_ACTIVITY = {
  "claude": {
    "timestamp": {
      "path": "timestamp",
      "format": "iso",
      "otherwise": "received"
    },
    "expand": "message.content.*",
    "rules": [
      {
        "when": {
          "type": "result",
          "is_error": true
        },
        "kind": "error"
      },
      {
        "when": {
          "type": "result"
        },
        "kind": "result"
      },
      {
        "when": {
          "type": "assistant",
          "block.type": "tool_use"
        },
        "kind": "tool_start",
        "tool": "block.name",
        "remember": {
          "id": "block.id",
          "name": "block.name"
        }
      },
      {
        "when": {
          "type": "user",
          "block.type": "tool_result"
        },
        "kind": "tool_end",
        "recall": "block.tool_use_id"
      },
      {
        "when": {
          "type": "assistant",
          "parent_tool_use_id": null,
          "block.type": "text"
        },
        "kind": "message",
        "text": "block.text"
      }
    ],
    "otherwise": "output"
  },
  "codex": {
    "timestamp": "received",
    "rules": [
      {
        "when": {
          "type": [
            "error",
            "turn.failed"
          ]
        },
        "kind": "error"
      },
      {
        "when": {
          "item.type": "error"
        },
        "kind": "error"
      },
      {
        "when": {
          "type": "turn.completed"
        },
        "kind": "result"
      },
      {
        "when": {
          "type": "item.started",
          "item.type": [
            "command_execution",
            "file_change",
            "web_search",
            "mcp_tool_call",
            "collab_tool_call"
          ]
        },
        "kind": "tool_start",
        "tool": "item.type"
      },
      {
        "when": {
          "type": "item.completed",
          "item.type": [
            "command_execution",
            "file_change",
            "web_search",
            "mcp_tool_call",
            "collab_tool_call"
          ]
        },
        "kind": "tool_end",
        "tool": "item.type"
      },
      {
        "when": {
          "item.type": "agent_message"
        },
        "kind": "message",
        "text": "item.text"
      }
    ],
    "otherwise": "output"
  }
};
type HistoricalGeneration = { generation: 'native' | 'bridge' | 'agent'; commit: string; path: string; adapter: 'claude' | 'codex'; prefix: string[]; start: string[]; resume: string[]; input: unknown; read: unknown };
export const LEGACY_GENERATIONS: readonly HistoricalGeneration[] = [
  { ...{"generation":"native","commit":"6d36938a1bc02467cd7b4d4b4e220e436822cdd9","path":"apps/backend/src/agents-settings.ts","adapter":"claude","prefix":["claude"],"start":["claude","-p","--session-id","{session}","--output-format","stream-json","--verbose","--permission-mode","bypassPermissions","--permission-prompts","none","--","{prompt}"],"resume":["claude","-p","--resume","{session}","--output-format","stream-json","--verbose","--permission-mode","bypassPermissions","--permission-prompts","none","--","{prompt}"]},
    input: null,
    read: { ...LEGACY_PROTOCOLS.claude.read, activity: EARLY_ACTIVITY.claude } },
  { ...{"generation":"native","commit":"6d36938a1bc02467cd7b4d4b4e220e436822cdd9","path":"apps/backend/src/agents-settings.ts","adapter":"codex","prefix":["codex","exec"],"start":["codex","exec","-s","danger-full-access","--skip-git-repo-check","--json","-o","{result}","--","{prompt}"],"resume":["codex","exec","-s","danger-full-access","resume","--skip-git-repo-check","--json","-o","{result}","--","{session}","{prompt}"]},
    input: null,
    read: { ...LEGACY_PROTOCOLS.codex.read, activity: EARLY_ACTIVITY.codex } },
  { ...{"generation":"bridge","commit":"9a3580de30f3574e8dad3d080be9231ecc817cb0","path":"apps/backend/src/agents-settings.ts","adapter":"claude","prefix":["claude"],"start":["claude","-p","--session-id","{session}","--input-format","stream-json","--output-format","stream-json","--verbose","--permission-mode","bypassPermissions","--permission-prompts","none"],"resume":["claude","-p","--resume","{session}","--input-format","stream-json","--output-format","stream-json","--verbose","--permission-mode","bypassPermissions","--permission-prompts","none"]},
    input: LEGACY_PROTOCOLS.claude.input,
    read: { ...LEGACY_PROTOCOLS.claude.read, activity: EARLY_ACTIVITY.claude } },
  { ...{"generation":"bridge","commit":"9a3580de30f3574e8dad3d080be9231ecc817cb0","path":"apps/backend/src/agents-settings.ts","adapter":"codex","prefix":["alpacawork-codex"],"start":["alpacawork-codex","-s","danger-full-access","--skip-git-repo-check","--json","-o","{result}"],"resume":["alpacawork-codex","-s","danger-full-access","resume","--skip-git-repo-check","--json","-o","{result}","--","{session}"]},
    input: LEGACY_PROTOCOLS.codex.input,
    read: { ...LEGACY_PROTOCOLS.codex.read, activity: EARLY_ACTIVITY.codex } },
  { ...{"generation":"agent","commit":"ddb8fe71a0c073ffba34488863783e00a01a45ef","path":"apps/backend/src/agents-settings.ts","adapter":"claude","prefix":["claude"],"start":["claude","-p","--session-id","{session}","--input-format","stream-json","--output-format","stream-json","--verbose","--permission-mode","bypassPermissions","--permission-prompts","none"],"resume":["claude","-p","--resume","{session}","--input-format","stream-json","--output-format","stream-json","--verbose","--permission-mode","bypassPermissions","--permission-prompts","none"]},
    input: LEGACY_PROTOCOLS.claude.input,
    read: { ...LEGACY_PROTOCOLS.claude.read, activity: EARLY_ACTIVITY.claude } },
  { ...{"generation":"agent","commit":"ddb8fe71a0c073ffba34488863783e00a01a45ef","path":"apps/backend/src/agents-settings.ts","adapter":"codex","prefix":["alpacawork-agent","codex"],"start":["alpacawork-agent","codex","-s","danger-full-access","--skip-git-repo-check","--json","-o","{result}"],"resume":["alpacawork-agent","codex","-s","danger-full-access","resume","--skip-git-repo-check","--json","-o","{result}","--","{session}"]},
    input: LEGACY_PROTOCOLS.codex.input,
    read: { ...LEGACY_PROTOCOLS.codex.read, activity: EARLY_ACTIVITY.codex } },
];

/** Activity declarations were unused before removal. Their exact known shapes can outlive
 * CLI prefix changes, so recognize them separately from active input/session/usage protocols. */
const TEXTLESS_ACTIVITY = {
  "claude": {
    "timestamp": {
      "path": "timestamp",
      "format": "iso",
      "otherwise": "received"
    },
    "expand": "message.content.*",
    "rules": [
      {
        "when": {
          "type": "result",
          "is_error": true
        },
        "kind": "error"
      },
      {
        "when": {
          "type": "result"
        },
        "kind": "result"
      },
      {
        "when": {
          "type": "assistant",
          "block.type": "tool_use"
        },
        "kind": "tool_start",
        "tool": "block.name",
        "remember": {
          "id": "block.id",
          "name": "block.name"
        }
      },
      {
        "when": {
          "type": "user",
          "block.type": "tool_result"
        },
        "kind": "tool_end",
        "recall": "block.tool_use_id"
      },
      {
        "when": {
          "type": "assistant",
          "block.type": "text"
        },
        "kind": "message"
      }
    ],
    "otherwise": "output"
  },
  "codex": {
    "timestamp": "received",
    "rules": [
      {
        "when": {
          "type": [
            "error",
            "turn.failed"
          ]
        },
        "kind": "error"
      },
      {
        "when": {
          "item.type": "error"
        },
        "kind": "error"
      },
      {
        "when": {
          "type": "turn.completed"
        },
        "kind": "result"
      },
      {
        "when": {
          "type": "item.started",
          "item.type": [
            "command_execution",
            "file_change",
            "web_search",
            "mcp_tool_call",
            "collab_tool_call"
          ]
        },
        "kind": "tool_start",
        "tool": "item.type"
      },
      {
        "when": {
          "type": "item.completed",
          "item.type": [
            "command_execution",
            "file_change",
            "web_search",
            "mcp_tool_call",
            "collab_tool_call"
          ]
        },
        "kind": "tool_end",
        "tool": "item.type"
      },
      {
        "when": {
          "item.type": "agent_message"
        },
        "kind": "message"
      }
    ],
    "otherwise": "output"
  }
};
export const LEGACY_ACTIVITIES = [
  { source: 'activityTextless', declarations: TEXTLESS_ACTIVITY },
  { source: 'activityEarly', declarations: EARLY_ACTIVITY },
  { source: 'activity', declarations: LEGACY_ACTIVITY },
] as const;
