import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Store } from '../bridge/store.js'
import type { TaskSnapshot } from '../shared/types.js'

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9H8xkAAAAASUVORK5CYII='

test('MCP exposes cached task and original image with no monday API token', { timeout: 20_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'monday-bridge-mcp-'))
  const snapshot: TaskSnapshot = {
    sourceUrl: 'https://team.monday.com/boards/123/pulses/456',
    accountHost: 'team.monday.com', boardId: '123', itemId: '456',
    title: 'MCP image task', fields: {}, updates: [],
    attachments: [{ id: 'original-1', name: 'original.png', mimeType: 'image/png', status: 'ready' }],
    capturedAt: new Date().toISOString(), captureReason: 'auto', complete: true, warnings: []
  }

  const store = new Store(dataDir)
  await store.init()
  await store.saveSnapshot('mcp-test-capture', snapshot, [{
    id: 'original-1', name: 'original.png', mimeType: 'image/png', dataBase64: pngBase64
  }])

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('node_modules/tsx/dist/cli.mjs'), 'bridge/mcp.ts'],
    cwd: process.cwd(),
    env: { ...process.env, MONDAY_BRIDGE_DATA_DIR: dataDir, MONDAY_BRIDGE_PORT: '1' }
  })
  const client = new Client({ name: 'monday-bridge-test', version: '1.0.0' })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.ok(tools.tools.some(tool => tool.name === 'monday_get_task'))
    assert.ok(tools.tools.some(tool => tool.name === 'monday_get_image'))

    const task = await client.callTool({ name: 'monday_get_task', arguments: {} })
    assert.equal(task.isError, undefined)
    const taskContent = task.content as Array<{ type: string; text?: string }>
    const taskText = taskContent.find(block => block.type === 'text')
    assert.ok(taskText && taskText.type === 'text')
    assert.equal(JSON.parse(taskText.text!).snapshot.title, 'MCP image task')

    const named = await client.callTool({ name: 'monday_get_task', arguments: { itemId: '456' } })
    assert.equal(named.isError, undefined)
    const wrong = await client.callTool({ name: 'monday_get_task', arguments: { itemId: '999' } })
    assert.equal(wrong.isError, true)

    const image = await client.callTool({
      name: 'monday_get_image', arguments: { imageId: 'original-1' }
    })
    assert.equal(image.isError, undefined)
    const imageContent = image.content as Array<{ type: string; mimeType?: string; data?: string }>
    const imageBlock = imageContent.find(block => block.type === 'image')
    assert.ok(imageBlock && imageBlock.type === 'image')
    assert.equal(imageBlock.mimeType, 'image/png')
    assert.equal(imageBlock.data, pngBase64)
  } finally {
    await client.close()
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep))
    await rm(dataDir, { recursive: true, force: true })
  }
})
