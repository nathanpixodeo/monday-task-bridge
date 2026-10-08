/**
 * Content script for monday.com task extraction.
 * Runs in monday.com pages. Extracts visible task data from the DOM
 * without using any private APIs, cookies, or innerHTML/eval.
 */

import { HIDDEN_FRAME_PREFIX } from './helpers/hidden-frame'

function isTaskUrl(href: string): boolean {
  try {
    const u = new URL(href)
    return u.hostname.endsWith('.monday.com') && /\/boards\/\d+(?:\/views\/\d+)?\/pulses\/\d+/.test(u.pathname)
  } catch {
    return false
  }
}

/** The capture ID when this page runs in the extension's invisible capture frame, else null. */
function hiddenFrameCaptureId(): string | null {
  if (window === window.top || !window.name.startsWith(HIDDEN_FRAME_PREFIX)) return null
  // Only the extension's own offscreen page may drive a capture, not any site that frames monday
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '')
  if (location.ancestorOrigins?.[0] !== extensionOrigin) return null
  return window.name.slice(HIDDEN_FRAME_PREFIX.length)
}

/** Tells the worker about task pages the user opens, for auto-sync. */
function watchNavigation() {
  let lastUrl = location.href
  const notify = () => {
    if (isTaskUrl(location.href)) chrome.runtime.sendMessage({ type: 'page-navigated', url: location.href })
  }

  // monday is a SPA: task changes rewrite the URL without a page load
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      notify()
    }
  }).observe(document, { subtree: true, childList: true })

  notify()
}

