/**
 * Writing to monday as the signed-in user, for agents while "Allow writing" is on in the popup: updates and replies,
 * column values (status, tags, people, dates, ...), new items and subitems, and moving an item to another group.
 * Nothing is deleted or archived. Kept free of Chrome APIs so it can be unit-tested; the caller supplies the
 * session-authenticated GraphQL call.
 */

import type { ColumnInput, ColumnInputs, WriteRequest, WriteResult } from '../../shared/types'
import type { Graphql } from './assigned-tasks'
import { escapeHtml, idOf, readItem, updateBody } from './write-back'
import type { ApiColumn } from './write-back'

const ITEM_QUERY = `query WriteItem($ids: [ID!]) {
  items(ids: $ids) {
    id
    board { id columns { id title type } }
    group { id title }
    column_values { id value }
  }
}`

const UPDATE_QUERY = `query WriteUpdateOf($ids: [ID!]) {
  updates(ids: $ids) { id item_id }
}`

// A non-null list element fits both an [UpdateMention] and an [UpdateMention!] argument
const ADD_UPDATE = `mutation WriteAddUpdate($itemId: ID!, $body: String!, $parentId: ID, $mentions: [UpdateMention!]) {
  create_update(item_id: $itemId, body: $body, parent_id: $parentId, mentions_list: $mentions) { id }
}`

const SET_COLUMNS = `mutation WriteColumns($boardId: ID!, $itemId: ID!, $values: JSON!, $createLabels: Boolean) {
  change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values, create_labels_if_missing: $createLabels) { id }
}`

const TAGS_QUERY = `query WriteTags($boardIds: [ID!]) {
  boards(ids: $boardIds) { board_kind tags { id name } }
  tags { id name }
}`

const CREATE_TAG = `mutation WriteCreateTag($name: String!, $boardId: ID) {
  create_or_get_tag(tag_name: $name, board_id: $boardId) { id name }
}`

const ME_QUERY = `query WriteMe { me { id } }`

const USERS_BY_EMAIL = `query WriteUsersByEmail($emails: [String!]) {
  users(emails: $emails) { id name email }
}`

const USERS_BY_NAME = `query WriteUsersByName($name: String) {
  users(name: $name) { id name email }
}`

const USERS_BY_ID = `query WriteUsersById($ids: [ID!]) {
  users(ids: $ids) { id name }
}`

const GROUPS_QUERY = `query WriteGroups($boardIds: [ID!]) {
  boards(ids: $boardIds) { groups { id title } }
}`

const CREATE_ITEM = `mutation WriteCreateItem($boardId: ID!, $groupId: String, $name: String!) {
  create_item(board_id: $boardId, group_id: $groupId, item_name: $name) { id board { id } group { id title } }
}`

const CREATE_SUBITEM = `mutation WriteCreateSubitem($parentId: ID!, $name: String!) {
  create_subitem(parent_item_id: $parentId, item_name: $name) { id board { id } }
}`

const MOVE_ITEM = `mutation WriteMoveItem($itemId: ID!, $groupId: String!) {
  move_item_to_group(item_id: $itemId, group_id: $groupId) { id }
}`

/** The item, update, board or group is not one this account can write to; the bridge reports it as INVALID_TARGET. */
export class WriteTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WriteTargetError'
  }
}

interface Group {
  id: string
  title: string
}

/** The item as it is before the write: its board's columns, its group, and its current column values. */
interface TargetItem {
  id: string
  boardId: string
  columns: ApiColumn[]
  group: Group | null
  values: Map<string, unknown>
}

interface WriteOptions {
  createMissingLabels?: boolean
  createMissingTags?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function groupOf(value: unknown): Group | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return null
  return { id: value.id, title: value.title }
}

async function readTarget(graphql: Graphql, host: string, boardId: string, itemId: string): Promise<TargetItem> {
  const data = await graphql(host, ITEM_QUERY, { ids: [itemId] })
  const item = readItem(data)
  if (item === null) throw new WriteTargetError(`monday item ${itemId} was not found, or this account cannot see it`)
  if (item.boardId !== boardId) throw new WriteTargetError(`monday item ${itemId} is on board ${item.boardId}, not on board ${boardId}`)

  const raw = ((data as { items: Array<Record<string, unknown>> }).items[0]) ?? {}
  const values = new Map<string, unknown>()
  for (const entry of Array.isArray(raw.column_values) ? raw.column_values : []) {
    if (isRecord(entry) && typeof entry.id === 'string') values.set(entry.id, parseJson(entry.value))
  }
  return { id: itemId, boardId, columns: item.columns, group: groupOf(raw.group), values }
}

