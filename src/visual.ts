import { inflateSync } from 'node:zlib'
import type { ElementHandle, Page } from 'playwright-core'
import type { BrowserVisualQuality, BrowserVisualQualityClassification } from './driver-contract.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_QUALITY_SAMPLES = 4096
const ALPHA_THRESHOLD = 16

interface DecodedPng {
  width: number
  height: number
  rgba: Uint8Array
}

function decodePng(png: Buffer): DecodedPng {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('capture is not a PNG image')
  }
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Buffer | undefined
  let transparency: Buffer | undefined
  const idat: Buffer[] = []
  let offset = 8
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data.readUInt8(8)
      colorType = data.readUInt8(9)
      interlace = data.readUInt8(12)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      transparency = data
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (width <= 0 || height <= 0) throw new Error('capture has invalid PNG dimensions')
  if (interlace !== 0) throw new Error('interlaced PNG captures are not supported')

  const channels = colorType === 0 ? 1
    : colorType === 2 ? 3
    : colorType === 3 ? 1
    : colorType === 4 ? 2
    : colorType === 6 ? 4
    : 0
  if (channels === 0) throw new Error('unsupported PNG color type ' + colorType)
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error('unsupported PNG bit depth ' + bitDepth)
  if (colorType === 3 && !palette) throw new Error('palette PNG capture is missing a palette')

  const bytesPerSample = bitDepth === 16 ? 2 : 1
  const bpp = channels * bytesPerSample
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const rgba = new Uint8Array(width * height * 4)
  let previous = new Uint8Array(stride)

  const sampleByte = (row: Uint8Array, column: number, channel: number): number => {
    const index = column * bpp + channel * bytesPerSample
    return row[index] ?? 0
  }

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const recon = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? recon[i - bpp] ?? 0 : 0
      const up = previous[i] ?? 0
      const upLeft = i >= bpp ? previous[i - bpp] ?? 0 : 0
      const rawByte = row[i] ?? 0
      let value: number
      switch (filter) {
        case 0: value = rawByte; break
        case 1: value = rawByte + left; break
        case 2: value = rawByte + up; break
        case 3: value = rawByte + ((left + up) >> 1); break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          value = rawByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
          break
        }
        default: throw new Error('unsupported PNG filter ' + filter)
      }
      recon[i] = value & 0xff
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colorType === 0) {
        const g = sampleByte(recon, x, 0)
        rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255
      } else if (colorType === 2) {
        rgba[o] = sampleByte(recon, x, 0)
        rgba[o + 1] = sampleByte(recon, x, 1)
        rgba[o + 2] = sampleByte(recon, x, 2)
        rgba[o + 3] = 255
      } else if (colorType === 4) {
        const g = sampleByte(recon, x, 0)
        rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g
        rgba[o + 3] = sampleByte(recon, x, 1)
      } else if (colorType === 6) {
        rgba[o] = sampleByte(recon, x, 0)
        rgba[o + 1] = sampleByte(recon, x, 1)
        rgba[o + 2] = sampleByte(recon, x, 2)
        rgba[o + 3] = sampleByte(recon, x, 3)
      } else if (palette) {
        const index = sampleByte(recon, x, 0)
        const base = index * 3
        rgba[o] = palette[base] ?? 0
        rgba[o + 1] = palette[base + 1] ?? 0
        rgba[o + 2] = palette[base + 2] ?? 0
        rgba[o + 3] = transparency && index < transparency.length ? transparency[index] ?? 255 : 255
      }
    }
    previous = recon
  }
  return { width, height, rgba }
}

export interface PngAnalysis {
  width: number
  height: number
  quality: BrowserVisualQuality
}

export function analyzePng(png: Buffer): PngAnalysis {
  const { width, height, rgba } = decodePng(png)
  const total = width * height
  const step = Math.max(1, Math.floor(Math.sqrt(total / MAX_QUALITY_SAMPLES)))
  let sampleCount = 0
  let visibleCount = 0
  let sumLuminance = 0
  let sumLuminanceSquared = 0
  let minLuminance = 1
  let maxLuminance = 0
  let darkCount = 0
  let lightCount = 0
  const buckets = new Set<number>()

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const o = (y * width + x) * 4
      const r = rgba[o] ?? 0
      const g = rgba[o + 1] ?? 0
      const b = rgba[o + 2] ?? 0
      const a = rgba[o + 3] ?? 0
      sampleCount += 1
      if (a < ALPHA_THRESHOLD) continue
      visibleCount += 1
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      sumLuminance += luminance
      sumLuminanceSquared += luminance * luminance
      if (luminance < minLuminance) minLuminance = luminance
      if (luminance > maxLuminance) maxLuminance = luminance
      if (luminance < 32 / 255) darkCount += 1
      if (luminance > 224 / 255) lightCount += 1
      buckets.add(((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6))
    }
  }

  const visibleFraction = sampleCount === 0 ? 0 : visibleCount / sampleCount
  const meanLuminance = visibleCount === 0 ? 0 : sumLuminance / visibleCount
  const luminanceVariance = visibleCount === 0
    ? 0
    : Math.max(0, sumLuminanceSquared / visibleCount - meanLuminance * meanLuminance)
  const luminanceRange = visibleCount === 0 ? 0 : maxLuminance - minLuminance
  const darkFraction = visibleCount === 0 ? 0 : darkCount / visibleCount
  const lightFraction = visibleCount === 0 ? 0 : lightCount / visibleCount

  let classification: BrowserVisualQualityClassification
  if (visibleFraction < 0.01) classification = 'transparent'
  else if (visibleFraction < 0.3) classification = 'mostly-transparent'
  else if (meanLuminance < 0.02) classification = 'near-black'
  else if (meanLuminance > 0.98) classification = 'near-white'
  else if (luminanceRange < 0.05 && luminanceVariance < 0.0005) classification = 'near-uniform'
  else classification = 'usable'

  return {
    width,
    height,
    quality: {
      classification,
      usable: classification === 'usable',
      sampleCount,
      visibleFraction,
      meanLuminance,
      luminanceVariance,
      luminanceRange,
      darkFraction,
      lightFraction,
      distinctColorBuckets: buckets.size,
    },
  }
}

