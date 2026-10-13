/**
 * Listing the tasks assigned to the signed-in user through monday's GraphQL API. Kept free of Chrome
 * APIs so it can be unit-tested; the caller supplies the session-authenticated GraphQL call.
 */

import type { AssignedTask, AssignedTasks } from '../../shared/types'

/**
 * Runs one GraphQL request on `https://<host>/v2` and resolves with its `data` object. The answer is
 * typed `unknown` on purpose: every shape is checked here before use.
 */
export type Graphql = (host: string, query: string, variables: Record<string, unknown>) => Promise<unknown>

export interface AssignedTasksOptions {
  maxBoards?: number
  maxTasks?: number
  deadlineMs?: number
}

const BOARD_PAGE_SIZE = 25

const INITIAL_QUERY = `query InitialAssignedTasksData($page: Int!) {
  me { id name }
  boards(limit: ${BOARD_PAGE_SIZE}, page: $page, state: active) { id name columns { id type } }
}`

const MORE_BOARDS_QUERY = `query GetMoreActiveBoards($page: Int!) {
  boards(limit: ${BOARD_PAGE_SIZE}, page: $page, state: active) { id name columns { id type } }
}`

const BOARD_ITEMS_QUERY = `query GetBoardAssignedItems($ids: [ID!], $params: ItemsQuery) {
  boards(ids: $ids) {
    items_page(limit: 100, query_params: $params) {
      cursor
      items { id name column_values { id text column { title } } }
    }
  }
}`

const NEXT_ITEMS_QUERY = `query GetNextAssignedItems($cursor: String!) {
  next_items_page(cursor: $cursor, limit: 100) {
    cursor
    items { id name column_values { id text column { title } } }
  }
}`

/** Only `<sub>.monday.com` with no scheme, path, port or credentials, so requests cannot leave monday. */
function validateHost(host: string): string {
  const trimmed = host.trim()
  if (!trimmed) throw new Error('Host cannot be empty')
  if (/[\/:@?#\\\s]/.test(trimmed)) {
    throw new Error('Host contains invalid characters (slash, port, credentials, or whitespace)')
  }
  const lower = trimmed.toLowerCase()
  if (!lower.endsWith('.monday.com')) throw new Error('Host must be a strict subdomain of monday.com')
  for (const label of lower.slice(0, -'.monday.com'.length).split('.')) {
    if (!label || label.length > 63) throw new Error(`Invalid subdomain label: "${label}"`)
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new Error(`Invalid subdomain label format: "${label}"`)
    }
  }
  return lower
}

function validateOptions(options: AssignedTasksOptions = {}): Required<AssignedTasksOptions> {
  const { maxBoards = 100, maxTasks = 1000, deadlineMs = 120_000 } = options
  if (!Number.isInteger(maxBoards) || maxBoards <= 0) throw new Error('maxBoards must be a positive integer')
  if (!Number.isInteger(maxTasks) || maxTasks <= 0) throw new Error('maxTasks must be a positive integer')
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error('deadlineMs must be a positive number')
  return { maxBoards, maxTasks, deadlineMs }
}

// ─── Response narrowing ──────────────────────────────────────────────

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

/** monday IDs are numeric. They become URL path segments, so anything else is rejected. */
function readId(value: unknown): string | null {
  const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  return /^\d+$/.test(id) ? id : null
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface Board {
  id: string
  name: string
  peopleColumnIds: string[]
}

interface ItemsPage {
  cursor: string | null
  items: unknown[]
}

function boardList(data: unknown): unknown[] {
  const boards = isObject(data) ? asArray(data.boards) : null
  if (!boards) throw new Error('monday API: unexpected boards response')
  return boards
}

function parseBoard(value: unknown): Board | null {
  if (!isObject(value)) return null
  const id = readId(value.id)
  const columns = asArray(value.columns)
  if (!id || !columns) return null
  const peopleColumnIds: string[] = []
  for (const column of columns) {
    if (isObject(column) && column.type === 'people' && typeof column.id === 'string' && column.id) {
      peopleColumnIds.push(column.id)
    }
  }
  return { id, name: readText(value.name), peopleColumnIds }
}

function parseItemsPage(value: unknown): ItemsPage {
  const items = isObject(value) ? asArray(value.items) : null
  if (!isObject(value) || !items) throw new Error('monday API: unexpected items page')
  const { cursor } = value
  if (typeof cursor === 'string') return { cursor: cursor.trim() || null, items }
  if (cursor === null || cursor === undefined) return { cursor: null, items }
  throw new Error('monday API: unexpected items page cursor')
}

function firstBoardItemsPage(data: unknown): ItemsPage {
  const [board] = boardList(data)
  if (!isObject(board)) throw new Error('monday API: board not returned')
  return parseItemsPage(board.items_page)
}

function nextItemsPage(data: unknown): ItemsPage {
  if (!isObject(data)) throw new Error('monday API: unexpected next items page')
  return parseItemsPage(data.next_items_page)
}

/** Column title to text, skipping empty columns like a task snapshot does. */
function readFields(value: unknown): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const columnValue of asArray(value) ?? []) {
    if (!isObject(columnValue)) continue
    const text = readText(columnValue.text)
    const title = isObject(columnValue.column) ? readText(columnValue.column.title) : ''
    const key = title || readText(columnValue.id)
    if (text && key) fields[key] = text
  }
  return fields
}

