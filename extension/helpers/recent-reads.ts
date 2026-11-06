/** One task read an agent asked for, as the popup lists it. */
export interface RecentRead {
  title: string
  /** The monday task page that was read. */
  url: string
  /** When the read finished, as an ISO timestamp. */
  at: string
  complete: boolean
  warnings: string[]
  /** The MCP client that asked for the read, as it named itself, or null when it gave no name. */
  agent: string | null
}

/** How many reads the extension keeps. The popup shows the newest few and lists them all on request. */
export const MAX_RECENT_READS = 10

const MAX_AGENT_LENGTH = 64

/** Puts a read at the front of the history, dropping the oldest past the limit. */
export function addRecentRead(reads: readonly RecentRead[], read: RecentRead): RecentRead[] {
  return [read, ...reads].slice(0, MAX_RECENT_READS)
}

/**
 * Keeps an agent name only when it is short printable text. The name comes from the MCP client through the bridge
 * and ends up in the popup, so anything else is dropped rather than shown.
 */
export function cleanAgentName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (name.length === 0 || name.length > MAX_AGENT_LENGTH || !/^[\x20-\x7E]+$/.test(name)) return null
  return name
}

const KNOWN_AGENTS: ReadonlyArray<[RegExp, string]> = [
  [/claude[\s_-]*code/i, 'Claude Code'],
  [/codex/i, 'Codex'],
  [/antigravity|^agy\b/i, 'agy'],
  [/gemini/i, 'Gemini CLI'],
  [/cursor/i, 'Cursor']
]

/** The name the popup shows for the agent that asked for a read. */
export function agentLabel(agent: string | null): string {
  if (!agent) return 'Unknown agent'
  return KNOWN_AGENTS.find(([pattern]) => pattern.test(agent))?.[1] ?? agent
}
