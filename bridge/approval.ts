/**
 * bridge/approval.ts – the permission rules that let agent CLIs run the bridge's read tools without asking.
 *
 * Each function takes a CLI's config text and returns it with the rules added (`auto`) or removed (`manual`).
 * Only the read tools get a rule: monday_write_back always asks.
 */

export type ApprovalMode = 'auto' | 'manual'
export type ApprovalState = ApprovalMode | 'partial'

export const SERVER_NAME = 'monday-task-bridge'

export const READ_TOOLS = [
  'monday_read_task',
  'monday_read_open_task',
  'monday_list_assigned_tasks',
  'monday_list_boards',
  'monday_get_task',
  'monday_get_image',
  'monday_list_tasks',
  'monday_bridge_status',
] as const

/** Claude Code settings.json: permissions.allow entries `mcp__<server>__<tool>`. */
export const claudeRules = READ_TOOLS.map((tool) => `mcp__${SERVER_NAME}__${tool}`)

/** agy (Antigravity CLI) settings.json: permissions.allow entries `mcp(<server>/<tool>)`. */
export const agyRules = READ_TOOLS.map((tool) => `mcp(${SERVER_NAME}/${tool})`)

interface PermissionSettings {
  permissions?: { allow?: unknown[] } & Record<string, unknown>
  [key: string]: unknown
}

function parseSettings(text: string): PermissionSettings {
  if (!text.trim()) return {}
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings are not a JSON object')
  return parsed as PermissionSettings
}

/** Adds or removes `rules` in a JSON settings file's permissions.allow; every other setting stays as it is. */
export function applyAllowRules(text: string, rules: readonly string[], mode: ApprovalMode): string {
  const settings = parseSettings(text)
  const allow = (settings.permissions?.allow ?? []).filter((rule) => !rules.includes(rule as string))
  if (mode === 'auto') allow.push(...rules)
  settings.permissions = { ...settings.permissions, allow }
  return JSON.stringify(settings, null, 2) + '\n'
}

function stateOf(found: number, total: number): ApprovalState {
  return found === 0 ? 'manual' : found === total ? 'auto' : 'partial'
}

export function allowRulesState(text: string, rules: readonly string[]): ApprovalState {
  const allow = parseSettings(text).permissions?.allow ?? []
  return stateOf(rules.filter((rule) => allow.includes(rule)).length, rules.length)
}

// Codex config.toml: one table per tool, `[mcp_servers.<server>.tools.<tool>]` with `approval_mode = "approve"`.

const SERVER_KEY = `(?:${SERVER_NAME}|"${SERVER_NAME}")`
const SERVER_TABLE = new RegExp(`^\\s*\\[\\s*mcp_servers\\.${SERVER_KEY}\\s*\\]`, 'm')
const TOOL_TABLE = new RegExp(`^\\s*\\[\\s*mcp_servers\\.${SERVER_KEY}\\.tools\\.(?:"([\\w-]+)"|([\\w-]+))\\s*\\]`)
const ANY_TABLE = /^\s*\[/

/** True when config.toml registers the server; a tool table without it would be a server with no command. */
export function codexHasServer(text: string): boolean {
  return SERVER_TABLE.test(text)
}

function readToolOf(line: string): string | undefined {
  const match = TOOL_TABLE.exec(line)
  const tool = match?.[1] ?? match?.[2]
  return tool && (READ_TOOLS as readonly string[]).includes(tool) ? tool : undefined
}

export function applyCodexRules(text: string, mode: ApprovalMode): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const kept: string[] = []
  let skipping = false
  for (const line of text.split(/\r?\n/)) {
    if (ANY_TABLE.test(line)) skipping = readToolOf(line) !== undefined
    if (!skipping) kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  if (mode === 'auto') {
    for (const tool of READ_TOOLS) {
      kept.push('', `[mcp_servers.${SERVER_NAME}.tools.${tool}]`, 'approval_mode = "approve"')
    }
  }
  return kept.join(eol) + eol
}

export function codexRulesState(text: string): ApprovalState {
  const approved = new Set<string>()
  let tool: string | undefined
  for (const line of text.split(/\r?\n/)) {
    if (ANY_TABLE.test(line)) tool = readToolOf(line)
    else if (tool && /^\s*approval_mode\s*=\s*"approve"/.test(line)) approved.add(tool)
  }
  return stateOf(approved.size, READ_TOOLS.length)
}
