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

export interface AssignedTask {
  accountHost: string
  boardId: string
  boardName: string
  itemId: string
  title: string
  sourceUrl: string
  fields: Record<string, string>
}

export interface AssignedTasks {
  accountHost: string
  user: { id: string; name: string }
  tasks: AssignedTask[]
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
  | { type: 'list-assigned-tasks'; requestId: string; accountHost?: string; cachedHost?: string }
