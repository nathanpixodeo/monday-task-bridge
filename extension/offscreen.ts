/**
 * Offscreen document: hosts the invisible frames that load monday task pages for capture,
 * so a capture never opens a tab. The content script inside each frame reads the task and
 * reports straight to the worker; this page only opens and closes frames.
 */

import { HIDDEN_FRAME_PREFIX } from './helpers/hidden-frame'

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false

  if (msg.type === 'open-frame') {
    const frame = document.createElement('iframe')
    frame.name = `${HIDDEN_FRAME_PREFIX}${msg.captureId}`
    frame.dataset.captureId = msg.captureId
    // monday lays the task panel out for a desktop window; a small frame hides tabs and controls
    frame.style.width = '1440px'
    frame.style.height = '900px'
    frame.src = msg.url
    document.body.append(frame)
    // An offscreen page never renders, so it never lays out on its own and the frame would stay 0×0:
    // every element inside would look hidden to the reader. Reading a size forces one layout.
    void frame.offsetWidth
    sendResponse({ ok: true })
  } else if (msg.type === 'close-frame') {
    document.querySelector(`iframe[data-capture-id="${CSS.escape(msg.captureId)}"]`)?.remove()
    sendResponse({ ok: true })
  }
  return false
})
