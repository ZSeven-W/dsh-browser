import { createHash, createHmac } from 'node:crypto'
import type { ElementHandle, JSHandle, Page } from 'playwright-core'
import type { BrowserSemanticNode, SemanticNameSource, TargetChangedSnapshot } from './driver-contract.js'

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
  /**
   * Position of the nearest ANCESTOR that is itself an emitted candidate in
   * the same collection (an index into the candidates array), in composed-tree
   * terms: light-DOM parents, through an assigned slot to the slot's flattened
   * parent, and crossing a shadow root to its host. Null at the top of the
   * view. Serialized from the single page-side evaluation; the manager turns
   * it into the node's public parentRef. Never part of the identity
   * fingerprint.
   */
  parentIndex?: number | null
  role: string
  name: string
  tag: string
  inputType: string
  interactive: boolean
  editable: boolean
  disabled: boolean
  /**
   * Whether the element passes the collection visibility gate (computed style
   * is not display:none / visibility:hidden / opacity:0 and the rendered box
   * is positive). Part of the identity fingerprint — unlike `inViewport`,
   * which is the viewport intersection (a scroll-dependent fact) and
   * deliberately not part of identity.
   */
  visible: boolean
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
  /**
   * Where the accessible name came from, computed in the same single
   * page-side evaluation as the name itself: 'label' when it is an authored
   * label (aria-label, aria-labelledby, an associated <label>, alt, title,
   * or another authored attribute/value — placeholder, an input-button's
   * value), 'content' when it is derived from descendant text aggregation
   * (or empty). Not part of the identity fingerprint itself, but it
   * qualifies the name input: a CONTENT-named node with a container role
   * has its name excluded from the within / retained scope-root identity
   * check (see CONTENT_NAMED_CONTAINER_ROLES).
   */
  nameSource: SemanticNameSource
}

export interface StoredSemanticTarget extends RawSemanticCandidate {
  ref: string
  /** Public parentRef: the ref of the nearest emitted composed ancestor in the SAME observation, or null. Set by the manager. */
  parentRef: string | null
  fingerprint: string
  /**
   * The Playwright element handle captured at observation time. A ref resolves
   * to THIS node and never to a selector re-match, so an identical twin sliding
   * into the stored selector path can never be substituted for the original.
   * Undefined when the observation could not materialize a binding for the
   * node (bindable:false).
   */
  handle: ElementHandle<Element> | undefined
}

const compact = (value: string, max = 180): string => value.replace(/\s+/gu, ' ').trim().slice(0, max)

/**
 * The ONE accessible-name normalization rule, shared by every derivation
 * path — the observation-time serializer in collectSemanticTargets and the
 * live re-derivation in inspectSemanticHandle — and by any other place that
 * computes an accessible name. The two page-side serializers receive this
 * function's own source text (normalizeAccessibleName.toString()) and
 * re-instantiate it in-page, so both paths execute byte-identical logic; the
 * observation path applies the same exported function a second time on the
 * node side, and the function is idempotent, so the double application can
 * never diverge from the single application on the live path (the QA-BL-074
 * trailing-space bug was exactly that divergence: a truncation cut landing
 * on whitespace left a trailing space on the single-application path, which
 * the double application then trimmed away).
 *
 * Rule, in order:
 * 1. Zero-width / invisible format characters — U+200B-U+200F, U+2060 WORD
 *    JOINER, U+00AD SOFT HYPHEN, U+FEFF ZERO WIDTH NO-BREAK SPACE — are
 *    stripped outright. They are not whitespace for \s, so without this step
 *    they survive collapse and can join or separate words inconsistently.
 * 2. Whitespace runs — including the no-break variants \s already matches
 *    (U+00A0, U+2007, U+202F, U+FEFF and the other Unicode space
 *    separators) — collapse to a single space.
 * 3. The ends are trimmed.
 * 4. The result is truncated at the fixed 180-character clamp, AFTER
 *    normalization, at a hard UTF-16 slice boundary.
 * 5. The truncated result is trimmed once more, so a cut landing on the
 *    collapsed space after position 179 can never leave a trailing space.
 *    This is the historical observation-time behavior (page-side
 *    normalization plus the node-side re-compaction), which the live path
 *    now matches exactly.
 *
 * Aggregation order and separators live in the accessibleName aggregation
 * itself (descendant textContent in document order); this function only
 * normalizes an already-aggregated candidate name.
 */
