/**
 * Listing the tasks assigned to the signed-in user through monday's GraphQL API. Kept free of Chrome
 * APIs so it can be unit-tested; the caller supplies the session-authenticated GraphQL call.
 */

import type { AssignedBoard, AssignedColumn, AssignedTask, AssignedTasks } from '../../shared/types'

/**
 * Runs one GraphQL request on `https://<host>/v2` and resolves with its `data` object. The answer is
 * typed `unknown` on purpose: every shape is checked here before use.
 */
export type Graphql = (host: string, query: string, variables: Record<string, unknown>) => Promise<unknown>

export interface AssignedTasksOptions {
  maxBoards?: number
  maxTasks?: number
  deadlineMs?: number
  /** Read only these boards (numeric ids) instead of listing every active board. */
  boardIds?: string[]
  /** List the boards the user can be assigned on, with their workspace, and read no item. */
  boardsOnly?: boolean
}

const MAX_BOARD_IDS = 50
/** Items and subitems together: with every item's subitems, a large account passes 1000 well before its last board. */
export const MAX_TASKS = 5000

const BOARD_PAGE_SIZE = 25

const INITIAL_QUERY = `query InitialAssignedTasksData($page: Int!) {
  me { id name }
  boards(limit: ${BOARD_PAGE_SIZE}, page: $page, state: active) { id name columns { id type } }
}`

const MORE_BOARDS_QUERY = `query GetMoreActiveBoards($page: Int!) {
  boards(limit: ${BOARD_PAGE_SIZE}, page: $page, state: active) { id name columns { id type } }
}`

// The board picker also names each board's workspace, and its type: monday keeps the subitems of a board on a hidden
// board of its own ("Subitems of ...", type sub_items_board), which the owner never picks. Reading items needs neither.
const INITIAL_PICKER_QUERY = `query InitialAssignableBoards($page: Int!) {
  me { id name }
  boards(limit: ${BOARD_PAGE_SIZE}, page: $page, state: active) { id name type workspace { name } columns { id type } }
}`

const MORE_PICKER_QUERY = `query GetMoreAssignableBoards($page: Int!) {
  boards(limit: ${BOARD_PAGE_SIZE}, page: $page, state: active) { id name type workspace { name } columns { id type } }
}`

const CHOSEN_BOARDS_QUERY = `query GetChosenBoards($ids: [ID!]) {
  me { id name }
  boards(ids: $ids) { id name columns { id type } }
}`

// The board view needs each item's group and typed column values with their status colours. An API that refuses
// those fields gets the plain item query instead, which is all the drafting itself needs.
const RICH_ITEM_FIELDS =
  'id name group { id title color } column_values { id type text column { title } ... on StatusValue { label_style { color } } }'
const PLAIN_ITEM_FIELDS = 'id name column_values { id text column { title } }'

// An item's subitems, which monday keeps on a hidden board of their own (the item's board's subitems board).
const RICH_SUBITEM_FIELDS =
  'subitems { id name board { id } column_values { id type text column { title } ... on StatusValue { label_style { color } } } }'
const PLAIN_SUBITEM_FIELDS = 'subitems { id name board { id } column_values { id text column { title } } }'

const boardItemsQuery = (fields: string) => `query GetBoardAssignedItems($ids: [ID!], $params: ItemsQuery) {
  boards(ids: $ids) {
    items_page(limit: 100, query_params: $params) {
      cursor
      items { ${fields} }
    }
  }
}`

const nextItemsQuery = (fields: string) => `query GetNextAssignedItems($cursor: String!) {
  next_items_page(cursor: $cursor, limit: 100) {
    cursor
    items { ${fields} }
  }
}`

interface FieldLevel {
  /** The board view's group and typed columns. */
  rich: boolean
  /** Each item's subitems. */
  subitems: boolean
  first: string
  next: string
}

/**
 * What a board read asks for, richest first. monday refusing one (an older API, a field it does not grant) steps down to
 * the next, for that board and every later one: the subitems go before the board-view fields do.
 */
const FIELD_LEVELS: readonly FieldLevel[] = [
  { rich: true, subitems: true, fields: `${RICH_ITEM_FIELDS} ${RICH_SUBITEM_FIELDS}` },
  { rich: true, subitems: false, fields: RICH_ITEM_FIELDS },
  { rich: false, subitems: true, fields: `${PLAIN_ITEM_FIELDS} ${PLAIN_SUBITEM_FIELDS}` },
  { rich: false, subitems: false, fields: PLAIN_ITEM_FIELDS },
].map(({ fields, ...level }) => ({ ...level, first: boardItemsQuery(fields), next: nextItemsQuery(fields) }))

