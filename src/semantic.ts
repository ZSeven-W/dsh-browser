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
  /**
   * Position of this match in the full main-frame selector result list, used to
   * zip candidates with the ElementHandles captured at collection time. Not
   * part of the identity fingerprint and never serialized to consumers. Absent
   * on the handle re-inspection path, which never re-binds by index.
   */
  matchIndex?: number
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
  /**
   * Bounded, whitespace-compacted observable value of a value-bearing control.
   * Absent when the element has no value, when the value was withheld, and on
   * the bound-handle re-resolution path, which never reads values at all.
   * Not part of the identity fingerprint.
   */
  value?: string
  /** True when the element bears a secret value that was deliberately never read. Not part of the identity fingerprint. */
  valueWithheld?: true
  /** True when the observable value exceeded the bound and `value` holds only its prefix. Not part of the identity fingerprint. */
  valueTruncated?: true
}

export interface StoredSemanticTarget extends RawSemanticCandidate {
  ref: string
  fingerprint: string
  /**
   * The Playwright element handle captured at observation time. A ref resolves
   * to THIS node and never to a selector re-match, so an identical twin sliding
   * into the stored selector path can never be substituted for the original.
   */
  handle?: ElementHandle<Element>
}

const compact = (value: string, max = 180): string => value.replace(/\s+/gu, ' ').trim().slice(0, max)

/**
 * Identity fingerprint used to re-resolve a ref against the live DOM. It covers
 * only properties that answer "which element is this": `inViewport` (a
 * scroll-dependent fact) and the value fields (`value`, `valueWithheld`,
 * `valueTruncated` — fill-, keystroke-, or script-dependent facts) are
 * deliberately excluded, so a value change alone never invalidates a ref the
 * way navigation or a semantic change does.
 */
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
    ...(target.valueWithheld === true
      ? { valueWithheld: true as const }
      : target.value === undefined
        ? {}
        : {
            value: target.value,
            ...(target.valueTruncated === true ? { valueTruncated: true as const } : {}),
          }),
  }
}

export interface SemanticScanResult {
  candidates: RawSemanticCandidate[]
  /** Total selector matches in the main frame, before any filtering or budget. */
  totalMatches: number
  /** Number of matches the scan window actually examined (min(total, scanLimit)). */
  scanned: number
}

/** Bounded DOM semantic projection. It never returns selectors or element ids. */
export async function collectSemanticCandidates(page: Page, scanLimit = 500): Promise<SemanticScanResult> {
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
    const VALUE_MAX = 180
    /**
     * Input types whose `.value` is a credential, a fake upload path, an
     * interface label already carried by `name`, or a checked-state rather than
     * a value. Checkedness is intentionally not modelled as a value.
     */
    const valuelessInputTypes = ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden']
    /** Autocomplete tokens by which a page declares a field secret-bearing. */
    const secretAutocomplete = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc']
    const bearsSecret = (element: Element, inputType: string): boolean => {
      if (inputType === 'password') return true
      const declared = String(element.getAttribute('autocomplete') ?? '').toLowerCase()
      if (declared.split(/[\s,]+/u).some((token) => secretAutocomplete.includes(token))) return true
      // A value-bearing control hidden from assistive technology is the shape used
      // by masked/secure widgets: fail closed and never read it.
      if (element.closest('[aria-hidden="true"]') !== null) return true
      // CSS text masking (-webkit-text-security: disc|circle|square) renders
      // bullets to the user, so the value is a secret and must never be read.
      const style = getComputedStyle(element) as CSSStyleDeclaration & { webkitTextSecurity?: string; textSecurity?: string }
      const masking = String(style.webkitTextSecurity ?? style.textSecurity ?? '')
      return masking === 'disc' || masking === 'circle' || masking === 'square'
    }
    /**
     * Read the observable value of a value-bearing control. A secret-bearing
     * control is never read at all: the secret does not cross this boundary,
     * and the caller receives the explicit `valueWithheld` marker instead.
     */
    const observableValue = (element: Element, inputType: string): Record<string, unknown> => {
      const html = element as HTMLElement
      const nativeValue = element instanceof HTMLInputElement
        ? (valuelessInputTypes.includes(inputType) ? null : element.value)
        : element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? element.value
          : html.isContentEditable
            ? element.textContent
            : null
      const ariaText = String(element.getAttribute('aria-valuetext') ?? '')
      const ariaNow = String(element.getAttribute('aria-valuenow') ?? '')
      const aria = ariaText.trim() === '' ? ariaNow : ariaText
      if (nativeValue === null && aria.trim() === '') return {}
      if (bearsSecret(element, inputType)) return { valueWithheld: true }
      const raw = nativeValue === null ? aria : nativeValue
      const bounded = raw.slice(0, VALUE_MAX * 4)
      const collapsed = bounded.replace(/\s+/gu, ' ').trim()
      return {
        value: collapsed.slice(0, VALUE_MAX),
        ...(collapsed.length > VALUE_MAX || raw.length > bounded.length ? { valueTruncated: true } : {}),
      }
    }
    const output: Array<Record<string, unknown>> = []
    const scanned = Math.min(elements.length, Number(limit))
    for (let matchIndex = 0; matchIndex < scanned; matchIndex += 1) {
      const element = elements[matchIndex] as Element
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
        selector: selectorFor(element), matchIndex, role, name: accessibleName(element), tag, inputType,
        interactive, editable, disabled, inViewport,
        download: element.hasAttribute('download'),
        ...(href === undefined ? {} : { href }),
        ...observableValue(element, inputType),
      })
    }
    return { output, totalMatches: elements.length, scanned }
  }, scanLimit)

  return {
    candidates: raw.output.map((value) => ({
    selector: String(value.selector),
    matchIndex: Number(value.matchIndex),
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
    ...(value.valueWithheld === true
      ? { valueWithheld: true as const }
      : typeof value.value === 'string'
        ? {
            value: compact(value.value, 180),
            ...(value.valueTruncated === true ? { valueTruncated: true as const } : {}),
          }
        : {}),
    })),
    totalMatches: raw.totalMatches,
    scanned: raw.scanned,
  }
}

/**
 * Re-read semantics from one already-bound backend node. Actions use this
 * exact ElementHandle through risk, hit-test, and dispatch so a selector can
 * never silently resolve to a replacement node between those stages.
 *
 * This path deliberately reads no value: values are excluded from the identity
 * fingerprint, so re-resolution does not need them, and not reading them keeps
 * the secret-exposure surface confined to the single collection path.
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
