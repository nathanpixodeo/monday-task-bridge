export interface Config {
  paired: boolean
  token: string | null
  pairId: string | null
  pairingSecret: string | null
  pairCode: string | null
  expiresAt: string | null
  status: 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'error' | 'pairing'
  error: string | null
  autoSync: boolean
  pendingOrigins: string[]
  lastCaptureAt: string | null
  lastTaskTitle: string | null
  lastCaptureComplete: boolean | null
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
  autoSync: true,
  pendingOrigins: [],
  lastCaptureAt: null,
  lastTaskTitle: null,
  lastCaptureComplete: null
}

export async function getConfig(): Promise<Config> {
  const result = await chrome.storage.local.get('config')
  return { ...defaultConfig, ...(result.config || {}) }
}

export async function setConfig(updates: Partial<Config>): Promise<Config> {
  const current = await getConfig()
  const next = { ...current, ...updates }
  await chrome.storage.local.set({ config: next })
  return next
}
