import { createHash, createHmac } from 'node:crypto'
import type { ElementHandle, JSHandle, Page } from 'playwright-core'
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
    bindable: target.handle !== undefined,
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

export interface SemanticCollectOptions {
  /** Maximum selector matches to examine, in piercing document order. */
  scanLimit: number
  /** Maximum emitted candidates; the element selection stops exactly here. */
  maxNodes: number
  /** Legacy: also serialize the candidate's position in the full match list. */
  includeMatchIndex?: boolean
  /**
   * Optional live root element: when present, the projection is limited to
   * the composed subtree rooted at this element (the element itself, its
   * light-tree descendants, and every open shadow root inside), and the scan
   * window, the node budget, and the iframe marker are all relative to that
   * subtree. Omit for the whole-page projection.
   */
  root?: ElementHandle<Element>
}

export interface SemanticCollectResult extends SemanticScanResult {
  /** ElementHandles index-aligned with `candidates`, materialized in ONE round trip. */
  handles: Array<ElementHandle<Element>>
  /** True when a visible candidate was dropped by the node budget. */
  nodeBudgetExceeded: boolean
  /**
   * Present only when root was provided and the rooted collection was
   * refused: 'not-element' when the root is not an Element node, 'detached'
   * when it is an element no longer connected to the document. The caller
   * fails closed on either; the whole-page path never sets it.
   */
  rootFailure?: 'not-element' | 'detached'
  /** iframe/frame elements inside the traversed root, counted by the same piercing walk. */
  iframeCount: number
}

/**
 * Atomic bounded DOM semantic projection + handle capture. ONE page-side
 * evaluation — the only round trip that touches the page before handle
 * materialization — scans up to `scanLimit` piercing matches, serializes the
 * emitted candidates, applies the node budget, and RETURNS references
 * to exactly the selected elements as part of its result. Open shadow roots
 * are pierced by the same composed-tree walk the locator engine used to
 * provide, but the walk happens inside this one synchronous evaluation, so a
 * DOM mutation can never desynchronize selection from serialization (a
 * two-phase selector resolution could observe a stale match list under rapid
 * churn). ElementHandles are then materialized for only those ≤ maxNodes
 * elements in ONE round trip (getProperties on the retained array). There is
 * no full-page handle materialization, no second selector query, and no index
 * re-verification: the handles ARE the serialized elements by construction. A
 * node whose handle still cannot be produced stays in the observation and is
 * marked bindable:false by the caller — it is never silently dropped.
 */