/** A column by its id, else by its title (case and surrounding spaces do not matter). */
function findColumn(item: TargetItem, key: string): ApiColumn {
  const byId = item.columns.find((column) => column.id === key)
  if (byId) return byId
  const wanted = key.trim().toLowerCase()
  const byTitle = item.columns.filter((column) => column.title.trim().toLowerCase() === wanted)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) {
    throw new Error(`Board ${item.boardId} has ${byTitle.length} columns titled "${key}"; use one of their ids: ${byTitle.map((column) => column.id).join(', ')}`)
  }
  const known = item.columns.map((column) => `${column.title} (${column.id}, ${column.type})`).join('; ')
  throw new Error(`Board ${item.boardId} has no column "${key}". Its columns: ${known}`)
}

async function findGroup(graphql: Graphql, host: string, boardId: string, key: string): Promise<Group> {
  const data = await graphql(host, GROUPS_QUERY, { boardIds: [boardId] })
  const board = ((data as { boards?: unknown } | null)?.boards as unknown[] | undefined)?.[0]
  if (!isRecord(board)) throw new WriteTargetError(`monday board ${boardId} was not found, or this account cannot see it`)
  const groups = (Array.isArray(board.groups) ? board.groups : []).map(groupOf).filter((group): group is Group => group !== null)
  const byId = groups.find((group) => group.id === key)
  if (byId) return byId
  const wanted = key.trim().toLowerCase()
  const byTitle = groups.filter((group) => group.title.trim().toLowerCase() === wanted)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) {
    throw new Error(`Board ${boardId} has ${byTitle.length} groups titled "${key}"; use one of their ids: ${byTitle.map((group) => group.id).join(', ')}`)
  }
  throw new Error(`Board ${boardId} has no group "${key}". Its groups: ${groups.map((group) => `${group.title} (${group.id})`).join('; ')}`)
}

// ─── Column values ───────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^(\d{2}:\d{2})(:\d{2})?$/

/** Looks up tags and people once per write, and remembers what it had to create. */
class Lookups {
  readonly created: string[] = []
  private tags?: Promise<{ byName: Map<string, number>; privateBoard: boolean }>
  private me?: Promise<number>

  constructor(
    private readonly graphql: Graphql,
    private readonly host: string,
    private readonly boardId: string,
    private readonly options: WriteOptions
  ) {}

  private knownTags() {
    this.tags ??= this.graphql(this.host, TAGS_QUERY, { boardIds: [this.boardId] }).then((data) => {
      const answer = (data ?? {}) as { boards?: unknown[]; tags?: unknown[] }
      const board = isRecord(answer.boards?.[0]) ? answer.boards[0] : {}
      const byName = new Map<string, number>()
      for (const tag of [...(Array.isArray(answer.tags) ? answer.tags : []), ...(Array.isArray(board.tags) ? board.tags : [])]) {
        const id = isRecord(tag) ? idOf(tag.id) : null
        if (id !== null && typeof (tag as { name?: unknown }).name === 'string') {
          byName.set((tag as { name: string }).name.trim().toLowerCase(), Number(id))
        }
      }
      return { byName, privateBoard: typeof board.board_kind === 'string' && board.board_kind !== 'public' }
    })
    return this.tags
  }

