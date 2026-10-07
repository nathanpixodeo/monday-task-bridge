import React, { useEffect, useState, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import type { Config } from './helpers/storage'
import { getConfig, setConfig, defaultConfig } from './helpers/storage'
import './style.css'

function StatusBadge({ status }: { status: Config['status'] }) {
  const colorClass =
    status === 'authenticated'
      ? 'bg-green-100 text-green-800'
      : status === 'error'
        ? 'bg-red-100 text-red-800'
        : status === 'connected' || status === 'connecting'
          ? 'bg-yellow-100 text-yellow-800'
          : 'bg-slate-100 text-slate-800'

  const label =
    status === 'authenticated' ? 'CONNECTED' : status.toUpperCase()

  return (
    <span className={`px-2 py-1 rounded text-sm font-medium ${colorClass}`}>
      {label}
    </span>
  )
}

function Popup() {
  const [config, setConfigState] = useState<Config>(defaultConfig)
  const [pairCode, setPairCode] = useState<string | null>(null)
  const [permissionError, setPermissionError] = useState<string | null>(null)

  useEffect(() => {
    getConfig().then(setConfigState)

    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.config?.newValue) {
        setConfigState(changes.config.newValue as Config)
      }
    }
    chrome.storage.local.onChanged.addListener(listener)

    return () => {
      chrome.storage.local.onChanged.removeListener(listener)
    }
  }, [])

  const handlePair = useCallback(() => {
    chrome.runtime.sendMessage(
      { type: 'start-pairing' },
      (response: { code?: string; error?: string } | undefined) => {
        if (response?.code) {
          setPairCode(response.code)
        }
      }
    )
  }, [])

  const handleRetry = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'reconnect' })
  }, [])

  const handlePauseResume = useCallback(async () => {
    await setConfig({ autoSync: !config.autoSync })
  }, [config.autoSync])

  const handleRequestOrigins = useCallback(async () => {
    setPermissionError(null)
    const originsToRequest = config.pendingOrigins
    if (originsToRequest.length === 0) return

    try {
      // chrome.permissions.request must be called from a user gesture in the popup
      const granted = await chrome.permissions.request({ origins: originsToRequest })
      if (granted) {
        await setConfig({ pendingOrigins: [] })
      } else {
        setPermissionError('Permission was denied by the user.')
      }
    } catch (e: unknown) {
      setPermissionError(e instanceof Error ? e.message : String(e))
    }
  }, [config.pendingOrigins])

  const handleUnpair = useCallback(async () => {
    await setConfig({
      paired: false,
      token: null,
      pairId: null,
      pairingSecret: null,
      pairCode: null,
      expiresAt: null,
      status: 'disconnected',
      error: null,
      pendingOrigins: [],
      lastCaptureAt: null,
      lastTaskTitle: null,
      lastCaptureComplete: null
    })
    setPairCode(null)
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Monday Task Bridge</h1>

      {!config.paired ? (
        <div className="border p-4 rounded bg-white shadow-sm">
          <h2 className="text-lg font-semibold mb-2">Pair with Bridge</h2>
          {config.status === 'pairing' && (pairCode || config.pairCode) ? (
            <div>
              <p className="mb-2">Run this command in PowerShell from the monday-task-bridge folder within 2 minutes:</p>
              <div className="text-2xl font-mono bg-slate-100 p-2 text-center rounded tracking-widest">
                {pairCode || config.pairCode}
              </div>
              <code className="block mt-2 p-2 rounded bg-slate-100 text-xs break-all">npm run pair -- {pairCode || config.pairCode}</code>
              <p className="text-sm text-slate-500 mt-2">Waiting for approval…</p>
            </div>
          ) : (
            <button
              onClick={handlePair}
              type="button"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded"
            >
              Start Pairing
            </button>
          )}
          {config.error != null && (
            <p className="text-red-500 mt-2 text-sm">{config.error}</p>
          )}
        </div>
      ) : (
        <div className="border p-4 rounded bg-white shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <span className="font-semibold text-slate-700">Status:</span>
            <StatusBadge status={config.status} />
          </div>

          <div className="flex gap-2 mb-2">
            <button
              onClick={handlePauseResume}
              type="button"
              className="flex-1 bg-slate-200 hover:bg-slate-300 text-slate-800 font-medium py-2 px-4 rounded"
            >
              {config.autoSync ? 'Pause Sync' : 'Resume Sync'}
            </button>
            <button
              onClick={handleRetry}
              type="button"
              className="flex-1 bg-slate-200 hover:bg-slate-300 text-slate-800 font-medium py-2 px-4 rounded"
            >
              Reconnect
            </button>
          </div>

          <button
            onClick={handleUnpair}
            type="button"
            className="w-full bg-red-100 hover:bg-red-200 text-red-700 font-medium py-2 px-4 rounded text-sm"
          >
            Unpair
          </button>

          {config.error != null && (
            <p className="text-red-500 mt-4 text-sm break-words">{config.error}</p>
          )}
          {config.lastCaptureAt && (
            <div className="mt-3 text-xs text-slate-600 break-words">
              <p className="font-medium">Latest task: {config.lastTaskTitle || 'Unknown'}</p>
              <p>{new Date(config.lastCaptureAt).toLocaleString()} · {config.lastCaptureComplete ? 'Complete' : 'Incomplete'}</p>
            </div>
          )}
        </div>
      )}

      {config.pendingOrigins.length > 0 && (
        <div className="border border-orange-200 p-4 rounded bg-orange-50 text-orange-800">
          <p className="font-semibold mb-2">Image Permissions Needed</p>
          <p className="text-sm mb-3">
            Some images are hosted on domains we don&apos;t have access to.
          </p>
          <ul className="list-disc pl-5 mb-3 text-xs opacity-80 break-all">
            {config.pendingOrigins.map((origin) => (
              <li key={origin}>{origin}</li>
            ))}
          </ul>
          <button
            onClick={handleRequestOrigins}
            type="button"
            className="w-full bg-orange-600 hover:bg-orange-700 text-white font-medium py-2 px-4 rounded"
          >
            Allow Access
          </button>
          {permissionError != null && (
            <p className="text-red-600 mt-2 text-sm">{permissionError}</p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Mount ───────────────────────────────────────────────────────────

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(<Popup />)
}
