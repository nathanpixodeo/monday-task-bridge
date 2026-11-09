import { legacyReads } from './activity'
import type { ActivityEntry } from './activity'

export interface Config {
  paired: boolean
  token: string | null
  pairId: string | null
  pairingSecret: string | null
  pairCode: string | null
  expiresAt: string | null
  status: 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'error' | 'pairing'
  error: string | null
  /** Power switch: when false the worker stays disconnected, so agents cannot read tasks. */
  enabled: boolean
  /** "Allow writing" switch: when false the worker refuses every agent write to monday. Off until the user turns it on. */
  allowWrite: boolean
  /** When the current live connection was authenticated; null while not connected. */
  connectedAt: string | null
  capturing: boolean
  pendingOrigins: string[]
  /** Reads and writes agents asked for, newest first, at most MAX_ACTIVITY. */
  activity: ActivityEntry[]
}

export const defaultConfig: Config = {
  paired: false,
  token: null,
  pairId: null,
  pairingSecret: null,
  pairCode: null,
  expiresAt: null,
  status: 'disconnected',
  error: null,
  enabled: true,
  allowWrite: false,
  connectedAt: null,
  capturing: false,
  pendingOrigins: [],
  activity: []
}

/** Fields reset when this browser is no longer paired with the bridge. */
export const unpairedFields: Partial<Config> = {
  paired: false,
  token: null,
  pairId: null,
  pairingSecret: null,
  pairCode: null,
  expiresAt: null,
  status: 'disconnected',
  error: null,
  // A fresh pairing should come up connected, and read-only
  enabled: true,
  allowWrite: false,
  connectedAt: null,
  capturing: false,
  pendingOrigins: [],
  activity: []
}

export async function getConfig(): Promise<Config> {
  const result = await chrome.storage.local.get('config')
  // Before writes were logged, the popup kept only reads, as `recentReads`; they carry over once, as reads
  const { recentReads, ...stored } = (result.config || {}) as Partial<Config> & { recentReads?: unknown }
  return { ...defaultConfig, ...stored, ...(stored.activity === undefined ? { activity: legacyReads(recentReads) } : {}) }
}

let writeQueue: Promise<unknown> = Promise.resolve()

/**
 * Merge updates into the stored config. Writes are queued so concurrent
 * read-modify-write updates in one extension context cannot drop each other.
 */
export function setConfig(updates: Partial<Config>): Promise<Config> {
  const write = writeQueue.then(async () => {
    const next = { ...(await getConfig()), ...updates }
    await chrome.storage.local.set({ config: next })
    return next
  })
  writeQueue = write.catch(() => {})
  return write
}
