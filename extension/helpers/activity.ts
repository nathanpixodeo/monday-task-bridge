import type { ColumnInput, WriteBackRequest, WriteBackResult, WriteRequest, WriteResult } from '../../shared/types'

/** What an agent asked the extension to do: read a task, or one kind of write. */
export type ActivityKind = 'read' | WriteRequest['op'] | 'write-back'

/** One read or write an agent asked for, as the popup lists it. */
export interface ActivityEntry {
  kind: ActivityKind
  /** The task's name; "Item <id>" when monday did not give it. */
  title: string
  /** The monday task page. */
  url: string
  /** When the read or write finished, as an ISO timestamp. */
  at: string
  /** The MCP client that asked, as it named itself, or null when it gave no name. */
  agent: string | null
  /** A read that was complete, or a write that was done. */
  ok: boolean
  /** What a read could not capture. */
  warnings: string[]
  /** Why a write failed. */
  error?: string
  /** The text of the update added, the new text of one edited, or the text of one deleted; cut at MAX_BODY_LENGTH. */
  body?: string
  /** The update added or edited, for a quick link to it. */
  updateUrl?: string
  /** The update this one replies to. */
  replyTo?: string
  /** The names of the people tagged in the update. */
  mentioned?: string[]
  /** The columns set, with the values as the agent gave them. */
  columns?: Array<{ title: string; value: string }>
  /** The group the item went to, for a move or a new item. */
  group?: string
  /** Tags or labels created on the way. */
  created?: string[]
  /** The status label a write-back set. */
  status?: string
}

/** How many entries the extension keeps. The popup shows the newest few and lists them all on request. */
export const MAX_ACTIVITY = 50

/** How much of an update's text the log keeps. */
export const MAX_BODY_LENGTH = 2000

const MAX_AGENT_LENGTH = 64

/** Puts an entry at the front of the log, dropping the oldest past the limit. */
export function addActivity(log: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  return [entry, ...log].slice(0, MAX_ACTIVITY)
}

export const taskUrl = (host: string, boardId: string, itemId: string) => `https://${host}/boards/${boardId}/pulses/${itemId}`

const cut = (text: string) => (text.length > MAX_BODY_LENGTH ? `${text.slice(0, MAX_BODY_LENGTH - 1)}…` : text)

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A column value as the agent gave it, written for a person to read. */
export function describeColumnInput(input: ColumnInput): string {
  if (input === null) return 'cleared'
  if (typeof input === 'boolean') return input ? 'checked' : 'unchecked'
  if (typeof input === 'string' || typeof input === 'number') return String(input)
  if (Array.isArray(input)) return input.join(', ')
  if ('from' in input) return `${input.from} → ${input.to}`
  if ('url' in input) return input.text?.trim() ? `${input.text.trim()} (${input.url})` : input.url
  return [...(input.add ?? []).map((name) => `+${name}`), ...(input.remove ?? []).map((name) => `-${name}`)].join(', ')
}

interface WriteOutcome<T> {
  result?: T
  /** The item's name, when the extension read it. */
  itemName?: string
  /** Why the write failed. */
  error?: unknown
}

