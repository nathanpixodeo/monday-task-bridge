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

export type ExtensionToBridgeMessage =
  | { type: 'hello'; token: string }
  | { type: 'heartbeat' }
  | { type: 'capture-result'; requestId: string; error?: string }

export type BridgeToExtensionMessage =
  | { type: 'hello-ack' }
  | { type: 'capture'; requestId: string; url?: string }
