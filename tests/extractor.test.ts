import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

test('extension extracts a task update and a verified original image link', { timeout: 12_000 }, async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <h1>Example task</h1>
    <div data-testid="column-cell"><span data-testid="column-title">Status</span><span data-testid="column-value">Done</span></div>
    <button>Updates / 1</button>
    <div class="updates-feed">
      <article role="article"><span data-testid="author">Claire</span><time datetime="2026-10-07T09:00:00Z"></time>
        <div data-testid="update-body">Please review the image.</div></article>
    </div>
    <button>Files</button>
    <a download="original.png" href="https://cdn.monday.com/original.png">Download</a>
  </body></html>`, {
    url: 'https://team.monday.com/boards/123/pulses/456',
    pretendToBeVisual: true
  })

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    MutationObserver: dom.window.MutationObserver,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    chrome: {
      runtime: {
        sendMessage: () => {},
        onMessage: { addListener: () => {} }
      }
    }
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return dom.window.document.body }
  })

  try {
    const { extractTask } = await import('../extension/content.js')
    const task = await extractTask()
    assert.equal(task.title, 'Example task')
    assert.equal(task.fields.Status, 'Done')
    assert.equal(task.updates.length, 1)
    assert.equal(task.updates[0].body, 'Please review the image.')
    assert.equal(task.updates[0].createdAt, '2026-10-07T09:00:00Z')
    assert.equal(task.attachments.length, 1)
    assert.equal(task.attachments[0].url, 'https://cdn.monday.com/original.png')
    assert.deepEqual(task.warnings, [])
  } finally {
    dom.window.close()
  }
})

test('retains updates removed by a virtualized feed while scrolling', { timeout: 12_000 }, async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <h1>Virtual task</h1>
    <div data-testid="column-cell"><span data-testid="column-title">Status</span><span data-testid="column-value">Done</span></div>
    <button>Updates / 2</button>
    <div class="updates-feed"><article role="article" data-update-id="one"><span data-testid="author">A</span><time datetime="2026-10-01"></time><div data-testid="update-body">First</div></article></div>
    <button>Files</button>
  </body></html>`, {
    url: 'https://team.monday.com/boards/123/pulses/456',
    pretendToBeVisual: true
  })
  const feed = dom.window.document.querySelector('.updates-feed') as HTMLElement
  Object.defineProperty(feed, 'clientHeight', { get: () => 400 })
  Object.defineProperty(feed, 'scrollHeight', { get: () => 900 })
  let position = 0
  Object.defineProperty(feed, 'scrollTop', {
    get: () => position,
    set: value => {
      position = Math.min(Number(value), 500)
      if (position >= 400) {
        feed.innerHTML = '<article role="article" data-update-id="two"><span data-testid="author">B</span><time datetime="2026-10-02"></time><div data-testid="update-body">Second</div></article>'
      }
    }
  })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    MutationObserver: dom.window.MutationObserver,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    chrome: { runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} } } }
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return dom.window.document.body }
  })
  try {
    const { extractTask } = await import('../extension/content.js')
    const task = await extractTask()
    assert.deepEqual(task.updates.map(update => update.body), ['First', 'Second'])
    assert.deepEqual(task.warnings, [])
  } finally {
    dom.window.close()
  }
})
