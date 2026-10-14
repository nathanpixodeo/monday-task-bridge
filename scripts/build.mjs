import { build } from 'esbuild'
import { build as viteBuild } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdir, copyFile, cp, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
// One id per build. A running bridge compares it with dist/bridge/build-id.txt and steps aside for a newer build.
const buildId = `${new Date().toISOString()}-${randomBytes(3).toString('hex')}`
const bridgeOut = resolve(root, 'dist/bridge')
const extensionOut = resolve(root, 'dist/extension')
await mkdir(bridgeOut, { recursive: true })
await mkdir(extensionOut, { recursive: true })

await build({
  entryPoints: ['bridge/server.ts', 'bridge/mcp.ts', 'bridge/pair-cli.ts'],
  outdir: bridgeOut,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  absWorkingDir: root,
  define: { __BRIDGE_BUILD__: JSON.stringify(buildId) }
})

await build({
  entryPoints: ['extension/worker.ts'],
  outdir: extensionOut,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome116',
  absWorkingDir: root
})

await viteBuild({
  root: resolve(root, 'extension'),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: extensionOut,
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: { input: resolve(root, 'extension/popup.html') }
  }
})

await copyFile(resolve(root, 'extension/manifest.json'), resolve(extensionOut, 'manifest.json'))
await cp(resolve(root, 'extension/icons'), resolve(extensionOut, 'icons'), { recursive: true })
// Written last: a bridge only steps aside once every file of this build is in place.
await writeFile(resolve(bridgeOut, 'build-id.txt'), buildId)
console.log(`Bridge build ${buildId}`)
