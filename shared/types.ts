export interface TaskReply {
  id: string
  author: string
  createdAt: string
  body: string
}

export interface TaskUpdate extends TaskReply {
  replies: TaskReply[]
}

export interface TaskAttachment {
  id: string
  name: string
  mimeType: string
  status: 'ready' | 'unavailable'
  error?: string
}

export interface TaskSnapshot {
  sourceUrl: string
  accountHost: string
  boardId: string
  itemId: string
  title: string
  fields: Record<string, string>
  updates: TaskUpdate[]
  attachments: TaskAttachment[]
  capturedAt: string
  captureReason: 'auto' | 'manual' | 'mcp'
  complete: boolean
  warnings: string[]
}

export interface ImageUpload {
  id: string
  name: string
  mimeType: string
  dataBase64: string
}

export interface CapturePayload {
  requestId?: string
  snapshot: TaskSnapshot
  images: ImageUpload[]
}

/** One non-empty column value of an item, as its board shows it. */
export interface AssignedColumn {
  id: string
  title: string
  /** monday's column type: status, people, date, numbers, text, ... */
  type: string
  text: string
  /** The hex colour of a status label (`#00c875`); null for other columns or an unknown colour. */
  color: string | null
}

export interface AssignedTask {
  accountHost: string
  boardId: string
  boardName: string
  itemId: string
  title: string
  sourceUrl: string
  fields: Record<string, string>
  /** The item's group on its board; absent when the extension or monday's API did not give it. */
  group?: { id: string; title: string; color: string | null }
  /** The item's non-empty column values in board order; absent like `group`. */
  columns?: AssignedColumn[]
  /** Set for a subitem: its parent item, and the board that item is on (`boardId` is the hidden subitems board). */
  parentItemId?: string
  parentBoardId?: string
}

/** An active board where the user can be assigned (it has a people column), with its workspace's name. */
export interface AssignedBoard {
  id: string
  name: string
  workspace: string | null
}

export interface AssignedTasks {
  accountHost: string
  user: { id: string; name: string }
  tasks: AssignedTask[]
  /** Set only by a boards-only read: the boards to choose from, with no task read. */
  boards?: AssignedBoard[]
  warnings: string[]
  complete: boolean
  checkedAt: string
}

export interface AssignedTasksPayload {
  requestId: string
  result: AssignedTasks
}

/** What the Hub asks to write to one monday item: an update, and the Status label to set when one is given. */
export interface WriteBackRequest {
  accountHost: string
  boardId: string
  itemId: string
  comment: string
  statusLabel?: string
}

/** What the extension wrote: the update it added, and whether it set the status. */
export interface WriteBackResult {
  updateId: string | null
  statusSet: boolean
}

/**
 * A value to set in one column, written the way a person would type it: a status label, tag names, people's emails
 * or names, a date. `null` clears the column. Arrays set the whole list; `{ add, remove }` changes the current one.
 */
export type ColumnInput =
  | string
  | number
  | boolean
  | null
  | string[]
  | { add?: string[]; remove?: string[] }
  | { from: string; to: string }
  | { url: string; text?: string }

/** Column values keyed by a column's title (case does not matter) or id. */
export type ColumnInputs = Record<string, ColumnInput>

/** What an agent asks to write to monday while "Allow writing" is on in the extension popup. */
export type WriteRequest = { accountHost?: string } & (
  | {
      op: 'add-update'
      boardId: string
      itemId: string
      body: string
      replyToUpdateId?: string
      /** People to tag in the update: "me", user ids, emails or full names. */
      mentions?: string[]
    }
  | {
      op: 'update-item'
      boardId: string
      itemId: string
      columns: ColumnInputs
      createMissingLabels?: boolean
      createMissingTags?: boolean
    }
  | {
      op: 'create-item'
      boardId: string
      name: string
      /** Creates a subitem of this item (on `boardId`) instead of an item on the board. */
      parentItemId?: string
      /** The group's id or title; the board's top group without it. Not used for a subitem. */
      group?: string
      columns?: ColumnInputs
      createMissingLabels?: boolean
      createMissingTags?: boolean
    }
  | { op: 'move-item'; boardId: string; itemId: string; group: string }
)

/** What the extension wrote: the item (or update) it touched, and what changed. */
export interface WriteResult {
  op: WriteRequest['op']
  accountHost: string
  boardId: string
  itemId: string
  /** The update added, for add-update. */
  updateId?: string
  /** The names of the people tagged in the update, for add-update. */
  mentioned?: string[]
  /** The titles of the columns set, for update-item and create-item. */
  columnsSet?: string[]
  /** The group the item is in now, for move-item and create-item. */
  group?: { id: string; title: string }
  /** Tags or labels that did not exist and were created. */
  created?: string[]
}

export type WriteErrorCode = 'INVALID_TARGET' | 'WRITE_DISABLED'

export type ExtensionToBridgeMessage =
  /** `writeEnabled`: whether "Allow writing" is on in the popup; absent from an extension older than writing. */
  | { type: 'hello'; token: string; capabilities?: string[]; writeEnabled?: boolean }
  | { type: 'heartbeat' }
  | { type: 'capture-result'; requestId: string; error?: string }
  | { type: 'assigned-tasks-error'; requestId: string; error: string; code?: 'INVALID_TARGET' }
  /** The answer to a write-back: what was written, or why nothing (or not all of it) was. */
  | { type: 'write-back-result'; requestId: string; result?: WriteBackResult; error?: string; code?: 'INVALID_TARGET' }
  /** "Allow writing" was switched in the popup. */
  | { type: 'write-access'; enabled: boolean }
  /** The answer to a write: what was written, or why nothing was. */
  | { type: 'write-result'; requestId: string; result?: WriteResult; error?: string; code?: WriteErrorCode }

export type BridgeToExtensionMessage =
  | { type: 'hello-ack' }
  /** `agent` is the name the asking MCP client gave itself, shown in the popup's activity log. */
  | { type: 'capture'; requestId: string; url?: string; agent?: string }
  /** `accountHost` was asked for explicitly; `cachedHost` is the latest snapshot's, used only when no monday tab is open. */
  | {
      type: 'list-assigned-tasks'
      requestId: string
      accountHost?: string
      cachedHost?: string
      /** Read only these boards instead of every active board. */
      boardIds?: string[]
      /** List the boards to choose from, reading no task. */
      boardsOnly?: boolean
    }
  /**
   * Write to one item with the signed-in session: only ever sent for a write the bridge was asked for. `agent`, as
   * for a capture, labels the write in the popup's activity log.
   */
  | ({ type: 'write-back'; requestId: string; agent?: string } & WriteBackRequest)
  /** An agent's write; `cachedHost` is the latest snapshot's, used only when no account host was given or open. */
  | ({ type: 'write'; requestId: string; cachedHost?: string; agent?: string } & WriteRequest)