/** Reads the task this frame was opened for and reports straight to the worker. */
async function runHiddenCapture(captureId: string) {
  const report = (result: ExtractionResult | { error: string }) =>
    chrome.runtime.sendMessage({ type: 'hidden-extract-result', captureId, result })

  if (!isTaskUrl(location.href)) {
    report({ error: `monday did not open the task in the hidden frame (it showed ${location.pathname}). Sign in to monday in this Chrome profile.` })
    return
  }
  try {
    // A cold app load inside a fresh frame is slower than in a tab, so allow longer for the panel
    const result = await extractTask(60)
    report(
      result.title
        ? result
        : { error: 'monday did not render the task in the hidden frame (signed out, or monday blocked embedding)' }
    )
  } catch (err) {
    report({ error: err instanceof Error ? err.message : String(err) })
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Find visible, clickable elements matching any of the given text patterns.
 * Uses button title, innerText, and aria-label for matching.
 */
function findClickableByText(
  textPatterns: string[],
  selectors = 'button, [role="button"], a, [tabindex]'
): HTMLElement[] {
  const els = Array.from(document.querySelectorAll(selectors)) as HTMLElement[]
  const lowerPatterns = textPatterns.map((p) => p.toLowerCase())
  return els.filter((el) => {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false
    const titleAttr = (el.getAttribute('title') || '').toLowerCase()
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase()
    const text = (el.textContent || '').toLowerCase().trim()
    return lowerPatterns.some(
      (pattern) => titleAttr.includes(pattern) || ariaLabel.includes(pattern) || text.includes(pattern)
    )
  })
}

function isExpansionControl(el: HTMLElement): boolean {
  const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
    .toLowerCase().replace(/\s+/g, ' ').trim()
  return /^(?:(?:…|\.\.\.)\s*)?(?:previous(?:\s+\d+)?\s+repl(?:y|ies)|(?:see|load|view|show)\s+(?:more|\d+\s+repl(?:y|ies)|earlier\s+updates)|earlier updates)(?:\b|$)/.test(label)
}

// ─── Main extraction ─────────────────────────────────────────────────

interface RawAttachment {
  id: string
  name: string
  mimeType: string
  url: string
}

interface ExtractionResult {
  title: string
  fields: Record<string, string>
  updates: Array<{
    id: string
    author: string
    createdAt: string
    body: string
    replies: Array<{
      id: string
      author: string
      createdAt: string
      body: string
    }>
  }>
  attachments: RawAttachment[]
  warnings: string[]
  error?: string
}

async function extractTask(readyAttempts = 20): Promise<ExtractionResult> {
  const warnings: string[] = []
  let taskPanelReady = false
  for (let attempt = 0; attempt < readyAttempts; attempt++) {
    const titleVisible = document.querySelector('[data-testid="item-header-title"], [aria-label="Item Title"], h1')
    const updatesVisible = findClickableByText(['updates'], 'button, [role="button"], [role="tab"]')
      .some(el => /^updates(?:\s*\/\s*\d+)?$/i.test((el.textContent || el.getAttribute('aria-label') || '').trim()))
    if (titleVisible && updatesVisible) {
      taskPanelReady = true
      break
    }
    await delay(500)
  }
  if (!taskPanelReady) warnings.push('Task panel did not finish loading before capture')
  const updateTab = findClickableByText(['updates'], 'button, [role="button"], [role="tab"]')
    .find(el => /^updates(?:\s*\/\s*\d+)?$/i.test((el.textContent || el.getAttribute('aria-label') || '').trim()))
  const expectedUpdateCount = Number((updateTab?.textContent || '').match(/\/\s*(\d+)/)?.[1] ?? NaN)
  if (updateTab && updateTab.getAttribute('aria-selected') !== 'true') {
    updateTab.click()
    await delay(1000)
  }

  // ── 1. Expand all updates, replies, "see more" ──────────────────

  const MAX_EXPAND_ROUNDS = 20
  let totalExpanded = 0
  let expansionLimitHit = false
  const clickedControls = new WeakMap<HTMLElement, string>()
  function shouldExpand(el: HTMLElement): boolean {
    if (el.getAttribute('aria-expanded') === 'true' || el.hasAttribute('disabled')) return false
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim()
    if (clickedControls.get(el) === label) return false
    clickedControls.set(el, label)
    return true
  }

  for (let round = 0; round < MAX_EXPAND_ROUNDS; round++) {
    let clickedThisRound = 0

    // Monday.com accessibility: Buttons with titles like "Previous 6 replies",
    // "... See more", "Updates / 1", and similar.
    const expanders = findClickableByText([
      'previous', 'see more', 'load more', 'view more', 'show more', 'earlier updates'
    ], 'button, [role="button"], a').filter(isExpansionControl)

    for (const el of expanders) {
      if (!shouldExpand(el)) continue
      el.click()
      clickedThisRound++
    }

    if (clickedThisRound === 0) break
    totalExpanded += clickedThisRound
    await delay(1500)
    if (round === MAX_EXPAND_ROUNDS - 1) expansionLimitHit = true
  }

  // ── 2. Collect updates at each scroll position ───────────────────
  // Monday can virtualize the feed: items scrolled out of view disappear from
  // the DOM. Keep copies as we go instead of reading only the final viewport.
  const updateSelector =
    '[data-testid*="update-feed-item"], [data-testid*="update_feed_item"], [role="article"], .update-component'
  const capturedUpdates = new Map<string, HTMLElement>()
  function visibleUpdateElements(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(updateSelector))
      .filter(el => !el.parentElement?.closest(updateSelector))
  }
  function collectVisibleUpdates(): void {
    const duplicateKeys = new Set<string>()
    for (const el of visibleUpdateElements()) {
      const author = el.querySelector('[data-testid*="creator-name"], [data-testid*="author"], .update-author-name, .creator-name')?.textContent?.trim() || ''
      const time = el.querySelector('time[datetime]')?.getAttribute('datetime') || ''
      const body = el.querySelector('[data-testid*="update-body"], [data-testid*="body"], .update-body, .post-content')?.textContent?.trim() || ''
      const key = el.getAttribute('data-update-id') || el.getAttribute('data-id') || el.id ||
        `${author}\u001f${time}\u001f${body.slice(0, 120)}`
      if (duplicateKeys.has(key) && !warnings.includes('Identical updates could not be distinguished in the feed')) {
        warnings.push('Identical updates could not be distinguished in the feed')
      }
      duplicateKeys.add(key)
      // Replace earlier copies after replies or expanded body have loaded.
      capturedUpdates.set(key, el.cloneNode(true) as HTMLElement)
    }
  }

  const firstUpdate = visibleUpdateElements()[0]
  let updatesContainer: HTMLElement | null = null
  for (let node = firstUpdate?.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (node.clientHeight > 0 && node.scrollHeight > node.clientHeight + 2 &&
        /auto|scroll/.test(style.overflowY)) {
      updatesContainer = node
      break
    }
  }
  updatesContainer ||= document.querySelector<HTMLElement>(
    '[data-testid="item-update-list"], .updates-feed, [aria-label="Updates"]'
  )
  if (updatesContainer) {
    updatesContainer.scrollTop = 0
    await delay(250)
  }
  collectVisibleUpdates()

  if (updatesContainer && updatesContainer.scrollHeight > updatesContainer.clientHeight + 2) {
    const MAX_SCROLL_ITERATIONS = 50
    let reachedEnd = false
    for (let i = 0; i < MAX_SCROLL_ITERATIONS; i++) {
      const before = updatesContainer.scrollTop
      const step = Math.max(Math.floor(updatesContainer.clientHeight * 0.8), 400)
      updatesContainer.scrollTop = Math.min(updatesContainer.scrollHeight, before + step)
      await delay(450)
      // New virtualized rows can contain reply expanders that were absent above.
      for (const el of findClickableByText(
        ['previous', 'see more', 'load more', 'view more', 'show more', 'earlier updates'],
        'button, [role="button"], a'
      ).filter(isExpansionControl)) {
        if (shouldExpand(el)) {
          el.click()
        }
      }
      await delay(250)
      collectVisibleUpdates()
      if (updatesContainer.scrollTop + updatesContainer.clientHeight >= updatesContainer.scrollHeight - 2) {
        await delay(500)
        collectVisibleUpdates()
        if (updatesContainer.scrollTop + updatesContainer.clientHeight >= updatesContainer.scrollHeight - 2) {
          reachedEnd = true
          break
        }
      }
      if (updatesContainer.scrollTop === before) break
    }
    if (!reachedEnd) warnings.push('Could not reach the end of the updates feed')
  }

  // ── 3. Extract title ────────────────────────────────────────────

  const titleEl =
    document.querySelector('[data-testid="item-header-title"]') ||
    document.querySelector('[aria-label="Item Title"]') ||
    document.querySelector('h1')

  const title = titleEl ? (titleEl as HTMLElement).textContent?.trim() || 'Unknown Title' : 'Unknown Title'

  if (title === 'Unknown Title') {
    warnings.push('Could not extract task title')
  }

  // ── 4. Extract fields (column values) ───────────────────────────

  const fields: Record<string, string> = {}

  // Monday renders columns in the item page. Look for column-value containers
  // that have identifiable labels. Common patterns:
  // - Elements with data-testid containing "column" and a label sibling
  // - aria-label attributes in format "ColumnName column, value: ..."
  const allElements = document.querySelectorAll('[aria-label]')
  for (const el of allElements) {
    const label = el.getAttribute('aria-label') || ''
    // Pattern: "Status column, value: Working on it"
    const columnMatch = label.match(/^(.+?)\s+column,?\s+value:\s*(.+)$/i)
    if (columnMatch) {
      const colName = columnMatch[1].trim()
      const colValue = columnMatch[2].trim()
      if (colName && colValue) {
        fields[colName] = colValue
      }
      continue
    }

    // Pattern: "ColumnName: value" in aria-label
    const colonMatch = label.match(/^([^:]+):\s+(.+)$/)
    if (colonMatch) {
      const candidateName = colonMatch[1].trim()
      // Ignore generic aria labels
      if (candidateName.length < 50 && !candidateName.includes('button') && !candidateName.includes('menu')) {
        const candidateValue = colonMatch[2].trim()
        if (candidateValue && candidateValue !== candidateName) {
          fields[candidateName] = candidateValue
        }
      }
    }
  }

  // Also try data-testid based extraction
  const columnCells = document.querySelectorAll(
    '[data-testid*="column-cell"], [data-testid*="column_cell"], .pulse-page-column-cell-container'
  )
  for (const cell of columnCells) {
    const cellEl = cell as HTMLElement
    // Try to get column name from a header or label element nearby
    const labelEl = cellEl.querySelector('[data-testid*="column-title"], [data-testid*="header"]')
    const valueEl = cellEl.querySelector('[data-testid*="column-value"]') || cellEl
    const colName = labelEl ? (labelEl.textContent || '').trim() : ''
    const colValue = (valueEl.textContent || '').trim()
    if (colName && colValue && !fields[colName]) {
      fields[colName] = colValue
    }
  }

  if (Object.keys(fields).length === 0) {
    warnings.push('Could not extract any column fields from the task')
  }

  // ── 5. Extract updates and replies ──────────────────────────────

  const updates: ExtractionResult['updates'] = []

  // Monday renders updates as blocks. Common selectors:
  const updateEls = Array.from(capturedUpdates.values())

  for (let i = 0; i < updateEls.length; i++) {
    const el = updateEls[i] as HTMLElement

    // Author: look for specific author elements
    const authorEl =
      el.querySelector('[data-testid*="creator-name"], [data-testid*="author"], .update-author-name') ||
      el.querySelector('.creator-name')
    const author = authorEl ? (authorEl.textContent || '').trim() : ''

    // Timestamp: look for actual <time> elements or datetime attributes
    let createdAt = ''
    const timeEl = el.querySelector('time[datetime]')
    if (timeEl) {
      createdAt = timeEl.getAttribute('datetime') || ''
    }
    if (!createdAt) {
      // Look for title/aria-label on timestamp elements that contain date info
      const timestampEl = el.querySelector(
        '[data-testid*="timestamp"], [data-testid*="created"], [data-testid*="date"]'
      )
      if (timestampEl) {
        createdAt =
          timestampEl.getAttribute('title') ||
          timestampEl.getAttribute('datetime') ||
          timestampEl.getAttribute('aria-label') ||
          (timestampEl.textContent || '').trim()
      }
    }
    if (!createdAt) {
      // Final attempt: any element with a title that looks like a date
      const allTimeCandidates = el.querySelectorAll('[title]')
      for (const tc of allTimeCandidates) {
        const titleVal = tc.getAttribute('title') || ''
        // Simple heuristic: if it contains common date patterns
        if (/\d{4}[-/]\d{2}[-/]\d{2}/.test(titleVal) || /\w+ \d{1,2},?\s+\d{4}/.test(titleVal)) {
          createdAt = titleVal
          break
        }
      }
    }

    // Body: look for the update body text
    const bodyEl =
      el.querySelector('[data-testid*="update-body"], [data-testid*="body"], .update-body, .post-content')
    const body = bodyEl ? (bodyEl.textContent || '').trim() : ''

    if (!author && !body) continue // Skip empty entries

    if (!createdAt) {
      warnings.push(`Update ${i}: timestamp not found in DOM, left empty`)
    }

    // Extract replies within this update
    const replies: ExtractionResult['updates'][number]['replies'] = []
    const replyEls = el.querySelectorAll(
      '[data-testid*="reply"], [data-testid*="comment"], .reply-component'
    )

    for (let j = 0; j < replyEls.length; j++) {
      const replyEl = replyEls[j] as HTMLElement

      const replyAuthorEl =
        replyEl.querySelector('[data-testid*="creator-name"], [data-testid*="author"]') ||
        replyEl.querySelector('.creator-name')
      const replyAuthor = replyAuthorEl ? (replyAuthorEl.textContent || '').trim() : ''

      let replyCreatedAt = ''
      const replyTimeEl = replyEl.querySelector('time[datetime]')
      if (replyTimeEl) {
        replyCreatedAt = replyTimeEl.getAttribute('datetime') || ''
      }
      if (!replyCreatedAt) {
        const replyTimestamp = replyEl.querySelector(
          '[data-testid*="timestamp"], [data-testid*="created"], [data-testid*="date"]'
        )
        if (replyTimestamp) {
          replyCreatedAt =
            replyTimestamp.getAttribute('title') ||
            replyTimestamp.getAttribute('datetime') ||
            replyTimestamp.getAttribute('aria-label') ||
            (replyTimestamp.textContent || '').trim()
        }
      }
      if (!replyCreatedAt) {
        warnings.push(`Update ${i}, reply ${j}: timestamp not found, left empty`)
      }

      const replyBodyEl =
        replyEl.querySelector('[data-testid*="body"], .reply-body, .post-content')
      const replyBody = replyBodyEl ? (replyBodyEl.textContent || '').trim() : ''

      if (replyAuthor || replyBody) {
        replies.push({
          id: replyEl.getAttribute('data-reply-id') || replyEl.getAttribute('data-id') || replyEl.id || `update-${i}-reply-${j}`,
          author: replyAuthor || 'Unknown',
          createdAt: replyCreatedAt,
          body: replyBody
        })
      }
    }

    updates.push({
      id: el.getAttribute('data-pulse-update-id') || el.getAttribute('data-update-id') || el.getAttribute('data-id') || el.id || `update-${i}`,
      author: author || 'Unknown',
      createdAt,
      body,
      replies
    })
  }

  if (Number.isFinite(expectedUpdateCount) && updates.length < expectedUpdateCount) {
    warnings.push(`Only ${updates.length} of ${expectedUpdateCount} updates were found in the DOM`)
  } else if (!Number.isFinite(expectedUpdateCount)) {
    warnings.push('Could not verify the total number of updates')
  }
  if (findClickableByText(
    ['previous', 'see more', 'load more', 'view more', 'show more', 'earlier updates'],
    'button, [role="button"], a'
  ).filter(isExpansionControl).some(el => el.getAttribute('aria-expanded') !== 'true')) {
    warnings.push('Some update or reply expansion controls remain visible')
  }

  // ── 6. Navigate to Files view to extract attachments ────────────

  const attachments: RawAttachment[] = []

  // Monday's task panel has a "Files" button — it may NOT be role="tab".
  // Look for any clickable element with "Files" text in the panel.
  const filesButtons = findClickableByText(['files'], 'button, [role="button"], [role="tab"]')
  const filesButton = filesButtons.find((el) => {
    const text = (el.textContent || '').toLowerCase().trim()
    // Must be specifically the "Files" nav, not a generic mention
    return /^files(?:\s*\/\s*\d+)?$/.test(text)
  })
  const expectedFileCount = Number((filesButton?.textContent || '').match(/\/\s*(\d+)/)?.[1] ?? NaN)

  if (filesButton) {
    filesButton.click()
    await delay(3000)

    // Look for actual file attachment links — NOT img thumbnails or avatars.
    // Valid sources:
    // 1. <a> elements with download attribute or href containing download/original keywords
    // 2. Links with explicit file metadata (name, size, type visible)
    // 3. Asset URLs that clearly point to full-size files

    const fileLinks = new Map<string, HTMLElement>()
    function collectFileLinks(): void {
      for (const el of document.querySelectorAll<HTMLElement>('a[href]')) {
        const key = `${el.getAttribute('href')}\u001f${el.getAttribute('download')}\u001f${el.textContent?.trim()}`
        fileLinks.set(key, el.cloneNode(true) as HTMLElement)
      }
    }
    collectFileLinks()
    const galleryItem = document.querySelector<HTMLElement>(
      '[data-testid*="file-gallery-item"], [data-testid*="asset-gallery"], [class*="file-cell"]'
    )
    let filesContainer: HTMLElement | null = null
    for (let node = galleryItem?.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (node.clientHeight > 0 && node.scrollHeight > node.clientHeight + 2 &&
          /auto|scroll/.test(style.overflowY)) {
        filesContainer = node
        break
      }
    }
    if (filesContainer) {
      filesContainer.scrollTop = 0
      await delay(250)
      collectFileLinks()
      let reachedEnd = false
      for (let i = 0; i < 50; i++) {
        const before = filesContainer.scrollTop
        filesContainer.scrollTop = Math.min(
          filesContainer.scrollHeight,
          before + Math.max(Math.floor(filesContainer.clientHeight * 0.8), 400)
        )
        await delay(450)
        collectFileLinks()
        if (filesContainer.scrollTop + filesContainer.clientHeight >= filesContainer.scrollHeight - 2) {
          await delay(500)
          collectFileLinks()
          if (filesContainer.scrollTop + filesContainer.clientHeight >= filesContainer.scrollHeight - 2) {
            reachedEnd = true
            break
          }
        }
        if (filesContainer.scrollTop === before) break
      }
      if (!reachedEnd) warnings.push('Could not reach the end of the Files gallery')
    }
    const links = Array.from(fileLinks.values())

    for (let i = 0; i < links.length; i++) {
      const linkEl = links[i] as HTMLElement
      const href = linkEl.getAttribute('href') || ''
      if (!href || href.startsWith('javascript:') || href === '#') continue

      let absoluteUrl: string
      try {
        absoluteUrl = new URL(href, location.href).href
      } catch {
        continue
      }

      // Determine if this is a legitimate file link
      const hasDownloadAttr = linkEl.hasAttribute('download')
      const isOriginalLink =
        /\/(original|download|raw)\b/i.test(absoluteUrl) ||
        hasDownloadAttr
      const ariaLabel = (linkEl.getAttribute('aria-label') || '').toLowerCase()
      const linkText = (linkEl.textContent || '').toLowerCase().trim()

      // Derive file name
      let fileName = ''
      if (hasDownloadAttr) {
        fileName = linkEl.getAttribute('download') || ''
      }
      if (!fileName) {
        // Try to find a filename-like text in the element or nearby
        const nameEl = linkEl.querySelector('[data-testid*="file-name"], [data-testid*="asset-name"]')
        if (nameEl) {
          fileName = (nameEl.textContent || '').trim()
        }
      }
      if (!fileName && ariaLabel) {
        fileName = ariaLabel
      }
      if (!fileName) {
        // Extract from URL path
        try {
          const urlPath = new URL(absoluteUrl).pathname
          const segments = urlPath.split('/')
          const lastSegment = segments[segments.length - 1]
          if (lastSegment && /\.\w{2,5}$/.test(lastSegment)) {
            fileName = decodeURIComponent(lastSegment)
          }
        } catch { /* ignore */ }
      }
      if (!fileName) {
        fileName = `attachment-${i}`
      }

      // Determine MIME type from file name extension
      let mimeType = 'application/octet-stream'
      const extMatch = fileName.match(/\.(\w+)$/)
      if (extMatch) {
        const ext = extMatch[1].toLowerCase()
        const mimeMap: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
          svg: 'image/svg+xml',
          pdf: 'application/pdf',
          doc: 'application/msword',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          xls: 'application/vnd.ms-excel',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          zip: 'application/zip'
        }
        if (mimeMap[ext]) {
          mimeType = mimeMap[ext]
        }
      }

      // Only include if this looks like an actual file link (not a thumbnail/avatar)
      const isThumbnail = /\/(thumb|thumbnail|preview|small|avatar|profile)/i.test(absoluteUrl)
      const isDataUri = absoluteUrl.startsWith('data:')

      if (isDataUri) continue
      if (isThumbnail && !isOriginalLink) {
        // This looks like a thumbnail — skip unless it's explicitly marked as download/original
        warnings.push(`Skipped thumbnail URL for "${fileName}" — not confirmed as original file`)
        continue
      }

      if (isOriginalLink || hasDownloadAttr || /\bdownload\b/.test(linkText) || ariaLabel.includes('download')) {
        attachments.push({
          id: `file-${i}`,
          name: fileName,
          mimeType,
          url: absoluteUrl
        })
      }
    }

    // If we found no valid file links, check for data-testid file containers
    if (attachments.length === 0) {
      // Look for file gallery items that may have data attributes with URLs
      const galleryItems = document.querySelectorAll(
        '[data-testid*="file-gallery-item"], [data-testid*="asset-gallery"], [class*="file-cell"]'
      )
      if (galleryItems.length > 0) {
        warnings.push(
          `Found ${galleryItems.length} file gallery items but could not extract verified download URLs. ` +
          'Only links explicitly marked as download/original are collected.'
        )
      }
    }
    if (Number.isFinite(expectedFileCount) && attachments.length < expectedFileCount) {
      warnings.push(`Files tab lists ${expectedFileCount} files but only ${attachments.length} verified original image links were found`)
    }

    // Navigate back to Updates view if possible
    if (updateTab) {
      updateTab.click()
      await delay(500)
    }
  } else {
    warnings.push('Could not find Files button in task panel')
  }

  // ── 7. Final completeness check ─────────────────────────────────

  // We NEVER claim complete=true at the content level.
  // The worker decides based on attachment statuses AND these warnings.
  // But we add explicit warnings if we couldn't verify full collection.

  if (expansionLimitHit) warnings.push('Reached the limit while expanding updates and replies')

  return {
    title,
    fields,
    updates,
    attachments,
    warnings
  }
}

// ─── Start ───────────────────────────────────────────────────────────

// Runs last so every helper above is initialised before a capture can call it
const hiddenCaptureId = hiddenFrameCaptureId()
if (hiddenCaptureId !== null) {
  void runHiddenCapture(hiddenCaptureId)
} else if (window === window.top) {
  // Other monday sub-frames (widgets, apps) are neither captures nor navigations to report
  watchNavigation()
}

export { extractTask }