export async function collectSemanticTargets(page: Page, options: SemanticCollectOptions): Promise<SemanticCollectResult> {
  const { scanLimit, maxNodes, includeMatchIndex = false, root } = options
  const capture = await page.evaluateHandle((args) => {
    const {
      selector,
      scanLimit: limit,
      maxNodes: nodeBudget,
      includeMatchIndex: withMatchIndex,
      root: rootElement,
    } = args
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
        parts.unshift(tag + ':nth-of-type(' + nth + ')')
        current = current.parentElement
      }
      return 'html > ' + parts.join(' > ')
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
    /**
     * Piercing match collection in composed-tree order: light-tree document
     * order, descending into every OPEN shadow root at its host's position —
     * the same reach the locator engine had, executed in this synchronous
     * evaluation so no later DOM mutation can invalidate the list. With a
     * scope root the walk starts at that element (which is itself part of
     * the subtree) instead of the document; iframe/frame elements are
     * counted by the same walk so the subtree-relative truncation marker is
     * atomically consistent with the collected candidates.
     */
    const collectMatches = (selector: string, from: Document | Element): { results: Element[]; iframeCount: number } => {
      const results: Element[] = []
      let iframeCount = 0
      const visit = (rootNode: Document | ShadowRoot | Element): void => {
        const documentNode = rootNode instanceof Document ? rootNode : rootNode.ownerDocument
        if (documentNode === null) return
        if (!(rootNode instanceof Document)) {
          // A TreeWalker's nextNode() starts AFTER its root, so a non-document
          // root must be processed explicitly: an element root is itself part
          // of the subtree (and may match or pierce its own shadow root), a
          // ShadowRoot root is not an Element and can never match.
          if (rootNode instanceof Element) {
            if (rootNode.matches(selector)) results.push(rootNode)
            if (rootNode.tagName === 'IFRAME' || rootNode.tagName === 'FRAME') iframeCount += 1
            if (rootNode.shadowRoot !== null) visit(rootNode.shadowRoot)
          }
        }
        const walker = documentNode.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT)
        let node = walker.nextNode()
        while (node !== null) {
          const element = node as Element
          if (element.matches(selector)) results.push(element)
          if (element.tagName === 'IFRAME' || element.tagName === 'FRAME') iframeCount += 1
          if (element.shadowRoot !== null) visit(element.shadowRoot)
          node = walker.nextNode()
        }
      }
      visit(from)
      return { results, iframeCount }
    }
    // Fail closed on an unusable scope root BEFORE any collection: the caller
    // must be able to tell "the scope refused" apart from "the subtree is
    // empty", and must never receive a whole-page fallback.
    if (rootElement !== undefined) {
      if (rootElement.nodeType !== 1) {
        return { output: [], totalMatches: 0, scanned: 0, nodeBudgetExceeded: false, selected: [], iframeCount: 0, rootFailure: 'not-element' }
      }
      if (!rootElement.isConnected) {
        return { output: [], totalMatches: 0, scanned: 0, nodeBudgetExceeded: false, selected: [], iframeCount: 0, rootFailure: 'detached' }
      }
    }
    const { results: elements, iframeCount } = collectMatches(selector, rootElement ?? document)
    const output: Array<Record<string, unknown>> = []
    const selected: Element[] = []
    const scanned = Math.min(elements.length, Number(limit))
    let nodeBudgetExceeded = false
    for (let matchIndex = 0; matchIndex < scanned; matchIndex += 1) {
      const element = elements[matchIndex] as Element
      const html = element as HTMLElement
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
      if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length === 0) continue
      // The candidate at this position is visible and cannot be emitted: the
      // node budget dropped it, exactly like the caller's emission loop.
      if (selected.length >= nodeBudget) {
        nodeBudgetExceeded = true
        break
      }
      const tag = element.tagName.toLowerCase()
      const inputType = tag === 'input' ? (element.getAttribute('type') ?? 'text').toLowerCase() : ''
      const role = normalize(element.getAttribute('role'), 60) || implicitRole(element)
      // :disabled covers fieldset-disabled controls, and :read-only covers
      // readonly inputs/textareas, so a fill on them fails fast instead of
      // stalling in an actionability wait it can never satisfy.
      const nativeDisabled = element.matches(':disabled')
      const readOnly = (tag === 'input' || tag === 'textarea') && element.matches(':read-only')
      const editable = (tag === 'input' || tag === 'textarea' || html.isContentEditable) && !readOnly && !nativeDisabled
      const interactive = editable || ['a', 'button', 'select', 'summary'].includes(tag)
        || element.hasAttribute('tabindex') || role !== 'generic' && role !== 'heading'
      const disabled = element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' || nativeDisabled
      const inViewport = rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight
      const href = safeHref(element)
      const candidate: Record<string, unknown> = {
        selector: selectorFor(element), role, name: accessibleName(element), tag, inputType,
        interactive, editable, disabled, inViewport,
        download: element.hasAttribute('download'),
        ...(href === undefined ? {} : { href }),
        ...observableValue(element, inputType),
        ...(withMatchIndex ? { matchIndex } : {}),
      }
      output.push(candidate)
      selected.push(element)
    }
    // Selection, serialization, and retention happened in this same
    // synchronous evaluation, so no DOM mutation can separate them: the
    // retained array IS the serialized candidates, by construction. The byte
    // budget is applied by the caller on the real public nodes (whose bytes it
    // computes exactly), so nodes trimmed there simply lose their handle.
    return { output, totalMatches: elements.length, scanned, nodeBudgetExceeded, selected, iframeCount }
  }, { selector: SEMANTIC_SELECTOR, scanLimit, maxNodes, includeMatchIndex, root })

  // Pull the serialized projection and the retained element array out of the
  // single capture handle, then materialize ElementHandles for ONLY those
  // retained elements in one getProperties round trip.
  let raw: {
    output: Array<Record<string, unknown>>
    totalMatches: number
    scanned: number
    nodeBudgetExceeded: boolean
    iframeCount: number
    rootFailure?: 'not-element' | 'detached'
  }
  let selectedHandle: JSHandle<Element[]>
  try {
    ;[raw, selectedHandle] = await Promise.all([
      capture.evaluate((value) => ({
        output: value.output,
        totalMatches: value.totalMatches,
        scanned: value.scanned,
        nodeBudgetExceeded: value.nodeBudgetExceeded === true,
        iframeCount: Number(value.iframeCount ?? 0),
        ...(value.rootFailure === 'not-element' || value.rootFailure === 'detached'
          ? { rootFailure: value.rootFailure as 'not-element' | 'detached' }
          : {}),
      })),
      capture.getProperty('selected') as Promise<JSHandle<Element[]>>,
    ])
  } finally {
    await capture.dispose().catch(() => {})
  }

  const candidates: RawSemanticCandidate[] = raw.output.map((value) => ({
    selector: String(value.selector),
    ...(typeof value.matchIndex === 'number' ? { matchIndex: Number(value.matchIndex) } : {}),
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
  }))
  // The array is exactly the serialized candidates, so the handles are the
  // serialized elements by construction — no index re-verification.
  let handles: Array<ElementHandle<Element>> = []
  try {
    const properties = await selectedHandle.getProperties()
    for (let index = 0; ; index += 1) {
      const property = properties.get(String(index))
      if (property === undefined) break
      const element = property.asElement()
      if (element !== null) handles.push(element)
      else void property.dispose().catch(() => {})
    }
  } catch {
    // Only a document replacement between the capture evaluation and handle
    // materialization can destroy the retained array. Release whatever was
    // materialized; the caller keeps the nodes and marks them bindable:false.
    for (const handle of handles) void handle.dispose().catch(() => {})
    handles = []
  } finally {
    await selectedHandle.dispose().catch(() => {})
  }
  return {
    candidates,
    handles,
    totalMatches: Number(raw.totalMatches),
    scanned: Number(raw.scanned),
    nodeBudgetExceeded: raw.nodeBudgetExceeded,
    ...(raw.rootFailure === undefined ? {} : { rootFailure: raw.rootFailure }),
    iframeCount: raw.iframeCount,
  }
}

/**
 * Legacy candidates-only scan (kept for the exported API surface): the same
 * piercing projection and budgets disabled, candidates carrying their match
 * position exactly like before. The handles materialized along the way are
 * disposed here because this caller never keeps them.
 */
export async function collectSemanticCandidates(page: Page, scanLimit = 500): Promise<SemanticScanResult> {
  const collected = await collectSemanticTargets(page, {
    scanLimit,
    maxNodes: Number.MAX_SAFE_INTEGER,
    includeMatchIndex: true,
  })
  for (const handle of collected.handles) void handle.dispose().catch(() => {})
  return {
    candidates: collected.candidates,
    totalMatches: collected.totalMatches,
    scanned: collected.scanned,
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
    const nativeDisabled = element.matches(':disabled')
    const readOnly = (tag === 'input' || tag === 'textarea') && element.matches(':read-only')
    const editable = (tag === 'input' || tag === 'textarea' || html.isContentEditable) && !readOnly && !nativeDisabled
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
      disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' || nativeDisabled,
      inViewport,
      download: element.hasAttribute('download'),
      ...(href === undefined ? {} : { href }),
    }
  })
  if (value === null) return null
  return { selector, ...value }
}
