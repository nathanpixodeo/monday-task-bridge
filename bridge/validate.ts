/**
 * bridge/validate.ts – Zod schemas and validation helpers for request validation.
 */

import { z } from 'zod'

// Allowed image MIME types: png, jpeg, gif, webp only (SVG is strictly rejected)
export const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type AllowedImageMime = typeof ALLOWED_IMAGE_MIMES[number]

/**
 * Detect image MIME type strictly from actual magic bytes.
 * Accepts only PNG, JPEG, GIF, and WEBP. Rejects SVG and all other formats.
 */
export function detectImageMime(buf: Buffer): AllowedImageMime | null {
  if (buf.length < 12) return null

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png'
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg'
  }

  // GIF: GIF87a or GIF89a (47 49 46 38 37/39 61)
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif'
  }

  // WEBP: RIFF (bytes 0..3) ... WEBP (bytes 8..11)
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp'
  }

  return null
}

/**
 * Validate that an ID is safe against path traversal and malformed inputs.
 */
export function isValidId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  const trimmed = id.trim()
  if (!trimmed || trimmed.length > 256) return false
  if (
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    return false
  }
  return true
}

// Loose check for base64 characters
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

const MAX_IMAGE_BYTES = 25 * 1024 * 1024 // 25 MB per image
const MAX_PAYLOAD_IMAGES = 50

export const ImageUploadSchema = z
  .object({
    id: z.string().min(1).max(256).refine(isValidId, { message: 'Invalid image ID format' }),
    name: z.string().min(1).max(512),
    mimeType: z.enum(ALLOWED_IMAGE_MIMES, { message: 'Unsupported MIME type: only png, jpeg, gif, webp allowed' }),
    dataBase64: z.string().min(1).refine(v => BASE64_RE.test(v.slice(0, 200)), { message: 'Invalid base64 data' }),
  })
  .superRefine((img, ctx) => {
    // Explicitly reject SVG filenames and MIME
    const lowerName = img.name.toLowerCase()
    if (lowerName.endsWith('.svg') || img.mimeType.includes('svg')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SVG images are strictly prohibited',
      })
      return
    }

    let buf: Buffer
    try {
      buf = Buffer.from(img.dataBase64, 'base64')
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid base64 encoding',
      })
      return
    }

    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Image size out of bounds (1..${MAX_IMAGE_BYTES} bytes)`,
      })
      return
    }

    const detected = detectImageMime(buf)
    if (!detected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Image content magic bytes do not match allowed formats (png, jpeg, gif, webp)',
      })
      return
    }

    if (detected !== img.mimeType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Image magic bytes (${detected}) do not match declared MIME type (${img.mimeType})`,
      })
      return
    }
  })

export const TaskReplySchema = z.object({
  id: z.string().max(256),
  author: z.string().max(256),
  createdAt: z.string().max(128),
  body: z.string().max(50_000),
})

export const TaskUpdateSchema = TaskReplySchema.extend({
  replies: z.array(TaskReplySchema).max(100),
})

export const TaskAttachmentSchema = z.object({
  id: z.string().min(1).max(256).refine(isValidId, { message: 'Invalid attachment ID format' }),
  name: z.string().min(1).max(512),
  mimeType: z.string().max(128),
  status: z.enum(['ready', 'unavailable']),
  error: z.string().max(1024).optional(),
})

export const TaskSnapshotSchema = z.object({
  sourceUrl: z.string().max(2048),
  accountHost: z.string().max(256),
  boardId: z.string().max(128),
  itemId: z.string().max(128),
  title: z.string().max(1000),
  fields: z.record(z.string().max(256), z.string().max(10_000)),
  updates: z.array(TaskUpdateSchema).max(500),
  attachments: z.array(TaskAttachmentSchema).max(100),
  capturedAt: z.string().max(128),
  captureReason: z.enum(['auto', 'manual', 'mcp']),
  complete: z.boolean(),
  warnings: z.array(z.string().max(1000)).max(100),
})

export const CapturePayloadSchema = z
  .object({
    requestId: z.string().min(1).max(256).refine(isValidId, { message: 'Invalid request ID format' }).optional(),
    snapshot: TaskSnapshotSchema,
    images: z.array(ImageUploadSchema).max(MAX_PAYLOAD_IMAGES),
  })
  .superRefine((payload, ctx) => {
    const uploadedIds = new Set(payload.images.map(img => img.id))

    // Ensure every ready attachment has matching uploaded image
    for (const att of payload.snapshot.attachments) {
      if (att.status === 'ready') {
        if (!uploadedIds.has(att.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Ready attachment '${att.id}' has no matching uploaded image`,
          })
        }
      }
    }

    // Completeness is downgraded by the HTTP handler after validation so a
    // partial task can still be stored and reported to the agent.
  })

export const PairRequestBodySchema = z.object({
  secret: z.string().min(1).max(256),
})

export const PairApproveBodySchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Code must be exactly 6 digits'),
})

export const ReadTaskBodySchema = z.object({
  url: z.string().max(2048).optional(),
  boardId: z.string().regex(/^\d{1,20}$/).optional(),
  itemId: z.string().regex(/^\d{1,20}$/).optional(),
  accountHost: z.string().regex(/^[a-z0-9-]+\.monday\.com$/i).optional(),
})

const MONDAY_HOST_RE = /^[a-z0-9-]+\.monday\.com$/i
const TASK_PATH_RE = /\/boards\/\d+(?:\/views\/\d+)?\/pulses\/\d+/

/**
 * Turn a read-task request into a canonical https monday.com task URL so the
 * extension never opens a tab on an arbitrary host.
 */
export function resolveTaskUrl(
  body: z.infer<typeof ReadTaskBodySchema>,
  fallbackHost: string | null
): { url: string } | { error: string } {
  if (body.url) {
    let u: URL
    try {
      u = new URL(body.url)
    } catch {
      return { error: 'Invalid task url' }
    }
    if (u.protocol !== 'https:' || !MONDAY_HOST_RE.test(u.hostname) || !TASK_PATH_RE.test(u.pathname)) {
      return { error: 'Not a monday.com task url' }
    }
    return { url: u.toString() }
  }

  if (body.boardId && body.itemId) {
    const host = body.accountHost ?? fallbackHost
    if (!host || !MONDAY_HOST_RE.test(host)) {
      return { error: 'Unknown monday account host: pass accountHost or a full task URL' }
    }
    return { url: `https://${host}/boards/${body.boardId}/pulses/${body.itemId}` }
  }

  return { error: 'Pass a task url, or boardId and itemId' }
}

export const MAX_CAPTURE_BYTES = 100 * 1024 * 1024 // 100 MB

export function validateCaptureSize(raw: string | Buffer): boolean {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf-8') : raw.length
  return bytes <= MAX_CAPTURE_BYTES
}
