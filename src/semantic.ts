import { createHash, createHmac } from 'node:crypto'
import type { ElementHandle, Page } from 'playwright-core'
import type { BrowserSemanticNode } from './driver-contract.js'

export const SEMANTIC_SELECTOR = [
  'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
  '[role]', '[contenteditable="true"]', '[tabindex]',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label',
].join(',')

export interface RawSemanticCandidate {
  selector: string
  role: string
  name: string
  tag: string
  inputType: string
  interactive: boolean
  editable: boolean
  disabled: boolean
  /** Whether the element's box intersects the viewport at collection time. Not part of the identity fingerprint. */
  inViewport: boolean
  download: boolean
  href?: string
}

export interface StoredSemanticTarget extends RawSemanticCandidate {
  ref: string
  fingerprint: string
}

const compact = (value: string, max = 180): string => value.replace(/\s+/gu, ' ').trim().slice(0, max)

export function semanticFingerprint(candidate: RawSemanticCandidate): string {
  const stable = {
    role: candidate.role,
    name: candidate.name,
    tag: candidate.tag,
    inputType: candidate.inputType,
    interactive: candidate.interactive,
    editable: candidate.editable,
    disabled: candidate.disabled,
    download: candidate.download,
    href: candidate.href ?? '',
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('base64url').slice(0, 20)
}

export function opaqueRef(secret: Buffer, epoch: number, fingerprint: string, index: number): string {
  return 'br_' + createHmac('sha256', secret)
    .update(`${epoch}:${fingerprint}:${index}`)
    .digest('base64url')
    .slice(0, 18)
}

export function observationFingerprint(url: string, title: string, targets: StoredSemanticTarget[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ url, title, targets: targets.map((target) => target.fingerprint) }))
    .digest('base64url')
    .slice(0, 24)
}

export function publicSemanticNode(target: StoredSemanticTarget): BrowserSemanticNode {
  return {
    ref: target.ref,
    role: target.role,
    name: target.name,
    tag: target.tag,
    interactive: target.interactive,
    editable: target.editable,
    disabled: target.disabled,
    inViewport: target.inViewport,
    ...(target.href === undefined ? {} : { href: target.href }),
  }
}

/** Bounded DOM semantic projection. It never returns selectors or element ids. */
export async function collectSemanticCandidates(page: Page, scanLimit = 500): Promise<RawSemanticCandidate[]> {
  const raw = await page.locator(SEMANTIC_SELECTOR).evaluateAll((elements, limit) => {
    const normalize = (value: string | null | undefined, max = 180): string => String(value ?? '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, max)
    const implicitRole = (element: Element): string => {
      const tag = element.tagName.toLowerCase()
      if (tag === 'a' && element.hasAttribute('href')) return 'link'
      if (tag === 'button' || tag === 'summary') return 'button'
      if (tag === 'textarea') return 'textbox'
      if (tag === 'select') return 'combobox'
      if (/^h[1-6]$/u.test(tag)) return 'heading'
      if (tag === 'input') {
        const type = (element.getAttribute('type') ?? 'text').toLowerCase()
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
        if (type === 'range') return 'slider'
        return 'textbox'
      }
      return element.getAttribute('tabindex') === null ? 'generic' : 'focusable'
    }
    const accessibleName = (element: Element): string => {
      const labelledBy = element.getAttribute('aria-labelledby')
      if (labelledBy) {
        const joined = labelledBy.split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
        if (normalize(joined)) return normalize(joined)
      }
      const aria = normalize(element.getAttribute('aria-label'))
      if (aria) return aria
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const labels = Array.from(element.labels ?? []).map((label) => label.textContent ?? '').join(' ')
        if (normalize(labels)) return normalize(labels)
      }
      const alt = normalize(element.getAttribute('alt'))
      if (alt) return alt
      const title = normalize(element.getAttribute('title'))
      if (title) return title
      const placeholder = normalize(element.getAttribute('placeholder'))
      if (placeholder) return placeholder
      if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type) && normalize(element.value)) {
        return normalize(element.value)
      }
      return normalize(element.textContent)
    }
    const selectorFor = (element: Element): string => {
      const parts: string[] = []
      let current: Element | null = element
      while (current && current !== document.documentElement) {
        const tag = current.tagName.toLowerCase()
        let nth = 1
        let previous = current.previousElementSibling
        while (previous) {
          if (previous.tagName === current.tagName) nth += 1
          previous = previous.previousElementSibling
        }
        parts.unshift(`${tag}:nth-of-type(${nth})`)
        current = current.parentElement
      }
      return `html > ${parts.join(' > ')}`
    }
    const safeHref = (element: Element): string | undefined => {
      const value = element.getAttribute('href')
      if (!value) return undefined
      try {
        const parsed = new URL(value, location.href)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
        parsed.username = ''
        parsed.password = ''
        parsed.search = ''
        parsed.hash = ''
        return parsed.href.slice(0, 500)
      } catch { return undefined }
    }
    const output: Array<Record<string, unknown>> = []
    for (const element of elements.slice(0, Number(limit))) {
      const html = element as HTMLElement
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
      if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length === 0) continue
      const tag = element.tagName.toLowerCase()
      const inputType = tag === 'input' ? (element.getAttribute('type') ?? 'text').toLowerCase() : ''
      const role = normalize(element.getAttribute('role')) || implicitRole(element)
      const editable = tag === 'input' || tag === 'textarea' || html.isContentEditable
      const interactive = editable || ['a', 'button', 'select', 'summary'].includes(tag)
        || element.hasAttribute('tabindex') || role !== 'generic' && role !== 'heading'
      const disabled = element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true'
      const inViewport = rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight
      const href = safeHref(element)
      output.push({
        selector: selectorFor(element), role, name: accessibleName(element), tag, inputType,
        interactive, editable, disabled, inViewport,
        download: element.hasAttribute('download'),
        ...(href === undefined ? {} : { href }),
      })
    }
    return output
  }, scanLimit)

  return raw.map((value) => ({
    selector: String(value.selector),
    role: compact(String(value.role || 'generic'), 60),
    name: compact(String(value.name || ''), 180),
    tag: compact(String(value.tag || ''), 30),
    inputType: compact(String(value.inputType || ''), 30),
    interactive: value.interactive === true,
    editable: value.editable === true,
    disabled: value.disabled === true,
    inViewport: value.inViewport === true,
    download: value.download === true,
    ...(typeof value.href === 'string' ? { href: compact(value.href, 500) } : {}),
  }))
}

