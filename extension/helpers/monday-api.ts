/**
 * Reading a task through monday's GraphQL API (the same `/v2` endpoint monday's web app calls),
 * and mapping the answer onto the snapshot shape. Kept free of Chrome APIs so it can be unit-tested.
 */

/** One item with everything a task snapshot needs, in monday's public GraphQL schema. */
export const ITEM_QUERY = `query TaskSnapshot($ids: [ID!]) {
  items(ids: $ids) {
    id
    name
    column_values { id type text column { title } }
    updates(limit: 100) {
      id
      text_body
      created_at
      creator { name }
      replies { id text_body created_at creator { name } }
      assets { id name file_extension url public_url }
    }
    assets { id name file_extension url public_url }
  }
}`

/** Updates beyond this many are not read; the query asks for the latest ones. */
export const UPDATE_LIMIT = 100

interface ApiPerson {
  name?: string | null
}

interface ApiReply {
  id: string | number
  text_body?: string | null
  created_at?: string | null
  creator?: ApiPerson | null
}

interface ApiAsset {
  id: string | number
  name?: string | null
  file_extension?: string | null
  url?: string | null
  public_url?: string | null
}

interface ApiUpdate extends ApiReply {
  replies?: ApiReply[] | null
  assets?: ApiAsset[] | null
}

export interface ApiItem {
  id: string | number
  name?: string | null
  column_values?: Array<{ id: string; type?: string | null; text?: string | null; column?: { title?: string | null } | null }> | null
  updates?: ApiUpdate[] | null
  assets?: ApiAsset[] | null
}

export interface MappedTask {
  title: string
  fields: Record<string, string>
  updates: Array<{
    id: string
    author: string
    createdAt: string
    body: string
    replies: Array<{ id: string; author: string; createdAt: string; body: string }>
  }>
  /** Image files only; the snapshot carries original images, other files are listed in a field. */
  attachments: Array<{ id: string; name: string; mimeType: string; url: string }>
  warnings: string[]
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

/** Name of the field that lists files which are not images, so they are visible without failing the capture. */
export const OTHER_FILES_FIELD = 'Other files'

function reply(r: ApiReply) {
  return {
    id: String(r.id),
    author: r.creator?.name ?? '',
    createdAt: r.created_at ?? '',
    body: (r.text_body ?? '').trim()
  }
}

export function mapItem(item: ApiItem): MappedTask {
  const fields: Record<string, string> = {}
  for (const value of item.column_values ?? []) {
    const text = value.text?.trim()
    if (!text) continue
    fields[value.column?.title || value.id] = text
  }

  const updates = (item.updates ?? []).map((u) => ({ ...reply(u), replies: (u.replies ?? []).map(reply) }))

  // The same file can be attached to the item and to an update; keep one entry per asset
  const assets = new Map<string, ApiAsset>()
  for (const asset of [...(item.assets ?? []), ...(item.updates ?? []).flatMap((u) => u.assets ?? [])]) {
    assets.set(String(asset.id), asset)
  }

  const attachments: MappedTask['attachments'] = []
  const otherFiles: string[] = []
  for (const asset of assets.values()) {
    const name = asset.name ?? `asset-${asset.id}`
    const mimeType = IMAGE_TYPES[(asset.file_extension ?? '').replace(/^\./, '').toLowerCase()]
    const url = asset.public_url || asset.url
    if (mimeType && url) attachments.push({ id: String(asset.id), name, mimeType, url })
    else otherFiles.push(name)
  }
  if (otherFiles.length) fields[OTHER_FILES_FIELD] = otherFiles.join(', ')

  const warnings: string[] = []
  if (updates.length >= UPDATE_LIMIT) warnings.push(`Only the latest ${UPDATE_LIMIT} updates were read`)

  return { title: item.name ?? '', fields, updates, attachments, warnings }
}