export interface MeasuredBox {
  found: boolean
  connected: boolean
  hidden: boolean
  zeroSize: boolean
  inViewport: boolean
  inDocument: boolean
  occluded: boolean
  box: { x: number; y: number; width: number; height: number }
  viewportBox: { x: number; y: number; width: number; height: number }
}

export interface BoxMeasurement {
  docWidth: number
  docHeight: number
  viewportWidth: number
  viewportHeight: number
  rows: MeasuredBox[]
}

export async function measureSemanticBoxes(page: Page, selectors: string[]): Promise<BoxMeasurement> {
  return page.evaluate((values) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const docWidth = Math.max(document.documentElement.scrollWidth, vw)
    const docHeight = Math.max(document.documentElement.scrollHeight, vh)
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const empty = { x: 0, y: 0, width: 0, height: 0 }
    const rows = values.map((selector) => {
      const el = document.querySelector(selector)
      if (!el) {
        return {
          found: false, connected: false, hidden: false, zeroSize: false,
          inViewport: false, inDocument: false, occluded: false,
          box: empty, viewportBox: empty,
        }
      }
      const connected = el.isConnected
      const style = getComputedStyle(el)
      const hidden = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
      const rect = el.getBoundingClientRect()
      const zeroSize = rect.width <= 0 || rect.height <= 0
      const inViewport = rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh
      const boxX = rect.left + scrollX
      const boxY = rect.top + scrollY
      const inDocument = boxX + rect.width > 0 && boxY + rect.height > 0 && boxX < docWidth && boxY < docHeight
      let occluded = false
      if (!zeroSize && !hidden && connected) {
        const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), vw - 1)
        const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), vh - 1)
        const top = document.elementFromPoint(cx, cy)
        occluded = top === null || (top !== el && !el.contains(top) && !top.contains(el))
      }
      return {
        found: true, connected, hidden, zeroSize, inViewport, inDocument, occluded,
        box: { x: boxX, y: boxY, width: rect.width, height: rect.height },
        viewportBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      }
    })
    return { docWidth, docHeight, viewportWidth: vw, viewportHeight: vh, rows }
  }, selectors)
}

/**
 * Measure the live boxes of the exact DOM nodes the retained observation
 * handles denote. Unlike selector-based measurement, a twin element that slid
 * into the stored selector path can never be measured and labeled in place of
 * the original: each row is the original node (or reports it detached), so a
 * Set-of-Mark label is never drawn on a different element than its ref denotes.
 */
export async function measureSemanticBoxesByHandles(page: Page, targets: Array<ElementHandle<Element> | null>): Promise<BoxMeasurement> {
  return page.evaluate((values) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const docWidth = Math.max(document.documentElement.scrollWidth, vw)
    const docHeight = Math.max(document.documentElement.scrollHeight, vh)
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const empty = { x: 0, y: 0, width: 0, height: 0 }
    const rows = values.map((el) => {
      if (!el) {
        return {
          found: false, connected: false, hidden: false, zeroSize: false,
          inViewport: false, inDocument: false, occluded: false,
          box: empty, viewportBox: empty,
        }
      }
      const connected = el.isConnected
      if (!connected) {
        return {
          found: true, connected: false, hidden: false, zeroSize: false,
          inViewport: false, inDocument: false, occluded: false,
          box: empty, viewportBox: empty,
        }
      }
      const style = getComputedStyle(el)
      const hidden = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
      const rect = el.getBoundingClientRect()
      const zeroSize = rect.width <= 0 || rect.height <= 0
      const inViewport = rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh
      const boxX = rect.left + scrollX
      const boxY = rect.top + scrollY
      const inDocument = boxX + rect.width > 0 && boxY + rect.height > 0 && boxX < docWidth && boxY < docHeight
      let occluded = false
      if (!zeroSize && !hidden) {
        const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), vw - 1)
        const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), vh - 1)
        const top = document.elementFromPoint(cx, cy)
        occluded = top === null || (top !== el && !el.contains(top) && !top.contains(el))
      }
      return {
        found: true, connected, hidden, zeroSize, inViewport, inDocument, occluded,
        box: { x: boxX, y: boxY, width: rect.width, height: rect.height },
        viewportBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      }
    })
    return { docWidth, docHeight, viewportWidth: vw, viewportHeight: vh, rows }
  }, targets)
}