export function normalizeAccessibleName(value: string | null | undefined, max = 180): string {
  return String(value ?? '')
    .replace(/[\u200b-\u200f\u2060\u00ad\ufeff]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max)
    .trim()
}

/** Source text of the shared normalizer, injected into both page-side serializers. */
const normalizeAccessibleNameSource: string = normalizeAccessibleName.toString()

/**
 * Container roles whose accessible name the driver derives from CONTENTS
 * (concatenated descendant text) rather than an author-supplied label. Only
 * a node with one of these roles can carry an aggregated, order-dependent
 * accessible name — Wikipedia's "Part of a series on the History of China"
 * sidebar (role navigation, tag table, a ~180-character concatenation of
 * its descendants including hide/show toggles) is the canonical case.
 * Mirrors dsh-qa's CONTENT_NAMED_CONTAINER_ROLES (src/explore/export.ts).
 */
export const CONTENT_NAMED_CONTAINER_ROLES: ReadonlySet<string> = new Set([
  'search', 'region', 'list', 'listbox', 'group', 'navigation', 'main', 'form', 'table', 'menu',
])

/**
 * True when the candidate's accessible name is derived from its contents AND
 * the candidate carries a container role: the only shape whose aggregated
 * name may change while the element itself stays the same, and therefore the
 * only shape whose name input the within / retained scope-root identity
 * check excludes. A label-named node — whatever its role — and a
 * content-named leaf keep the full strict fingerprint.
 */
export function isContentNamedContainer(candidate: Pick<RawSemanticCandidate, 'nameSource' | 'role'>): boolean {
  return candidate.nameSource === 'content' && CONTENT_NAMED_CONTAINER_ROLES.has(candidate.role)
}

/**
 * Identity fingerprint used to re-resolve a ref against the live DOM. It covers
 * only properties that answer "which element is this": role, name, tag,
 * inputType, interactive/editable/disabled, the visibility gate state
 * (`visible` — display/visibility/opacity/box facts, NOT the viewport
 * intersection), download, and the credential-free href. `inViewport` (a
 * scroll-dependent fact) and the value fields (`value`, `valueWithheld`,
 * `valueTruncated` — fill-, keystroke-, or script-dependent facts) are
 * deliberately excluded, so a value change alone never invalidates a ref the
 * way navigation or a semantic change does.
 *
 * The hash itself keeps the full input set (refs stay opaque and are re-minted
 * per observation); the within / retained scope-root RESOLUTION comparison —
 * semanticTargetDiff with tolerateContentName — is what excludes `name` for a
 * content-named container, so a container's identity no longer depends on its
 * aggregated content.
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
    visible: candidate.visible,
    download: candidate.download,
    href: candidate.href ?? '',
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('base64url').slice(0, 20)
}

/** Identity inputs compared on re-resolution, in the stable `changed` report order. */
export const SEMANTIC_TARGET_FIELDS = [
  'role', 'name', 'tag', 'inputType', 'interactive', 'editable', 'disabled', 'visible', 'download', 'href',
] as const

/** Fields whose before/after snapshots may attach to a TARGET_CHANGED refusal: the safe subset. */
const SAFE_SNAPSHOT_FIELDS: ReadonlySet<string> = new Set(['role', 'name', 'tag', 'disabled', 'visible'])