/**
 * Re-read semantics from one already-bound backend node. Actions use this
 * exact ElementHandle through risk, hit-test, and dispatch so a selector can
 * never silently resolve to a replacement node between those stages.
 */
export async function inspectSemanticHandle(
  handle: ElementHandle<Element>,
  selector: string,
): Promise<RawSemanticCandidate | null> {
  const value = await handle.evaluate((element) => {
    const normalize = (raw: string | null | undefined, max = 180): string => String(raw ?? '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, max)
    const implicitRole = (): string => {
      const tag = element.tagName.toLowerCase()
      if (tag === 'a' && element.hasAttribute('href')) return 'link'
      if (tag === 'button' || tag === 'summary') return 'button'
      if (tag === 'textarea') return 'textbox'
      if (tag === 'select') return 'combobox'
      if (/^h[1-6]$/u.test(tag)) return 'heading'
      if (tag === 'input') {
        const type = (element.getAttribute('type') ?? 'text').toLowerCase()
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
        if (type === 'range') return 'slider'
        return 'textbox'
      }
      return element.getAttribute('tabindex') === null ? 'generic' : 'focusable'
    }
    const accessibleName = (): string => {
      const labelledBy = element.getAttribute('aria-labelledby')
      if (labelledBy) {
        const joined = labelledBy.split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
        if (normalize(joined)) return normalize(joined)
      }
      const aria = normalize(element.getAttribute('aria-label'))
      if (aria) return aria
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const labels = Array.from(element.labels ?? []).map((label) => label.textContent ?? '').join(' ')
        if (normalize(labels)) return normalize(labels)
      }
      const alt = normalize(element.getAttribute('alt'))
      if (alt) return alt
      const title = normalize(element.getAttribute('title'))
      if (title) return title
      const placeholder = normalize(element.getAttribute('placeholder'))
      if (placeholder) return placeholder
      if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type) && normalize(element.value)) {
        return normalize(element.value)
      }
      return normalize(element.textContent)
    }
    const safeHref = (): string | undefined => {
      const raw = element.getAttribute('href')
      if (!raw) return undefined
      try {
        const parsed = new URL(raw, location.href)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
        parsed.username = ''
        parsed.password = ''
        parsed.search = ''
        parsed.hash = ''
        return parsed.href.slice(0, 500)
      } catch { return undefined }
    }
    if (!element.isConnected) return null
    const html = element as HTMLElement
    const tag = element.tagName.toLowerCase()
    const inputType = tag === 'input' ? (element.getAttribute('type') ?? 'text').toLowerCase() : ''
    const role = normalize(element.getAttribute('role')) || implicitRole()
    const editable = tag === 'input' || tag === 'textarea' || html.isContentEditable
    const interactive = editable || ['a', 'button', 'select', 'summary'].includes(tag)
      || element.hasAttribute('tabindex') || role !== 'generic' && role !== 'heading'
    const href = safeHref()
    const rect = element.getBoundingClientRect()
    const inViewport = rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight
    return {
      role,
      name: accessibleName(),
      tag,
      inputType,
      interactive,
      editable,
      disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
      inViewport,
      download: element.hasAttribute('download'),
      ...(href === undefined ? {} : { href }),
    }
  })
  if (value === null) return null
  return { selector, ...value }
}