  /** Tag ids for names; a missing tag is created only when the agent asked for it. */
  async tagIds(names: string[]): Promise<number[]> {
    const { byName, privateBoard } = await this.knownTags()
    const missing = names.filter((name) => !byName.has(name.trim().toLowerCase()))
    if (missing.length > 0 && this.options.createMissingTags !== true) {
      throw new Error(`No tag named ${missing.map((name) => `"${name}"`).join(', ')} exists; pass createMissingTags to create it`)
    }
    for (const name of missing) {
      // A private or shareable board keeps its own tags; a public board's tags are the account's
      const data = await this.graphql(this.host, CREATE_TAG, { name: name.trim(), boardId: privateBoard ? this.boardId : null })
      const id = idOf((data as { create_or_get_tag?: { id?: unknown } | null } | null)?.create_or_get_tag?.id)
      if (id === null) throw new Error(`monday did not create the tag "${name}"`)
      byName.set(name.trim().toLowerCase(), Number(id))
      this.created.push(`tag ${name.trim()}`)
    }
    return names.map((name) => byName.get(name.trim().toLowerCase())!)
  }

  /** Ids of tags already known by these names; names of tags that do not exist are skipped. */
  async existingTagIds(names: string[]): Promise<number[]> {
    const { byName } = await this.knownTags()
    return names.map((name) => byName.get(name.trim().toLowerCase())).filter((id): id is number => id !== undefined)
  }

  /** User ids for "me", ids, emails or full names; a name that is not exactly one user's is an error. */
  async personIds(entries: string[]): Promise<number[]> {
    const ids: number[] = []
    const emails = entries.filter((entry) => entry.includes('@')).map((entry) => entry.trim().toLowerCase())
    const byEmail = new Map<string, number>()
    if (emails.length > 0) {
      const users = await this.users(USERS_BY_EMAIL, { emails })
      for (const user of users) byEmail.set(user.email.toLowerCase(), user.id)
    }
    for (const raw of entries) {
      const entry = raw.trim()
      if (entry.toLowerCase() === 'me') {
        this.me ??= this.graphql(this.host, ME_QUERY, {}).then((data) => {
          const id = idOf((data as { me?: { id?: unknown } | null } | null)?.me?.id)
          if (id === null) throw new Error('monday did not say who the signed-in user is')
          return Number(id)
        })
        ids.push(await this.me)
      } else if (/^\d{1,20}$/.test(entry)) {
        ids.push(Number(entry))
      } else if (entry.includes('@')) {
        const id = byEmail.get(entry.toLowerCase())
        if (id === undefined) throw new Error(`No monday user has the email ${entry}`)
        ids.push(id)
      } else {
        const users = await this.users(USERS_BY_NAME, { name: entry })
        const exact = users.filter((user) => user.name.trim().toLowerCase() === entry.toLowerCase())
        if (exact.length === 1) {
          ids.push(exact[0].id)
        } else if (exact.length > 1) {
          throw new Error(`${exact.length} monday users are named "${entry}"; use an email instead: ${exact.map((user) => user.email).join(', ')}`)
        } else {
          const close = users.slice(0, 5).map((user) => `${user.name} <${user.email}>`).join(', ')
          throw new Error(`No monday user is named "${entry}"${close ? `; did you mean: ${close}` : ''}`)
        }
      }
    }
    return ids
  }

  private async users(query: string, variables: Record<string, unknown>) {
    const data = await this.graphql(this.host, query, variables)
    const list = (data as { users?: unknown } | null)?.users
    const users: Array<{ id: number; name: string; email: string }> = []
    for (const user of Array.isArray(list) ? list : []) {
      const id = isRecord(user) ? idOf(user.id) : null
      if (id === null) continue
      const { name, email } = user as { name?: unknown; email?: unknown }
      users.push({ id: Number(id), name: typeof name === 'string' ? name : '', email: typeof email === 'string' ? email : '' })
    }
    return users
  }
}

/** A whole new list (array or single string), or a change to the current one ({ add, remove }). */
function listChange(input: ColumnInput, column: ApiColumn): { set: string[] } | { add: string[]; remove: string[] } {
  if (typeof input === 'string') return { set: [input] }
  if (isStringList(input)) return { set: input }
  const change: unknown = input
  if (isRecord(change) && Object.keys(change).every((key) => key === 'add' || key === 'remove')) {
    const add = change.add ?? []
    const remove = change.remove ?? []
    if (isStringList(add) && isStringList(remove)) return { add, remove }
  }
  throw new Error(`Column ${column.title} (${column.type}) takes a list of names, or { add, remove }`)
}

function expects(column: ApiColumn, what: string): never {
  throw new Error(`Column ${column.title} (${column.type}) takes ${what}`)
}