// The subitems board of a board, named in its subitems column's settings.
const SUBITEM_BOARDS_QUERY = `query GetSubitemBoards($ids: [ID!]) {
  boards(ids: $ids) { id columns(types: [subtasks]) { id settings_str } }
}`

const SUBITEM_BOARD_COLUMNS_QUERY = `query GetSubitemBoardColumns($ids: [ID!]) {
  boards(ids: $ids) { id columns { id type } }
}`

// A subitem assigned to the user comes with its parent item, which the parent's board read may not have listed.
const assignedSubitemFields = (rich: boolean) => {
  const itemFields = rich ? RICH_ITEM_FIELDS : PLAIN_ITEM_FIELDS
  return `${itemFields} board { id } parent_item { ${itemFields} }`
}

const assignedSubitemsQuery = (rich: boolean) => `query GetAssignedSubitems($ids: [ID!], $params: ItemsQuery) {
  boards(ids: $ids) {
    items_page(limit: 100, query_params: $params) {
      cursor
      items { ${assignedSubitemFields(rich)} }
    }
  }
}`

const nextAssignedSubitemsQuery = (rich: boolean) => `query GetNextAssignedSubitems($cursor: String!) {
  next_items_page(cursor: $cursor, limit: 100) {
    cursor
    items { ${assignedSubitemFields(rich)} }
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
  const { maxBoards = 100, maxTasks = MAX_TASKS, deadlineMs = 120_000, boardIds = [], boardsOnly = false } = options
  if (!Number.isInteger(maxBoards) || maxBoards <= 0) throw new Error('maxBoards must be a positive integer')
  if (!Number.isInteger(maxTasks) || maxTasks <= 0) throw new Error('maxTasks must be a positive integer')
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error('deadlineMs must be a positive number')
  if (boardIds.length > MAX_BOARD_IDS) throw new Error(`boardIds may name at most ${MAX_BOARD_IDS} boards`)
  if (boardIds.some((id) => readId(id) === null)) throw new Error('boardIds must be numeric monday board ids')
  if (boardsOnly && boardIds.length > 0) throw new Error('boardsOnly and boardIds cannot be combined')
  return { maxBoards, maxTasks, deadlineMs, boardIds, boardsOnly }
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

const HEX_COLOR = /^#[0-9a-f]{6}$/i
// Group and column ids are monday's own keys (`topics`, `status_1`); anything else is dropped.
const KEY = /^[A-Za-z0-9_-]{1,128}$/

/** A colour only as `#rrggbb`, so the Hub never paints with anything monday did not say. */
function readColor(value: unknown): string | null {
  const color = readText(value)
  return HEX_COLOR.test(color) ? color.toLowerCase() : null
}

function readGroup(value: unknown): AssignedTask['group'] {
  if (!isObject(value)) return undefined
  const id = readText(value.id)
  if (!KEY.test(id)) return undefined
  return { id, title: readText(value.title), color: readColor(value.color) }
}

