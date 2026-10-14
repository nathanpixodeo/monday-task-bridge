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

export type ExtensionToBridgeMessage =
  | { type: 'hello'; token: string; capabilities?: string[] }
  | { type: 'heartbeat' }
  | { type: 'capture-result'; requestId: string; error?: string }
  | { type: 'assigned-tasks-error'; requestId: string; error: string; code?: 'INVALID_TARGET' }

export type BridgeToExtensionMessage =
  | { type: 'hello-ack' }
  | { type: 'capture'; requestId: string; url?: string }
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
