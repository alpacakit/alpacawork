export type AgentExit = { code: number | null; signal: string | null };
export type ReaderResult =
  | { state: 'succeeded'; result: string | null; session?: string }
  | { state: 'failed'; reason: 'exit' | 'output'; result?: string; resultState?: 'missing' | 'too_large' | 'unreadable' }
  | { state: 'needs_review'; reason: 'conversation_busy' };