// ─── Reader ──────────────────────────────────────────────────────────

/**
 * Every item on the user's active boards where any people column contains them, filtered by monday
 * (`assigned_to_me`) so unassigned items are never downloaded. Read-only: only queries are sent.
 * A failing board becomes a warning; only a failing user query rejects.
 */
export async function readAssignedTasks(
  host: string,
  graphql: Graphql,
  options?: AssignedTasksOptions
): Promise<AssignedTasks> {
  const accountHost = validateHost(host)
  const { maxBoards, maxTasks, deadlineMs } = validateOptions(options)
  const deadline = Date.now() + deadlineMs

  const warnings: string[] = []
  let complete = true
  const incomplete = (warning: string) => {
    complete = false
    if (!warnings.includes(warning)) warnings.push(warning)
  }
  const deadlineWarning = `Stopped after the ${deadlineMs} ms time limit; remaining boards were not checked`
  const taskCapWarning = `Stopped at ${maxTasks} tasks; more assigned tasks may exist`

  const initial = await graphql(accountHost, INITIAL_QUERY, { page: 1 })
  const me = isObject(initial) ? initial.me : null
  const userId = isObject(me) ? readId(me.id) : null
  if (!isObject(me) || !userId) throw new Error('monday API: authenticated user not found')
  const user = { id: userId, name: readText(me.name) }

  const boards = [...boardList(initial)]
  let lastPageSize = boards.length
  let boardPage = 1
  while (lastPageSize === BOARD_PAGE_SIZE) {
    if (boards.length >= maxBoards) break
    if (Date.now() >= deadline) {
      incomplete(deadlineWarning)
      break
    }
    boardPage++
    try {
      const more = boardList(await graphql(accountHost, MORE_BOARDS_QUERY, { page: boardPage }))
      boards.push(...more)
      lastPageSize = more.length
    } catch (err) {
      incomplete(`Could not list boards page ${boardPage}: ${errorMessage(err)}`)
      break
    }
  }
  // A full last page means monday may hold more boards than were listed
  if (boards.length > maxBoards || (boards.length === maxBoards && lastPageSize === BOARD_PAGE_SIZE)) {
    incomplete(`Checked only the first ${maxBoards} active boards`)
    boards.length = Math.min(boards.length, maxBoards)
  }

  const tasks: AssignedTask[] = []
  const seen = new Set<string>()

  /** Adds new items of one page; false once the task cap stops the read. */
  const addItems = (board: Board, items: unknown[]): boolean => {
    for (const value of items) {
      const itemId = isObject(value) ? readId(value.id) : null
      if (!isObject(value) || !itemId) {
        incomplete(`Skipped an item with an unexpected shape on board ${board.id}`)
        continue
      }
      const key = `${board.id}:${itemId}`
      if (seen.has(key)) continue
      if (tasks.length >= maxTasks) {
        incomplete(taskCapWarning)
        return false
      }
      seen.add(key)
      tasks.push({
        accountHost,
        boardId: board.id,
        boardName: board.name,
        itemId,
        title: readText(value.name),
        sourceUrl: `https://${accountHost}/boards/${board.id}/pulses/${itemId}`,
        fields: readFields(value.column_values)
      })
    }
    return true
  }

  /** Reads every page of one board; false when a cap means no further board should be read. */
  const readBoard = async (board: Board): Promise<boolean> => {
    const params = {
      operator: 'or',
      rules: board.peopleColumnIds.map((columnId) => ({
        column_id: columnId,
        compare_value: ['assigned_to_me'],
        operator: 'any_of'
      }))
    }
    let page = firstBoardItemsPage(await graphql(accountHost, BOARD_ITEMS_QUERY, { ids: [board.id], params }))
    const cursors = new Set<string>()
    for (;;) {
      if (!addItems(board, page.items)) return false
      if (!page.cursor) return true
      if (cursors.has(page.cursor)) {
        incomplete(`Repeated cursor detected on board ${board.id}; its remaining items were not read`)
        return true
      }
      cursors.add(page.cursor)
      if (Date.now() >= deadline) {
        incomplete(deadlineWarning)
        return false
      }
      page = nextItemsPage(await graphql(accountHost, NEXT_ITEMS_QUERY, { cursor: page.cursor }))
    }
  }

  for (const value of boards) {
    const board = parseBoard(value)
    if (!board) {
      incomplete('Skipped a board with an unexpected shape')
      continue
    }
    // Nobody can be assigned on a board without a people column, so it costs no request
    if (!board.peopleColumnIds.length) continue
    if (Date.now() >= deadline) {
      incomplete(deadlineWarning)
      break
    }
    if (tasks.length >= maxTasks) {
      incomplete(taskCapWarning)
      break
    }
    try {
      if (!(await readBoard(board))) break
    } catch (err) {
      incomplete(`Could not read board ${board.id} (${board.name}): ${errorMessage(err)}`)
    }
  }

  return { accountHost, user, tasks, warnings, complete, checkedAt: new Date().toISOString() }
}
