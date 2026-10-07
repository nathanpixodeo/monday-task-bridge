// Generates the extension icons. Run once with node scripts/generate-icons.mjs and commit the PNGs.
import { crc32, deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const PADDING = { 16: 0, 32: 1, 48: 2, 128: 12 }

const GRADIENTS = {
  on: {
    start: [139, 92, 246], // #8B5CF6
    end: [79, 70, 229]      // #4F46E5
  },
  off: {
    start: [148, 163, 184], // #94A3B8
    end: [71, 85, 105]      // #475569
  }
}

const THETA_RAD = (40 * Math.PI) / 180
const CAP_DX = 0.25 * Math.sin(THETA_RAD)
const CAP_DY = 0.25 * Math.cos(THETA_RAD)
const CAP1_X = 0.5 + CAP_DX
const CAP1_Y = 0.55 - CAP_DY
const CAP2_X = 0.5 - CAP_DX
const CAP2_Y = 0.55 - CAP_DY

const inSquircle = (u, v) => {
  const r = 0.25
  const qx = Math.abs(u - 0.5) - (0.5 - r)
  const qy = Math.abs(v - 0.5) - (0.5 - r)
  const lenMaxQ = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const minMaxQ = Math.min(Math.max(qx, qy), 0)
  const d = lenMaxQ + minMaxQ - r
  return d <= 0
}

const inGlyph = (u, v, halfW) => {
  // Ring: center c = (0.5, 0.55), radius R = 0.25
  const distC = Math.hypot(u - 0.5, v - 0.55)
  const ang = (Math.atan2(u - 0.5, -(v - 0.55)) * 180) / Math.PI
  if (Math.abs(distC - 0.25) <= halfW && Math.abs(ang) >= 40) {
    return true
  }

  // Round caps: discs of radius w/2 at c + R*(sin(theta), -cos(theta)) for theta = +/-40 deg
  if (
    Math.hypot(u - CAP1_X, v - CAP1_Y) <= halfW ||
    Math.hypot(u - CAP2_X, v - CAP2_Y) <= halfW
  ) {
    return true
  }

  // Bar: capsule (segment distance <= w/2) from (0.5, 0.20) to (0.5, 0.52)
  const clampedY = Math.min(Math.max(v, 0.2), 0.52)
  return Math.hypot(u - 0.5, v - clampedY) <= halfW
}

const getFill = (variant, u, v) => {
  const t = Math.min(Math.max((u + v) / 2, 0), 1)
  const { start, end } = GRADIENTS[variant]
  const r = start[0] + (end[0] - start[0]) * t
  const g = start[1] + (end[1] - start[1]) * t
  const b = start[2] + (end[2] - start[2]) * t

  const sheenDist = Math.hypot(u - 0.25, v - 0.15)
  const sheenFactor = Math.min(Math.max(1 - sheenDist / 0.75, 0), 1)
  const a = 0.18 * sheenFactor * sheenFactor

  return [
    r * (1 - a) + 255 * a,
    g * (1 - a) + 255 * a,
    b * (1 - a) + 255 * a
  ]
}

const renderIcon = (variant, size) => {
  const p = PADDING[size]
  const b = size - 2 * p
  const halfW = (size <= 32 ? 0.115 : 0.095) / 2
  const rowBytes = 1 + size * 4
  const raw = Buffer.alloc(size * rowBytes)

  for (let iy = 0; iy < size; iy++) {
    const rowOffset = iy * rowBytes
    raw[rowOffset] = 0

    for (let ix = 0; ix < size; ix++) {
      let bgCount = 0
      let fgCount = 0

      for (let sy = 0; sy < 8; sy++) {
        const y = iy + (sy + 0.5) / 8
        const v = (y - p) / b
        for (let sx = 0; sx < 8; sx++) {
          const x = ix + (sx + 0.5) / 8
          const u = (x - p) / b

          if (inSquircle(u, v)) {
            bgCount++
            if (inGlyph(u, v, halfW)) {
              fgCount++
            }
          }
        }
      }

      if (bgCount > 0) {
        const offset = rowOffset + 1 + ix * 4
        const centerU = (ix + 0.5 - p) / b
        const centerV = (iy + 0.5 - p) / b
        const [fillR, fillG, fillB] = getFill(variant, centerU, centerV)

        const s = fgCount / bgCount
        const bg = bgCount / 64

        raw[offset] = Math.round(fillR * (1 - s) + 255 * s)
        raw[offset + 1] = Math.round(fillG * (1 - s) + 255 * s)
        raw[offset + 2] = Math.round(fillB * (1 - s) + 255 * s)
        raw[offset + 3] = Math.round(255 * bg)
      }
    }
  }

  return raw
}

const makeChunk = (typeStr, data = Buffer.alloc(0)) => {
  const type = Buffer.from(typeStr, 'ascii')
  const lengthBuf = Buffer.alloc(4)
  lengthBuf.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([type, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(typeAndData) >>> 0, 0)
  return Buffer.concat([lengthBuf, typeAndData, crcBuf])
}

const encodePng = (variant, size) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = deflateSync(renderIcon(variant, size))
  return Buffer.concat([
    PNG_SIG,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND')
  ])
}

const root = resolve(import.meta.dirname, '..')
const iconsDir = resolve(root, 'extension/icons')
await mkdir(iconsDir, { recursive: true })

for (const variant of ['on', 'off']) {
  for (const size of [16, 32, 48, 128]) {
    const filename = variant === 'on' ? `icon-${size}.png` : `icon-off-${size}.png`
    await writeFile(resolve(iconsDir, filename), encodePng(variant, size))
  }
}