function dateValue(column: ApiColumn, input: string) {
  const [date, time, ...rest] = input.trim().split(/[ T]/)
  const match = time === undefined ? null : TIME_RE.exec(time)
  if (!DATE_RE.test(date) || rest.length > 0 || (time !== undefined && match === null)) expects(column, 'a date "YYYY-MM-DD" or "YYYY-MM-DD HH:mm"')
  return match ? { date, time: `${match[1]}${match[2] ?? ':00'}` } : { date }
}

/** The JSON monday's change_multiple_column_values takes for one column; null clears it. */
async function columnValue(lookups: Lookups, column: ApiColumn, input: ColumnInput, current: unknown): Promise<unknown> {
  if (input === null) {
    if (column.type === 'name') expects(column, 'the new item name; it cannot be cleared')
    return null
  }

  switch (column.type) {
    case 'name':
      return typeof input === 'string' && input.trim() ? input.trim() : expects(column, 'the new item name')
    case 'text':
      return typeof input === 'string' || typeof input === 'number' ? String(input) : expects(column, 'text')
    case 'long_text':
      return typeof input === 'string' ? { text: input } : expects(column, 'text')
    case 'numbers': {
      const number = typeof input === 'number' ? input : typeof input === 'string' && input.trim() ? Number(input) : NaN
      return Number.isFinite(number) ? String(number) : expects(column, 'a number')
    }
    case 'status':
    case 'color':
      return typeof input === 'string' && input.trim() ? { label: input.trim() } : expects(column, 'a status label, such as "Done"')
    case 'dropdown':
      if (typeof input === 'string') return { labels: [input] }
      return isStringList(input) ? { labels: input } : expects(column, 'a list of dropdown labels')
    case 'checkbox':
      if (typeof input !== 'boolean') expects(column, 'true or false')
      return input ? { checked: 'true' } : null
    case 'date':
      return typeof input === 'string' ? dateValue(column, input) : expects(column, 'a date "YYYY-MM-DD" or "YYYY-MM-DD HH:mm"')
    case 'timeline': {
      const range = input as { from?: unknown; to?: unknown }
      if (!isRecord(input) || typeof range.from !== 'string' || typeof range.to !== 'string' ||
          !DATE_RE.test(range.from) || !DATE_RE.test(range.to)) {
        expects(column, '{ from: "YYYY-MM-DD", to: "YYYY-MM-DD" }')
      }
      return { from: range.from, to: range.to }
    }
    case 'link': {
      const link = typeof input === 'string' ? { url: input } : (input as { url?: unknown; text?: unknown })
      if (!isRecord(link) || typeof link.url !== 'string' || !/^https?:\/\/\S+$/i.test(link.url.trim())) expects(column, 'an http(s) URL, or { url, text }')
      const url = (link.url as string).trim()
      return { url, text: typeof link.text === 'string' && link.text.trim() ? link.text.trim() : url }
    }
    case 'tags': {
      const change = listChange(input, column)
      if ('set' in change) return { tag_ids: await lookups.tagIds(change.set) }
      const now = isRecord(current) && Array.isArray(current.tag_ids) ? current.tag_ids.map(Number).filter(Number.isFinite) : []
      const removed = new Set(await lookups.existingTagIds(change.remove))
      const added = await lookups.tagIds(change.add)
      return { tag_ids: [...new Set([...now, ...added])].filter((id) => !removed.has(id) || added.includes(id)) }
    }
    case 'people':
    case 'multiple-person': {
      const change = listChange(input, column)
      if ('set' in change) {
        return { personsAndTeams: [...new Set(await lookups.personIds(change.set))].map((id) => ({ id, kind: 'person' })) }
      }
      const now = (isRecord(current) && Array.isArray(current.personsAndTeams) ? current.personsAndTeams : [])
        .filter(isRecord)
        .map((entry) => ({ id: Number(entry.id), kind: entry.kind === 'team' ? 'team' : 'person' }))
        .filter((entry) => Number.isFinite(entry.id))
      const removed = new Set(await lookups.personIds(change.remove))
      const kept = now.filter((entry) => entry.kind === 'team' || !removed.has(entry.id))
      for (const id of await lookups.personIds(change.add)) {
        if (!kept.some((entry) => entry.kind === 'person' && entry.id === id)) kept.push({ id, kind: 'person' })
      }
      return { personsAndTeams: kept }
    }
    default:
      throw new Error(`Column ${column.title} is a ${column.type} column, which cannot be set yet`)
  }
}