/** The log entry for an agent's write, done or failed. */
export function writeActivity(
  host: string,
  request: WriteRequest,
  outcome: WriteOutcome<WriteResult>,
  agent: string | null,
  at: string
): ActivityEntry {
  const { result } = outcome
  const boardId = result?.boardId ?? request.boardId
  const itemId = result?.itemId ?? (request.op === 'create-item' ? request.parentItemId : request.itemId)
  const url = itemId ? taskUrl(host, boardId, itemId) : `https://${host}/boards/${boardId}`
  const name = outcome.itemName?.trim() || (request.op === 'create-item' ? request.name.trim() : '')
  const entry: ActivityEntry = {
    kind: request.op,
    title: name || (itemId ? `Item ${itemId}` : `Board ${boardId}`),
    url,
    at,
    agent,
    ok: result !== undefined && outcome.error === undefined,
    warnings: [],
    ...(outcome.error !== undefined ? { error: reasonOf(outcome.error) } : {})
  }

  switch (request.op) {
    case 'add-update':
      return {
        ...entry,
        body: cut(request.body),
        ...(result?.updateId ? { updateUrl: `${url}/posts/${result.updateId}` } : {}),
        ...(request.replyToUpdateId ? { replyTo: request.replyToUpdateId } : {}),
        ...(result?.mentioned?.length ? { mentioned: result.mentioned } : request.mentions?.length ? { mentioned: request.mentions } : {})
      }
    case 'update-item':
    case 'create-item': {
      // The extension sets the columns in the order given, and reports their titles in that order
      const columns = Object.entries(request.columns ?? {}).map(([key, input], index) => ({
        title: result?.columnsSet?.[index] ?? key,
        value: describeColumnInput(input)
      }))
      return {
        ...entry,
        ...(columns.length ? { columns } : {}),
        ...(result?.group ? { group: result.group.title } : request.op === 'create-item' && request.group ? { group: request.group } : {}),
        ...(result?.created?.length ? { created: result.created } : {})
      }
    }
    case 'move-item':
      return { ...entry, group: result?.group?.title ?? request.group }
    case 'edit-update':
      return {
        ...entry,
        body: cut(request.body),
        updateUrl: `${url}/posts/${request.updateId}`,
        ...(result?.mentioned?.length ? { mentioned: result.mentioned } : request.mentions?.length ? { mentioned: request.mentions } : {})
      }
    case 'delete-update':
      // The deleted text stays in the log, so the user can post it again; a failed delete keeps a link to the update
      return result?.deletedBody !== undefined
        ? { ...entry, body: cut(result.deletedBody) }
        : { ...entry, updateUrl: `${url}/posts/${request.updateId}` }
  }
}

/** The log entry for a write-back to one item, done or failed. */
export function writeBackActivity(
  request: WriteBackRequest,
  outcome: WriteOutcome<WriteBackResult>,
  agent: string | null,
  at: string
): ActivityEntry {
  const url = taskUrl(request.accountHost.toLowerCase(), request.boardId, request.itemId)
  const updateId = outcome.result?.updateId
  return {
    kind: 'write-back',
    title: outcome.itemName?.trim() || `Item ${request.itemId}`,
    url,
    at,
    agent,
    ok: outcome.result !== undefined && outcome.error === undefined,
    warnings: [],
    ...(outcome.error !== undefined ? { error: reasonOf(outcome.error) } : {}),
    body: cut(request.comment),
    ...(updateId ? { updateUrl: `${url}/posts/${updateId}` } : {}),
    ...(request.statusLabel !== undefined ? { status: request.statusLabel } : {})
  }
}

/** Reads logged before writes were: `{ title, url, at, complete, warnings, agent }`. */
export function legacyReads(value: unknown): ActivityEntry[] {
  if (!Array.isArray(value)) return []
  const entries: ActivityEntry[] = []
  for (const read of value) {
    const { title, url, at, complete, warnings, agent } = (read ?? {}) as Record<string, unknown>
    if (typeof url !== 'string' || typeof at !== 'string') continue
    entries.push({
      kind: 'read',
      title: typeof title === 'string' ? title : '',
      url,
      at,
      agent: cleanAgentName(agent),
      ok: complete !== false,
      warnings: Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === 'string') : []
    })
  }
  return entries.slice(0, MAX_ACTIVITY)
}

const LABELS: Record<ActivityKind, string> = {
  read: 'Read',
  'add-update': 'Update',
  'update-item': 'Edit',
  'create-item': 'Create',
  'move-item': 'Move',
  'edit-update': 'Edit update',
  'delete-update': 'Delete update',
  'write-back': 'Write back'
}

/** The action's short name, as its pill in the popup shows it. */
export function activityLabel(entry: ActivityEntry): string {
  return entry.kind === 'add-update' && entry.replyTo ? 'Reply' : LABELS[entry.kind]
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

/** The name the popup shows for the agent that asked. */
export function agentLabel(agent: string | null): string {
  if (!agent) return 'Unknown agent'
  return KNOWN_AGENTS.find(([pattern]) => pattern.test(agent))?.[1] ?? agent
}