/** The non-empty column values in the order monday lists them, which is the board's column order. */
function readColumns(value: unknown): AssignedColumn[] {
  const columns: AssignedColumn[] = []
  for (const columnValue of asArray(value) ?? []) {
    if (!isObject(columnValue)) continue
    const id = readText(columnValue.id)
    const text = readText(columnValue.text)
    if (!KEY.test(id) || !text) continue
    const title = isObject(columnValue.column) ? readText(columnValue.column.title) : ''
    const style = isObject(columnValue.label_style) ? columnValue.label_style : null
    columns.push({ id, title: title || id, type: readText(columnValue.type), text, color: readColor(style?.color) })
  }
  return columns
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface Board {
  id: string
  name: string
  /** monday's board type (board, sub_items_board, document, ...); empty when the answer did not say. */
  type: string
  workspace: string | null
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
  const workspace = isObject(value.workspace) ? readText(value.workspace.name) : ''
  return { id, name: readText(value.name), type: readText(value.type), workspace: workspace || null, peopleColumnIds }
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

/** The people-column rule that makes monday return only the items assigned to the user. */
function assignedToMe(peopleColumnIds: readonly string[]) {
  return {
    operator: 'or',
    rules: peopleColumnIds.map((columnId) => ({
      column_id: columnId,
      compare_value: ['assigned_to_me'],
      operator: 'any_of'
    }))
  }
}

/** The subitems board ids a subitems column's settings name, as `{"boardIds":[123]}`. */
function subitemBoardIds(settings: unknown): string[] {
  if (typeof settings !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(settings)
    const ids = isObject(parsed) ? asArray(parsed.boardIds) : null
    return (ids ?? []).map(readId).filter((id): id is string => id !== null)
  } catch {
    return []
  }
}

/**
 * Every item on the user's active boards where any people column contains them, filtered by monday
 * (`assigned_to_me`) so unassigned items are never downloaded, each followed by its subitems. On chosen boards, the
 * subitems assigned to the user are read too, with their parent item when the board read did not list it.
 * Read-only: only queries are sent. A failing board becomes a warning; only a failing user query rejects.
 */
export async function readAssignedTasks(
  host: string,
  graphql: Graphql,
  options?: AssignedTasksOptions
): Promise<AssignedTasks> {
  const accountHost = validateHost(host)
  const { maxBoards, maxTasks, deadlineMs, boardIds, boardsOnly } = validateOptions(options)
  const deadline = Date.now() + deadlineMs

  const warnings: string[] = []
  let complete = true
  const incomplete = (warning: string) => {
    complete = false
    if (!warnings.includes(warning)) warnings.push(warning)
  }
  const deadlineWarning = `Stopped after the ${deadlineMs} ms time limit; remaining boards were not checked`
  const taskCapWarning = `Stopped at ${maxTasks} tasks; more assigned tasks may exist`

  const chosen = boardIds.length > 0
  const initial = chosen
    ? await graphql(accountHost, CHOSEN_BOARDS_QUERY, { ids: boardIds })
    : await graphql(accountHost, boardsOnly ? INITIAL_PICKER_QUERY : INITIAL_QUERY, { page: 1 })
  const me = isObject(initial) ? initial.me : null
  const userId = isObject(me) ? readId(me.id) : null
  if (!isObject(me) || !userId) throw new Error('monday API: authenticated user not found')
  const user = { id: userId, name: readText(me.name) }

  const boards = [...boardList(initial)]
  // Chosen boards come in one answer; only a listing of every active board pages.
  let lastPageSize = chosen ? 0 : boards.length
  let boardPage = 1
  while (lastPageSize === BOARD_PAGE_SIZE) {
    if (boards.length >= maxBoards) break
    if (Date.now() >= deadline) {
      incomplete(deadlineWarning)
      break
    }
    boardPage++
    try {
      const more = boardList(await graphql(accountHost, boardsOnly ? MORE_PICKER_QUERY : MORE_BOARDS_QUERY, { page: boardPage }))
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

  if (boardsOnly) {
    const assignable: AssignedBoard[] = []
    for (const value of boards) {
      const board = parseBoard(value)
      if (!board) {
        incomplete('Skipped a board with an unexpected shape')
        continue
      }
      // Only real boards: a subitems board or a doc is never offered, and nobody can be assigned without a people column
      const realBoard = board.type === '' || board.type === 'board'
      if (realBoard && board.peopleColumnIds.length) {
        assignable.push({ id: board.id, name: board.name, workspace: board.workspace })
      }
    }
    return { accountHost, user, tasks: [], boards: assignable, warnings, complete, checkedAt: new Date().toISOString() }
  }

  const tasks: AssignedTask[] = []
  const seen = new Set<string>()
  // What monday answers for a board read; its first refusal steps down to the next level for good.
  let level = 0
  const fields = () => FIELD_LEVELS[level] as FieldLevel
  // The subitems boards seen while reading, by the board their items are on.
  const subitemBoards = new Map<string, Set<string>>()

  /** One item (or subitem) as a task; null when the task cap stops the read, undefined when it is skipped. */
  const addTask = (
    board: Board,
    value: JsonObject,
    itemBoardId: string,
    parent?: { itemId: string; group: AssignedTask['group'] }
  ): AssignedTask | null | undefined => {
    const itemId = readId(value.id)
    if (!itemId) {
      incomplete(`Skipped an item with an unexpected shape on board ${board.id}`)
      return undefined
    }
    const key = `${itemBoardId}:${itemId}`
    if (seen.has(key)) return undefined
    if (tasks.length >= maxTasks) {
      incomplete(taskCapWarning)
      return null
    }
    seen.add(key)
    // A subitem is drawn in its parent's group, as monday shows it.
    const group = parent === undefined ? readGroup(value.group) : parent.group
    const task: AssignedTask = {
      accountHost,
      boardId: itemBoardId,
      boardName: board.name,
      itemId,
      title: readText(value.name),
      sourceUrl: `https://${accountHost}/boards/${itemBoardId}/pulses/${itemId}`,
      fields: readFields(value.column_values),
      ...(group === undefined ? {} : { group }),
      ...(fields().rich ? { columns: readColumns(value.column_values) } : {}),
      ...(parent === undefined ? {} : { parentItemId: parent.itemId, parentBoardId: board.id })
    }
    tasks.push(task)
    return task
  }

  /** An item's subitems right after it; false once the task cap stops the read. */
  const addSubitems = (board: Board, item: AssignedTask, value: JsonObject): boolean => {
    for (const subitem of asArray(value.subitems) ?? []) {
      const subitemBoardId = isObject(subitem) && isObject(subitem.board) ? readId(subitem.board.id) : null
      if (!isObject(subitem) || !subitemBoardId) {
        incomplete(`Skipped a subitem with an unexpected shape on board ${board.id}`)
        continue
      }
      const boards = subitemBoards.get(board.id) ?? new Set<string>()
      subitemBoards.set(board.id, boards.add(subitemBoardId))
      if (addTask(board, subitem, subitemBoardId, { itemId: item.itemId, group: item.group }) === null) return false
    }
    return true
  }

  /** Adds new items of one page, each with its subitems; false once the task cap stops the read. */
  const addItems = (board: Board, items: unknown[]): boolean => {
    for (const value of items) {
      if (!isObject(value)) {
        incomplete(`Skipped an item with an unexpected shape on board ${board.id}`)
        continue
      }
      const item = addTask(board, value, board.id)
      if (item === null) return false
      if (item !== undefined && fields().subitems && !addSubitems(board, item, value)) return false
    }
    return true
  }

  /** Reads every page of one board; false when a cap means no further board should be read. */
  const readBoard = async (board: Board): Promise<boolean> => {
    const params = assignedToMe(board.peopleColumnIds)
    let page: ItemsPage
    for (;;) {
      try {
        page = firstBoardItemsPage(await graphql(accountHost, fields().first, { ids: [board.id], params }))
        break
      } catch (err) {
        if (level === FIELD_LEVELS.length - 1) throw err
        // monday refused some of the fields: read this and every later board with fewer.
        level += 1
      }
    }
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
      page = nextItemsPage(await graphql(accountHost, fields().next, { cursor: page.cursor }))
    }
  }

  /**
   * The subitems assigned to the user on a chosen board's subitems boards, each after its parent item, which is added
   * when the board read did not list it (the parent is assigned to someone else). False when a cap stops the read.
   */
  const readAssignedSubitems = async (board: Board): Promise<boolean> => {
    const boardIds = new Set(subitemBoards.get(board.id) ?? [])
    try {
      const [answer] = boardList(await graphql(accountHost, SUBITEM_BOARDS_QUERY, { ids: [board.id] }))
      for (const column of (isObject(answer) ? asArray(answer.columns) : null) ?? []) {
        if (isObject(column)) for (const id of subitemBoardIds(column.settings_str)) boardIds.add(id)
      }
    } catch (err) {
      // Without the settings, the subitems boards the board read saw are still checked.
      if (boardIds.size === 0) {
        incomplete(`Could not find the subitems of board ${board.id} (${board.name}): ${errorMessage(err)}`)
        return true
      }
    }
    if (boardIds.size === 0) return true

    const subBoards = boardList(await graphql(accountHost, SUBITEM_BOARD_COLUMNS_QUERY, { ids: [...boardIds] }))
      .map(parseBoard)
      .filter((value): value is Board => value !== null && value.peopleColumnIds.length > 0)
    for (const subBoard of subBoards) {
      const params = assignedToMe(subBoard.peopleColumnIds)
      let page = firstBoardItemsPage(await graphql(accountHost, assignedSubitemsQuery(fields().rich), { ids: [subBoard.id], params }))
      const cursors = new Set<string>()
      for (;;) {
        for (const value of page.items) {
          const parentValue = isObject(value) ? value.parent_item : null
          const parentId = isObject(parentValue) ? readId(parentValue.id) : null
          if (!isObject(value) || !isObject(parentValue) || !parentId) {
            incomplete(`Skipped a subitem with an unexpected shape on board ${subBoard.id}`)
            continue
          }
          // The parent first, unless the board read listed it already.
          const known = tasks.find((task) => task.boardId === board.id && task.itemId === parentId)
          const parent = known ?? addTask(board, parentValue, board.id)
          if (parent === null) return false
          const group = parent === undefined ? readGroup(parentValue.group) : parent.group
          if (addTask(board, value, subBoard.id, { itemId: parentId, group }) === null) return false
        }
        if (!page.cursor || cursors.has(page.cursor)) return true
        cursors.add(page.cursor)
        if (Date.now() >= deadline) {
          incomplete(deadlineWarning)
          return false
        }
        page = nextItemsPage(await graphql(accountHost, nextAssignedSubitemsQuery(fields().rich), { cursor: page.cursor }))
      }
    }
    return true
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
      continue
    }
    // Only a chosen board costs the extra reads of its assigned subitems.
    if (!chosen || !fields().subitems) continue
    try {
      if (!(await readAssignedSubitems(board))) break
    } catch (err) {
      incomplete(`Could not read the subitems assigned to you on board ${board.id} (${board.name}): ${errorMessage(err)}`)
    }
  }

  return { accountHost, user, tasks, warnings, complete, checkedAt: new Date().toISOString() }
}