/** Sets every column given in one change_multiple_column_values call; returns the titles set and what was created. */
async function setColumns(graphql: Graphql, host: string, item: TargetItem, columns: ColumnInputs, options: WriteOptions) {
  const entries = Object.entries(columns)
  if (entries.length === 0) throw new Error('No column to set')
  const lookups = new Lookups(graphql, host, item.boardId, options)
  const values: Record<string, unknown> = {}
  const titles: string[] = []
  for (const [key, input] of entries) {
    const column = findColumn(item, key)
    if (column.id in values) throw new Error(`Column ${column.title} is given twice`)
    values[column.id] = await columnValue(lookups, column, input, item.values.get(column.id))
    titles.push(column.title)
  }
  try {
    await graphql(host, SET_COLUMNS, {
      boardId: item.boardId,
      itemId: item.id,
      values: JSON.stringify(values),
      createLabels: options.createMissingLabels === true
    })
  } catch (err) {
    const made = lookups.created.length ? ` (created before the failure: ${lookups.created.join(', ')})` : ''
    throw new Error(`Could not set ${titles.join(', ')}${made}: ${reasonOf(err)}`)
  }
  return { titles, created: lookups.created }
}

// ─── Mentions ────────────────────────────────────────────────────────

interface Person {
  id: string
  name: string
}

/** The people to tag in an update, with their names; resolved like a people column, each one once. */
async function mentionedPeople(graphql: Graphql, host: string, boardId: string, entries: string[]): Promise<Person[]> {
  const ids = [...new Set(await new Lookups(graphql, host, boardId, {}).personIds(entries))].map(String)
  const data = await graphql(host, USERS_BY_ID, { ids })
  const names = new Map<string, string>()
  for (const user of ((data as { users?: unknown } | null)?.users as unknown[] | undefined) ?? []) {
    const id = isRecord(user) ? idOf(user.id) : null
    if (id !== null && typeof (user as { name?: unknown }).name === 'string') names.set(id, (user as { name: string }).name)
  }
  return ids.map((id) => {
    const name = names.get(id)?.trim()
    if (!name) throw new Error(`No monday user has the id ${id}`)
    return { id, name }
  })
}

/** The anchor monday's editor writes for a user mention; monday shows it as a tag. */
const mentionAnchor = (host: string, person: Person) =>
  `<a class="user_mention_editor router" href="https://${host}/users/${person.id}" data-mention-type="User" ` +
  `data-mention-id="${person.id}" target="_blank" rel="noopener noreferrer">@${escapeHtml(person.name)}</a>`

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Tags each person where the body writes "@Their Name"; people the body does not name are tagged at its start. */
export function bodyWithMentions(host: string, html: string, people: Person[]): string {
  // Longer names first, and a placeholder until the end, so "@An" never matches inside "@An Nguyen" or its tag
  const placed = new Set<number>()
  let body = html.replace(/\u0000/g, '')
  const longestFirst = people.map((person, index) => ({ person, index })).sort((a, b) => b.person.name.length - a.person.name.length)
  for (const { person, index } of longestFirst) {
    const written = new RegExp(`@${escapeRegExp(escapeHtml(person.name))}(?![\\p{L}\\p{N}])`, 'giu')
    const replaced = body.replace(written, `\u0000${index}\u0000`)
    if (replaced !== body) placed.add(index)
    body = replaced
  }
  body = body.replace(/\u0000(\d+)\u0000/g, (_, index: string) => mentionAnchor(host, people[Number(index)]))
  const leading = people.filter((_, index) => !placed.has(index)).map((person) => mentionAnchor(host, person))
  return leading.length ? `${leading.join(' ')} ${body}` : body
}

// ─── Writes ──────────────────────────────────────────────────────────

