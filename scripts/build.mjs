import { build } from 'esbuild'
import { build as viteBuild } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdir, copyFile, cp } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
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
  absWorkingDir: root
})

await build({
  entryPoints: ['extension/worker.ts', 'extension/content.ts', 'extension/offscreen.ts'],
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
await copyFile(resolve(root, 'extension/offscreen.html'), resolve(extensionOut, 'offscreen.html'))
await cp(resolve(root, 'extension/icons'), resolve(extensionOut, 'icons'), { recursive: true })
