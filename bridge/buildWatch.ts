/**
 * Notices that a newer build of the bridge sits on disk, so a long-running server steps aside for it.
 *
 * `scripts/build.mjs` writes one id per build to `build-id.txt` next to the bundle, last, after every file of the
 * build is in place. A server compares that file with the id it was built with; once they differ and it is not in the
 * middle of a request, it calls `onNewBuild` once, and the next MCP call starts the new server.
 */

import { readFile } from 'node:fs/promises'

export interface BuildWatchOptions {
  /** The build id file of the bundle on disk. */
  file: string
  /** The id this server was built with; 'dev' (run from source) never watches. */
  own: string
  intervalMs: number
  /** True while nothing waits for an answer, so stepping aside drops no request. */
  isIdle: () => boolean
  onNewBuild: (id: string) => void
}

export const DEFAULT_BUILD_CHECK_MS = 30_000

/** Starts watching; `stop()` ends it. Without a build id file, or run from source, it does nothing. */
export function watchBuild({ file, own, intervalMs, isIdle, onNewBuild }: BuildWatchOptions): { stop: () => void } {
  if (own === 'dev') return { stop: () => undefined }
  let stopped = false
  let checking = false

  const check = async () => {
    if (stopped || checking) return
    checking = true
    try {
      const onDisk = (await readFile(file, 'utf8').catch(() => '')).trim()
      // No file (yet) or the same build: nothing to do. A newer build waits until no request is in flight.
      if (!onDisk || onDisk === own || !isIdle() || stopped) return
      stopped = true
      clearInterval(timer)
      onNewBuild(onDisk)
    } finally {
      checking = false
    }
  }

  const timer = setInterval(() => void check(), intervalMs)
  timer.unref()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    }
  }
}