export interface TargetChangeDetail {
  /** Identity inputs that differ, in stable order (a detached element reports `['detached']` instead). */
  changed: string[]
  /** Safe-subset snapshot of the OBSERVED candidate for every changed safe field. */
  before?: TargetChangedSnapshot
  /** Safe-subset snapshot of the LIVE element for every changed safe field. */
  after?: TargetChangedSnapshot
  /**
   * True when the differences are identity-EXEMPT information, not an
   * identity break: a name-only change on a content-named container (name
   * excluded from the within / retained scope-root check). The caller of a
   * tolerant comparison keeps resolving and reports the change
   * informationally; a strict comparison (act) never receives this flag and
   * refuses on any diff.
   */
  informational?: true
}

/**
 * Field-level difference between an observed candidate's identity inputs and a
 * live re-inspection of the same bound node. `changed` lists every differing
 * input in a stable order; `before`/`after` carry snapshots ONLY for the safe
 * subset (role, name, tag, disabled, visible) — never inputType, interactive,
 * editable, download, href, and never any value field (redaction rules
 * unchanged). Returns null when the compared inputs match.
 *
 * With tolerateContentName (the within / retained scope-root comparison) a
 * name-only change on a CONTENT-named container role is identity-exempt: the
 * detail is returned with `informational: true` so the caller keeps resolving
 * and reports the changed name informationally instead of refusing. A
 * label-named node, a non-container node, or any other differing field is
 * still a real identity break. Action targets (act) always compare strictly
 * and never receive an informational detail.
 */
export function semanticTargetDiff(observed: RawSemanticCandidate, live: RawSemanticCandidate, includeVisibility: boolean, tolerateContentName = false): TargetChangeDetail | null {
  const changed: string[] = []
  const before: TargetChangedSnapshot = {}
  const after: TargetChangedSnapshot = {}
  for (const field of SEMANTIC_TARGET_FIELDS) {
    if (field === 'visible' && !includeVisibility) continue
    const observedValue = field === 'href' ? (observed.href ?? '') : observed[field]
    const liveValue = field === 'href' ? (live.href ?? '') : live[field]
    if (observedValue !== liveValue) {
      changed.push(field)
      if (SAFE_SNAPSHOT_FIELDS.has(field)) {
        ;(before as Record<string, string | boolean>)[field] = observedValue
        ;(after as Record<string, string | boolean>)[field] = liveValue
      }
    }
  }
  if (changed.length === 0) return null
  const informational = tolerateContentName
    && changed.length === 1
    && changed[0] === 'name'
    && isContentNamedContainer(observed)
  return {
    changed,
    ...(Object.keys(before).length === 0 ? {} : { before, after }),
    ...(informational ? { informational: true as const } : {}),
  }
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
    parentRef: target.parentRef,
    role: target.role,
    name: target.name,
    nameSource: target.nameSource,
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
   * the flattened subtree rooted at this element (the element itself, its
   * light-tree descendants, slotted children at their assigned-slot render
   * position, and every open shadow root inside), and the scan window, the
   * node budget, and the iframe marker are all relative to that subtree.
   * Omit for the whole-page projection.
   */
  root?: ElementHandle<Element>
  /**
   * Optional identity anchor: the ORIGINAL handle of the element the driver
   * last dispatched an action on (never a re-matched node). When present, the
   * same evaluation measures — in-page — whether it is still connected,
   * whether it lies inside the root subtree by composed containment (null
   * when no root is given), and its index among the retained elements when it
   * was emitted (else -1).
   */
  anchor?: ElementHandle<Element>
}

