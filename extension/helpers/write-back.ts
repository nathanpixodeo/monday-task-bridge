/**
 * Writing back to one monday item for Nexkit Agent Hub, once the Hub task made from it is done: the Status label the
 * owner named, then an update. Kept free of Chrome APIs so it can be unit-tested; the caller supplies the
 * session-authenticated GraphQL call.
 */

import type { WriteBackRequest, WriteBackResult } from '../../shared/types'
import type { Graphql } from './assigned-tasks'

const ITEM_QUERY = `query WriteBackItem($ids: [ID!]) {
  items(ids: $ids) { id board { id columns { id title type } } }
}`

const SET_STATUS = `mutation WriteBackStatus($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String) {
  change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
}`

const CREATE_UPDATE = `mutation WriteBackUpdate($itemId: ID!, $body: String!) {
  create_update(item_id: $itemId, body: $body) { id }
}`

/** The item is not one this account can write to; the bridge reports it as INVALID_TARGET. */
export class WriteBackTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WriteBackTargetError'
  }
}

interface ApiColumn {
  id: string
  title: string
  type: string
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** monday shows an update's body as HTML: the text is escaped and its lines are kept. */
export function updateBody(comment: string): string {
  return escapeHtml(comment).split(/\r?\n/).join('<br>')
}

/** The board's column titled Status, else its first status column (older API versions call the type `color`). */
function statusColumn(columns: ApiColumn[]): ApiColumn | undefined {
  const statuses = columns.filter((column) => column.type === 'status' || column.type === 'color')
  return statuses.find((column) => column.title.trim().toLowerCase() === 'status') ?? statuses[0]
}

function isColumn(value: unknown): value is ApiColumn {
  const column = value as Partial<ApiColumn> | null
  return !!column && typeof column.id === 'string' && typeof column.title === 'string' && typeof column.type === 'string'
}

const idOf = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null

function readItem(data: unknown): { boardId: string; columns: ApiColumn[] } | null {
  const items = (data as { items?: unknown } | null)?.items
  if (!Array.isArray(items) || items.length === 0) return null
  const board = (items[0] as { board?: { id?: unknown; columns?: unknown } | null } | null)?.board
  const boardId = idOf(board?.id)
  if (!board || boardId === null) return null
  return { boardId, columns: Array.isArray(board.columns) ? board.columns.filter(isColumn) : [] }
}

/**
 * Sets the status first, so a label the board does not have stops the write before anything is written; then adds the
 * update. Nothing is retried: the Hub writes back once per task.
 */
export async function writeBackToItem(graphql: Graphql, request: WriteBackRequest): Promise<WriteBackResult> {
  const { accountHost: host, boardId, itemId, statusLabel } = request
  const item = readItem(await graphql(host, ITEM_QUERY, { ids: [itemId] }))
  if (item === null) throw new WriteBackTargetError(`monday item ${itemId} was not found, or this account cannot see it`)
  if (item.boardId !== boardId) throw new WriteBackTargetError(`monday item ${itemId} is on board ${item.boardId}, not on board ${boardId}`)

  let statusSet = false
  if (statusLabel !== undefined) {
    const column = statusColumn(item.columns)
    if (column === undefined) throw new Error(`Board ${boardId} has no status column to set to "${statusLabel}"`)
    try {
      await graphql(host, SET_STATUS, { boardId, itemId, columnId: column.id, value: statusLabel })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`Could not set ${column.title} to "${statusLabel}", so nothing was written: ${reason}`)
    }
    statusSet = true
  }

  try {
    const created = await graphql(host, CREATE_UPDATE, { itemId, body: updateBody(request.comment) })
    return { updateId: idOf((created as { create_update?: { id?: unknown } | null } | null)?.create_update?.id), statusSet }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(statusSet ? `Set the status to "${statusLabel}", but could not add the update: ${reason}` : reason)
  }
}