/** Does one write an agent asked for; nothing is retried, so a failure is reported as it happened. */
export async function performWrite(graphql: Graphql, host: string, request: WriteRequest): Promise<WriteResult> {
  switch (request.op) {
    case 'add-update': {
      await readTarget(graphql, host, request.boardId, request.itemId)
      if (request.replyToUpdateId !== undefined) {
        const data = await graphql(host, UPDATE_QUERY, { ids: [request.replyToUpdateId] })
        const update = ((data as { updates?: unknown[] } | null)?.updates ?? [])[0] as { item_id?: unknown } | undefined
        if (!update || idOf(update.item_id) !== request.itemId) {
          throw new WriteTargetError(`Update ${request.replyToUpdateId} is not an update on item ${request.itemId}`)
        }
      }
      // Every person is resolved before anything is written, so a name that matches no one stops the update
      const people = request.mentions?.length ? await mentionedPeople(graphql, host, request.boardId, request.mentions) : []
      const created = await graphql(host, ADD_UPDATE, {
        itemId: request.itemId,
        body: bodyWithMentions(host, updateBody(request.body), people),
        parentId: request.replyToUpdateId ?? null,
        mentions: people.length ? people.map((person) => ({ id: person.id, type: 'User' })) : null
      })
      const updateId = idOf((created as { create_update?: { id?: unknown } | null } | null)?.create_update?.id)
      return {
        op: request.op,
        accountHost: host,
        boardId: request.boardId,
        itemId: request.itemId,
        ...(updateId ? { updateId } : {}),
        ...(people.length ? { mentioned: people.map((person) => person.name) } : {})
      }
    }

    case 'update-item': {
      const item = await readTarget(graphql, host, request.boardId, request.itemId)
      const { titles, created } = await setColumns(graphql, host, item, request.columns, request)
      return {
        op: request.op,
        accountHost: host,
        boardId: request.boardId,
        itemId: request.itemId,
        columnsSet: titles,
        ...(created.length ? { created } : {})
      }
    }

    case 'create-item': {
      let itemId: string | null
      let boardId: string | null
      let group: Group | null = null
      const kind = request.parentItemId === undefined ? 'item' : 'subitem'
      if (request.parentItemId !== undefined) {
        if (request.group !== undefined) throw new Error('A subitem goes under its parent item; leave group out with parentItemId')
        const parent = await readTarget(graphql, host, request.boardId, request.parentItemId)
        const data = await graphql(host, CREATE_SUBITEM, { parentId: parent.id, name: request.name.trim() })
        const created = (data as { create_subitem?: { id?: unknown; board?: { id?: unknown } | null } | null } | null)?.create_subitem
        itemId = idOf(created?.id)
        boardId = idOf(created?.board?.id)
      } else {
        const wanted = request.group === undefined ? undefined : await findGroup(graphql, host, request.boardId, request.group)
        const data = await graphql(host, CREATE_ITEM, { boardId: request.boardId, groupId: wanted?.id ?? null, name: request.name.trim() })
        const created = (data as { create_item?: { id?: unknown; board?: { id?: unknown } | null; group?: unknown } | null } | null)?.create_item
        itemId = idOf(created?.id)
        boardId = idOf(created?.board?.id) ?? request.boardId
        group = groupOf(created?.group) ?? wanted ?? null
      }
      if (itemId === null || boardId === null) throw new Error(`monday did not say which ${kind} it created`)

      const result: WriteResult = { op: request.op, accountHost: host, boardId, itemId, ...(group ? { group } : {}) }
      if (request.columns === undefined || Object.keys(request.columns).length === 0) return result
      try {
        const item = await readTarget(graphql, host, boardId, itemId)
        const { titles, created } = await setColumns(graphql, host, item, request.columns, request)
        return { ...result, columnsSet: titles, ...(created.length ? { created } : {}) }
      } catch (err) {
        throw new Error(`Created ${kind} ${itemId} on board ${boardId}, but could not set its columns: ${reasonOf(err)}`)
      }
    }

    case 'move-item': {
      await readTarget(graphql, host, request.boardId, request.itemId)
      const group = await findGroup(graphql, host, request.boardId, request.group)
      await graphql(host, MOVE_ITEM, { itemId: request.itemId, groupId: group.id })
      return { op: request.op, accountHost: host, boardId: request.boardId, itemId: request.itemId, group }
    }
  }
}