export interface SemanticCollectResult extends SemanticScanResult {
  /** ElementHandles index-aligned with `candidates`, materialized in ONE round trip. */
  handles: Array<ElementHandle<Element>>
  /** True when a visible candidate was dropped by the node budget. */
  nodeBudgetExceeded: boolean
  /** Count of selector matches the visibility gate skipped inside the scanned range. */
  hiddenMatches: number
  /**
   * True when slot assignment could not be resolved to a walkable render
   * position somewhere in the traversed range (assignedElements threw or
   * returned something unusable). The caller marks the view truncated with
   * slot-unresolved. Assignment into a CLOSED shadow root is invisible
   * in-page (assignedSlot is null there by spec) and is left to the Phase C
   * CDP coverage probe.
   */
  slotUnresolved: boolean
  /**
   * Present only when root was provided: the root element's serialized
   * candidate, computed ALWAYS — even when the visibility gate excluded the
   * root from candidates — so the caller can mint a ref that still binds the
   * root. rootEmittedIndex is its index among the candidates when it was
   * emitted, else -1.
   */
  rootCandidate?: RawSemanticCandidate
  rootEmittedIndex?: number
  /** ElementHandle to the root element, materialized independently of the candidate handles. */
  rootHandle?: ElementHandle<Element>
  /** Present only when anchor was provided: in-page truth about the anchored element. */
  anchorInfo?: { connected: boolean; contained: boolean | null } | null
  /** Index of the anchored element among the retained elements, or -1 when it was not emitted. */
  anchorIndex?: number
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
  const { scanLimit, maxNodes, includeMatchIndex = false, root, anchor } = options
  const capture = await page.evaluateHandle((args) => {
    const {
      selector,
      scanLimit: limit,
      maxNodes: nodeBudget,
      includeMatchIndex: withMatchIndex,
      nameNormalizerSource,
      root: rootElement,
      anchor: anchorElement,
    } = args
    const normalize = (value: string | null | undefined, max = 180): string => String(value ?? '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, max)
    // The ONE shared name-normalization rule (see normalizeAccessibleName),
    // re-instantiated from its own source text so this serializer runs
    // byte-identical logic to the live re-derivation in
    // inspectSemanticHandle. The local normalize above stays for the role cap.
    const normalizeName = (0, eval)('(' + nameNormalizerSource + ')') as (value: string | null | undefined, max?: number) => string
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
    const accessibleName = (element: Element): { name: string; source: 'label' | 'content' } => {
      const labelledBy = element.getAttribute('aria-labelledby')
      if (labelledBy) {
        const joined = labelledBy.split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
        if (normalizeName(joined)) return { name: normalizeName(joined), source: 'label' }
      }
      const aria = normalizeName(element.getAttribute('aria-label'))
      if (aria) return { name: aria, source: 'label' }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const labels = Array.from(element.labels ?? []).map((label) => label.textContent ?? '').join(' ')
        if (normalizeName(labels)) return { name: normalizeName(labels), source: 'label' }
      }
      const alt = normalizeName(element.getAttribute('alt'))
      if (alt) return { name: alt, source: 'label' }
      const title = normalizeName(element.getAttribute('title'))
      if (title) return { name: title, source: 'label' }
      const placeholder = normalizeName(element.getAttribute('placeholder'))
      if (placeholder) return { name: placeholder, source: 'label' }
      if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type) && normalizeName(element.value)) {
        return { name: normalizeName(element.value), source: 'label' }
      }
      return { name: normalizeName(element.textContent), source: 'content' }
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
     * Flattened-tree match collection: light-tree document order, descending
     * into every OPEN shadow root at its host's position, and following slot
     * assignment so a light-DOM child slotted into an open shadow root is
     * collected at the slot position it RENDERS in — exactly once, never at
     * its light-tree position too. A slot renders its
     * assignedElements({flatten:true}) (the flatten flag resolves nested
     * slots across shadow trees); with nothing assigned it renders its own
     * fallback children. A light child of a shadow host that is assigned to
     * NO slot has no flattened render position and is not collected. Where
     * assignment cannot be resolved to a walkable position (assignedElements
     * throws or returns something unusable) slotUnresolved is set so the
     * caller can mark the view truncated instead of silently dropping
     * content. Assignment into a CLOSED shadow root is invisible in-page
     * (assignedSlot is null there by spec) and belongs to the Phase C CDP
     * coverage probe. Executed in this one synchronous evaluation so no
     * later DOM mutation can invalidate the list. With a scope root the walk
     * starts at that element (which is itself part of the subtree);
     * iframe/frame elements are counted by the same walk so the
     * subtree-relative truncation marker is atomically consistent with the
     * collected candidates.
     */
    const collectMatches = (selector: string, from: Document | ShadowRoot | Element): { results: Element[]; iframeCount: number; slotUnresolved: boolean } => {
      const results: Element[] = []
      let iframeCount = 0
      let slotUnresolved = false
      const resolveSlot = (slot: HTMLSlotElement): Element[] | null => {
        try {
          const assigned = slot.assignedElements({ flatten: true })
          return Array.isArray(assigned) ? Array.from(assigned) : null
        } catch {
          return null
        }
      }
      // visitElement processes an element at its RENDER position. The flag
      // marks entries that must not be skipped as slot-assigned: the scope
      // root (processed wherever the caller rooted the scope) and elements
      // reached THROUGH their assigned slot.
      const visitElement = (element: Element, atRenderPosition: boolean): void => {
        if (!atRenderPosition && element.assignedSlot !== null) {
          // Rendered inside its assigned slot (open shadow root): reached
          // from the slot's position, never re-emitted at the light position.
          // Assignment into a CLOSED root is invisible in-page (assignedSlot
          // is null there by spec); that exclusion belongs to the Phase C
          // CDP coverage probe, not to this walk.
          return
        }
        if (element.tagName === 'SLOT') {
          // A slot renders its assigned elements (flattened across nested
          // slots); with nothing assigned it renders its fallback children.
          const assigned = resolveSlot(element as HTMLSlotElement)
          if (assigned === null) {
            slotUnresolved = true
            return
          }
          if (assigned.length > 0) {
            for (const node of assigned) {
              if (node instanceof Element) visitElement(node, true)
            }
          } else {
            visitChildren(element)
          }
          return
        }
        if (element.matches(selector)) results.push(element)
        if (element.tagName === 'IFRAME' || element.tagName === 'FRAME') iframeCount += 1
        visitChildren(element.shadowRoot ?? element)
      }
      const visitChildren = (parentNode: Document | ShadowRoot | Element): void => {
        for (let child = parentNode.firstElementChild; child !== null; child = child.nextElementSibling) {
          visitElement(child, false)
        }
      }
      if (from instanceof Document || from instanceof ShadowRoot) visitChildren(from)
      else visitElement(from, true)
      return { results, iframeCount, slotUnresolved }
    }
    // Fail closed on an unusable scope root BEFORE any collection: the caller
    // must be able to tell "the scope refused" apart from "the subtree is
    // empty", and must never receive a whole-page fallback.
    if (rootElement !== undefined) {
      if (rootElement.nodeType !== 1) {
        return { output: [], totalMatches: 0, scanned: 0, nodeBudgetExceeded: false, selected: [], iframeCount: 0, hiddenMatches: 0, slotUnresolved: false, rootCandidate: null, rootEmittedIndex: -1, anchorConnected: undefined, anchorContained: undefined, anchorIndex: -1, rootFailure: 'not-element' }
      }
      if (!rootElement.isConnected) {
        return { output: [], totalMatches: 0, scanned: 0, nodeBudgetExceeded: false, selected: [], iframeCount: 0, hiddenMatches: 0, slotUnresolved: false, rootCandidate: null, rootEmittedIndex: -1, anchorConnected: undefined, anchorContained: undefined, anchorIndex: -1, rootFailure: 'detached' }
      }
    }
    const { results: elements, iframeCount, slotUnresolved } = collectMatches(selector, rootElement ?? document)
    /**
     * The composed-tree parent of a node: a slotted element's parent is its
     * assigned slot (whose own composed chain runs through the shadow tree to
     * the host), a shadow-root child's parent is the host, and everything
     * else follows the light parent. Used for parentRef ancestry and for
     * composed containment of the anchor.
     */
    const composedParentOf = (node: Element): Element | null => {
      if (node.assignedSlot !== null) return node.assignedSlot
      const parent = node.parentNode
      if (parent instanceof ShadowRoot) return parent.host
      return parent instanceof Element ? parent : null
    }
    /**
     * Serialize one element into a candidate record WITHOUT the visibility
     * gate. The gate is applied by the emission loop; the scope root uses
     * this directly so a gate-excluded root still yields a bindable record
     * for rootRef minting.
     */
    const serializeCandidate = (element: Element): Record<string, unknown> => {
      const html = element as HTMLElement
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
      const rect = element.getBoundingClientRect()
      const inViewport = rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight
      // The identity visibility gate state, mirroring the emission gate exactly
      // (including for a gate-excluded scope root serialized without the gate).
      const style = getComputedStyle(element)
      const visible = style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
        && rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0
      const href = safeHref(element)
      const named = accessibleName(element)
      return {
        selector: selectorFor(element), role, name: named.name, nameSource: named.source, tag, inputType,
        interactive, editable, disabled, visible, inViewport,
        download: element.hasAttribute('download'),
        ...(href === undefined ? {} : { href }),
        ...observableValue(element, inputType),
      }
    }
    const output: Array<Record<string, unknown>> = []
    const selected: Element[] = []
    /** Element -> its index in the emitted arrays, for parentRef ancestry. */
    const emittedIndex = new Map<Element, number>()
    const scanned = Math.min(elements.length, Number(limit))
    let nodeBudgetExceeded = false
    let hiddenMatches = 0
    for (let matchIndex = 0; matchIndex < scanned; matchIndex += 1) {
      const element = elements[matchIndex] as Element
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      // The visibility gate: matches skipped here are counted (hiddenMatches),
      // never emitted, and never consume the node budget.
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
        hiddenMatches += 1
        continue
      }
      if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length === 0) {
        hiddenMatches += 1
        continue
      }
      // The candidate at this position is visible and cannot be emitted: the
      // node budget dropped it, exactly like the caller's emission loop.
      if (selected.length >= nodeBudget) {
        nodeBudgetExceeded = true
        break
      }
      // parentRef ancestry: the nearest EMITTED node on this element's
      // composed ancestor chain (light parents, assigned slot, shadow host).
      let parentIndex: number | null = null
      let cursor = composedParentOf(element)
      while (cursor !== null) {
        const emitted = emittedIndex.get(cursor)
        if (emitted !== undefined) {
          parentIndex = emitted
          break
        }
        cursor = composedParentOf(cursor)
      }
      emittedIndex.set(element, output.length)
      output.push({
        ...serializeCandidate(element),
        ...(withMatchIndex ? { matchIndex } : {}),
        parentIndex,
      })
      selected.push(element)
    }
    // The scope root record is produced ALWAYS (the emitted record when the
    // gate passed, a fresh serialization otherwise) so the caller can mint a
    // rootRef that binds the root even when the gate excluded it from nodes.
    let rootCandidate: Record<string, unknown> | null = null
    let rootEmittedIndex = -1
    if (rootElement !== undefined) {
      const emitted = emittedIndex.get(rootElement)
      if (emitted !== undefined) {
        rootCandidate = output[emitted] as Record<string, unknown>
        rootEmittedIndex = emitted
      } else {
        rootCandidate = serializeCandidate(rootElement)
      }
    }
    // Anchor truth, measured against the ORIGINAL handled element in this
    // same evaluation: connected, composed containment inside the scope root
    // (null without a root), and its emission index when it was emitted.
    let anchorConnected: boolean | null = null
    let anchorContained: boolean | null = null
    if (anchorElement !== undefined) {
      anchorConnected = anchorElement.isConnected
      if (rootElement !== undefined) {
        anchorContained = false
        let anchorCursor: Element | null = anchorElement
        while (anchorCursor !== null) {
          if (anchorCursor === rootElement) {
            anchorContained = true
            break
          }
          anchorCursor = composedParentOf(anchorCursor)
        }
      }
    }
    const anchorIndex = anchorElement === undefined ? -1 : selected.indexOf(anchorElement)
    // Selection, serialization, and retention happened in this same
    // synchronous evaluation, so no DOM mutation can separate them: the
    // retained array IS the serialized candidates, by construction. The byte
    // budget is applied by the caller on the real public nodes (whose bytes it
    // computes exactly), so nodes trimmed there simply lose their handle.
    return {
      output,
      totalMatches: elements.length,
      scanned,
      nodeBudgetExceeded,
      selected,
      iframeCount,
      hiddenMatches,
      slotUnresolved,
      ...(rootElement === undefined ? {} : { rootCandidate, rootEmittedIndex, rootRetained: rootElement }),
      ...(anchorElement === undefined ? {} : { anchorConnected, anchorContained, anchorIndex }),
    }
  }, { selector: SEMANTIC_SELECTOR, scanLimit, maxNodes, includeMatchIndex, nameNormalizerSource: normalizeAccessibleNameSource, root, anchor })

  // Pull the serialized projection and the retained element array out of the
  // single capture handle, then materialize ElementHandles for ONLY those
  // retained elements in one getProperties round trip.
  let raw: {
    output: Array<Record<string, unknown>>
    totalMatches: number
    scanned: number
    nodeBudgetExceeded: boolean
    iframeCount: number
    hiddenMatches: number
    slotUnresolved: boolean
    rootFailure?: 'not-element' | 'detached'
    rootCandidate?: Record<string, unknown> | null
    rootEmittedIndex?: number
    anchorConnected?: boolean
    anchorContained?: boolean | null
    anchorIndex?: number
  }
  let selectedHandle: JSHandle<Element[]>
  let rootRetainedHandle: JSHandle<Element | undefined>
  try {
    ;[raw, selectedHandle, rootRetainedHandle] = await Promise.all([
      capture.evaluate((value) => ({
        output: value.output,
        totalMatches: value.totalMatches,
        scanned: value.scanned,
        nodeBudgetExceeded: value.nodeBudgetExceeded === true,
        iframeCount: Number(value.iframeCount ?? 0),
        hiddenMatches: Number(value.hiddenMatches ?? 0),
        slotUnresolved: value.slotUnresolved === true,
        ...(value.rootFailure === 'not-element' || value.rootFailure === 'detached'
          ? { rootFailure: value.rootFailure as 'not-element' | 'detached' }
          : {}),
        ...(value.rootCandidate === undefined || value.rootCandidate === null
          ? {}
          : { rootCandidate: value.rootCandidate as Record<string, unknown> }),
        rootEmittedIndex: typeof value.rootEmittedIndex === 'number' ? Number(value.rootEmittedIndex) : -1,
        ...(value.anchorConnected === undefined
          ? {}
          : {
              anchorConnected: value.anchorConnected === true,
              anchorContained: value.anchorContained === null ? null : value.anchorContained === true,
            }),
        anchorIndex: typeof value.anchorIndex === 'number' ? Number(value.anchorIndex) : -1,
      })),
      capture.getProperty('selected') as Promise<JSHandle<Element[]>>,
      capture.getProperty('rootRetained') as Promise<JSHandle<Element | undefined>>,
    ])
  } finally {
    await capture.dispose().catch(() => {})
  }
  let rootHandle: ElementHandle<Element> | undefined
  {
    const element = rootRetainedHandle.asElement()
    if (element !== null) rootHandle = element
    else await rootRetainedHandle.dispose().catch(() => {})
  }

  const mapCandidate = (value: Record<string, unknown>): RawSemanticCandidate => ({
    selector: String(value.selector),
    ...(typeof value.matchIndex === 'number' ? { matchIndex: Number(value.matchIndex) } : {}),
    parentIndex: typeof value.parentIndex === 'number' ? Number(value.parentIndex) : null,
    role: compact(String(value.role || 'generic'), 60),
    // Second application of the shared normalizer (the page-side serializer
    // applied it once already). It is idempotent by design, so this can never
    // diverge from the single application on the live re-derivation path.
    name: normalizeAccessibleName(String(value.name || '')),
    nameSource: value.nameSource === 'label' ? 'label' : 'content',
    tag: compact(String(value.tag || ''), 30),
    inputType: compact(String(value.inputType || ''), 30),
    interactive: value.interactive === true,
    editable: value.editable === true,
    disabled: value.disabled === true,
    visible: value.visible === true,
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
  })
  const candidates: RawSemanticCandidate[] = raw.output.map(mapCandidate)
  const rootCandidate: RawSemanticCandidate | undefined = raw.rootCandidate === undefined || raw.rootCandidate === null ? undefined : mapCandidate(raw.rootCandidate)
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
    hiddenMatches: Number(raw.hiddenMatches ?? 0),
    slotUnresolved: raw.slotUnresolved,
    ...(raw.rootFailure === undefined ? {} : { rootFailure: raw.rootFailure }),
    iframeCount: raw.iframeCount,
    ...(rootCandidate === undefined
      ? {}
      : { rootCandidate, rootEmittedIndex: Number(raw.rootEmittedIndex ?? -1), ...(rootHandle === undefined ? {} : { rootHandle }) }),
    ...(raw.anchorConnected === undefined
      ? {}
      : {
          anchorInfo: { connected: raw.anchorConnected, contained: raw.anchorContained ?? null },
          anchorIndex: Number(raw.anchorIndex ?? -1),
        }),
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
  const value = await handle.evaluate((element, nameNormalizerSource) => {
    const normalize = (raw: string | null | undefined, max = 180): string => String(raw ?? '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, max)
    // The ONE shared name-normalization rule (see normalizeAccessibleName),
    // re-instantiated from its own source text so this live re-derivation
    // runs byte-identical logic to the observation-time serializer in
    // collectSemanticTargets. The local normalize above stays for the role cap.
    const normalizeName = (0, eval)('(' + nameNormalizerSource + ')') as (value: string | null | undefined, max?: number) => string
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
    const accessibleName = (): { name: string; source: 'label' | 'content' } => {
      const labelledBy = element.getAttribute('aria-labelledby')
      if (labelledBy) {
        const joined = labelledBy.split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
        if (normalizeName(joined)) return { name: normalizeName(joined), source: 'label' }
      }
      const aria = normalizeName(element.getAttribute('aria-label'))
      if (aria) return { name: aria, source: 'label' }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const labels = Array.from(element.labels ?? []).map((label) => label.textContent ?? '').join(' ')
        if (normalizeName(labels)) return { name: normalizeName(labels), source: 'label' }
      }
      const alt = normalizeName(element.getAttribute('alt'))
      if (alt) return { name: alt, source: 'label' }
      const title = normalizeName(element.getAttribute('title'))
      if (title) return { name: title, source: 'label' }
      const placeholder = normalizeName(element.getAttribute('placeholder'))
      if (placeholder) return { name: placeholder, source: 'label' }
      if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type) && normalizeName(element.value)) {
        return { name: normalizeName(element.value), source: 'label' }
      }
      return { name: normalizeName(element.textContent), source: 'content' }
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
    // Same identity visibility gate state as the collection serializer.
    const style = getComputedStyle(element)
    const visible = style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0
    const named = accessibleName()
    return {
      role,
      name: named.name,
      nameSource: named.source,
      tag,
      inputType,
      interactive,
      editable,
      disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' || nativeDisabled,
      visible,
      inViewport,
      download: element.hasAttribute('download'),
      ...(href === undefined ? {} : { href }),
    }
  }, normalizeAccessibleNameSource)
  if (value === null) return null
  return { selector, ...value }
}
