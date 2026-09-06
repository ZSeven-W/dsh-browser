/** Public driver contract consumed by dsh-qa and other orchestration plugins. */

export const BROWSER_DRIVER_SERVICE = 'zsevenBrowserDriver' as const
export const BROWSER_DRIVER_CONTRACT_VERSION = 9 as const

export type BrowserActionStatus = 'confirmed' | 'unknown' | 'rejected' | 'failed'
export type BrowserActKind = 'click' | 'fill' | 'press' | 'navigate' | 'scroll' | 'select' | 'hover'

/**
 * One cookie in the Playwright storageState JSON format.
 *
 * Cookies are HOST-SCOPED by the browser: once injected, the cookie is sent
 * to every origin (scheme and port) on its host — including subresource
 * requests to origins outside the operator allowlist. The exact-origin
 * allowlist can never narrow cookie delivery. The driver therefore fails the
 * session start closed unless the cookie's host maps onto the host of at
 * least one allowlisted origin; callers must only inject cookies for
 * operator-owned hosts.
 */
export interface BrowserStorageCookie {
  name: string
  value: string
  /**
   * Exact host or dot-prefixed parent (`.example.com`). Never a wildcard.
   * Dot-prefixed IP literals (`.127.0.0.1`) are invalid and rejected.
   */
  domain: string
  path: string
  /** Unix time in seconds. */
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
  /**
   * Alternative to `domain`: an absolute http(s) URL whose host the cookie
   * belongs to (Playwright url-form cookie). Checked by its host like
   * domain-form cookies.
   */
  url?: string
}

/**
 * Playwright storageState JSON shape (cookies + per-origin localStorage).
 * The driver validates the entries against the operator policy and fails the
 * session start closed on a mismatch: every localStorage origin must be
 * exactly allowlisted, and every cookie host must map onto the host of an
 * allowlisted origin (see BrowserStorageCookie for the host-scoping rules).
 */
export interface BrowserStorageState {
  cookies: BrowserStorageCookie[]
  origins: Array<{
    origin: string
    localStorage: Array<{ name: string; value: string }>
  }>
}

export interface BrowserSessionStartOptions {
  /** Initial http(s) URL. Omit to start at about:blank. */
  url?: string
  /** Defaults to true. Headful mode is intended for local diagnosis only. */
  headless?: boolean
  /**
   * Owner-authorized login state to pre-load into the fresh ephemeral
   * profile. The driver validates it at start: localStorage origins must be
   * exactly allowlisted and cookie hosts must map onto an allowlisted origin's
   * host, otherwise the start fails closed. Cookies are host-scoped by the
   * browser and reach every port/scheme of their host, so the allowlist can
   * only check the host, never narrow the delivery. The profile is destroyed
   * on stop as always.
   */
  storageState?: BrowserStorageState
}

export interface BrowserSessionInfo {
  ownerId: string
  state: 'running'
  headless: boolean
  browser: {
    channel: 'chrome' | 'edge' | 'chromium' | 'custom'
    version: string
  }
  page: {
    url: string
    title: string
  }
  isolation: 'ephemeral-user-data'
  navigationPolicy: {
    mode: 'unrestricted' | 'allowlist'
    allowedOrigins: string[]
  }
}

export interface BrowserObservationOptions {
  /** Maximum returned semantic nodes. The driver clamps this to 1..100. */
  maxNodes?: number
  /**
   * v8+: restrict the projection to the flattened subtree rooted at this
   * element. The value is an opaque ref from the caller's CURRENT observation
   * (the latest unexpired one in this Agent scope) — including a scoped
   * observation's own scope.rootRef (v9). The driver resolves it exactly as
   * actions do — same staleness/expiry rules, same rejection vocabulary — and
   * then collects semantic nodes from that subtree only: the root element
   * plus its flattened-tree descendants (light children, slotted children at
   * their assigned-slot render position, every open shadow root inside), in
   * flattened-tree order and with the same atomic handle-capture as the
   * whole-page path. maxNodes, the byte ceiling, and the 500-match scan
   * window all apply to the SUBTREE, and the iframe truncation marker only
   * reflects iframes inside it — so a subtree that fits reports
   * truncated:false, making absence provable inside a container even when
   * the whole page is unbounded. The result's scope field echoes the root
   * the driver observed and carries a fresh rootRef (v9) that binds it even
   * when the visibility gate excluded it from nodes. An unknown, expired,
   * consumed, non-element, or detached within ref refuses the call with a
   * distinct rejection — it never silently falls back to a whole-page view.
   *
   * v9 scoped-proof retention (additive): a dispatched action consumes the
   * observation that minted the ref, and after it exactly TWO bindings
   * survive. One is the acted element (see anchorLastAction). The other is
   * the scope root of the consumed observation when it was scoped: the
   * driver retains that root per session, so observe({ within: <that
   * observation's scope.rootRef> }) — or the literal alias within:
   * 'last-scope' — re-scopes the projection to the SAME root after the
   * action and before the next observe. The retained root is checked exactly
   * like a live within ref (connected element identity — TARGET_CHANGED /
   * WITHIN_NOT_ELEMENT); a missing or released retention (no scoped action
   * yet, navigation, or an observe in between) refuses with the distinct
   * SCOPE_UNAVAILABLE. Every OTHER ref — a plain node ref from the consumed
   * observation included — keeps today's refusal (OBSERVATION_REQUIRED
   * after an action), so ordinary ref semantics are unchanged.
   */
  within?: string
  /**
   * v9: request an identity anchor for the element the driver last dispatched
   * an action on (the ORIGINAL handle used for dispatch, never a re-matched
   * node). The result's anchor reports, measured in-page against that handle,
   * whether it is still connected and whether it lies inside the within
   * subtree (composed containment; null without within), plus its fresh ref
   * in THIS observation when it was emitted. When no action target is
   * retained (no dispatched element action yet, or it was released by
   * navigation), the call REJECTS with ANCHOR_UNAVAILABLE — never a silent
   * null anchor.
   */
  anchorLastAction?: true
  /**
   * v9 (Phase C): run a BOUNDED CDP coverage probe after collection, over the
   * observed subtree (the within root's subtree, or the whole document for a
   * whole-page observe), to detect CLOSED shadow roots among ALL element
   * descendants — non-semantic hosts included. Closed roots are invisible
   * in-page (Element.shadowRoot is null for them), so the content they render
   * is missing from the projection while the light tree can still look
   * complete. The probe walks the CDP DOM tree (DOM.getDocument /
   * DOM.describeNode with depth -1 and pierce:true, shadow roots and embedded
   * frame documents included) under a hard node cap (5,000 DOM nodes) and a
   * hard time cap (250 ms). The result's coverage reports the outcome:
   * closedShadowRoots > 0 pushes the truncation reason closed-shadow-root;
   * a probe that did not complete (over-budget, cdp-unavailable,
   * root-unresolved, error) pushes shadow-coverage-unverified. Only
   * coverage.verified === true lets a consumer read truncated:false as
   * "every semantic node of the subtree is in the projection". Without this
   * flag the observation carries coverage {verified:false, reason:'skipped'}
   * and NO extra truncation reason — ordinary polls are unchanged in cost
   * and in truncated semantics. Use it only on the terminal absence-proof
   * path, never on settle polls.
   */
  verifyCoverage?: true
}

/** v9 (Phase C): per-observation evidence from the bounded CDP coverage probe. */
export interface BrowserCoverageEvidence {
  /**
   * True ONLY when the probe ran to completion within its node and time
   * budgets AND found zero closed shadow roots in the observed subtree. Only
   * then may a consumer treat truncated:false as "every semantic node of the
   * subtree is in the projection" (modulo the observable-nodes semantics).
   * False whenever the probe was skipped, stopped by a budget, could not run,
   * or found closed roots.
   */
  verified: boolean
  /** Closed shadow roots found in the observed subtree. A completed probe with none reports 0; an incomplete probe reports what it counted before stopping. */
  closedShadowRoots: number
  /** DOM nodes the probe walked before it finished or stopped. */
  probedNodes: number
  /**
   * Why the probe is NOT verified evidence, absent on the two completed
   * outcomes (none found -> verified:true; roots found -> verified:false with
   * closedShadowRoots naming the count). 'skipped': verifyCoverage was not
   * requested. 'over-budget': the node cap (5,000) or the time cap (250 ms)
   * was exceeded. 'cdp-unavailable': the CDP session could not be created.
   * 'root-unresolved': the within handle could not be mapped to a CDP backend
   * node. 'error': any other probe failure.
   */
  reason?: 'skipped' | 'over-budget' | 'cdp-unavailable' | 'root-unresolved' | 'error'
}

/** v8+: the root of a scoped observation, as the driver observed it. */
export interface BrowserObservationScope {
  /** The ref the caller passed as within (v8 compatibility echo). */
  ref: string
  /**
   * v9: a ref minted in THIS observation for the root element. When the root
   * was emitted, it equals that node's ref (the root is always nodes[0] of a
   * scoped view); when the visibility gate excluded the root, the root is
   * absent from nodes but rootRef still binds it, so a follow-up
   * observe({ within: scope.rootRef }) keeps resolving while the root stays
   * hidden. After a dispatched action on this observation, the driver
   * retains the root itself, so observe({ within: scope.rootRef }) — or the
   * literal alias 'last-scope' — keeps resolving until the next observation
   * (see BrowserObservationOptions.within).
   */
  rootRef: string
  role: string
  name: string
  tag: string
}

export interface BrowserSemanticNode {
  /**
   * Opaque, short-lived handle. Never a selector or backend node id. A ref is
   * bound to the ORIGINAL DOM node observed: if that node is removed and an
   * identical twin takes its place, acting on the ref rejects (TARGET_CHANGED)
   * instead of silently re-resolving to the twin; Set-of-Mark boxes are
   * measured on the same original node. When the observation retained no live
   * binding at all (bindable:false), acting on the ref rejects with
   * TARGET_UNBINDABLE.
   */
  ref: string
  /**
   * v9: the ref of the nearest ANCESTOR — in the composed tree: light-DOM
   * parents, through slot assignment to the slot's flattened parent, and
   * crossing a shadow root to its host — that is itself an emitted node in
   * the SAME observation; null when none (the first whole-page node and every
   * scoped root have none). Because ancestors always precede their
   * descendants in emission order, a node's parentRef always points at an
   * EARLIER node of the same observation. Refs are re-minted per observation,
   * so consumers must compare ancestry as a RELATIONSHIP (the parent's index
   * within the same view), never as raw ref strings.
   */
  parentRef: string | null
  role: string
  name: string
  tag: string
  interactive: boolean
  /**
   * True when the element accepts typed input: an enabled (not attribute-,
   * fieldset-, or otherwise disabled) `<input>`/`<textarea>` that is not
   * readonly, or a contenteditable element. Readonly and disabled controls
   * are advertised non-editable so a fill fails fast with
   * TARGET_NOT_EDITABLE instead of stalling in an actionability wait.
   */
  editable: boolean
  /** True when the control is disabled by attribute, aria-disabled, or a disabled fieldset. */
  disabled: boolean
  /**
   * Whether the element's box currently intersects the viewport. Off-viewport
   * nodes still carry a ref so `scroll` can reach them, but they are omitted
   * from a viewport `visualObserve` capture with reason `off-viewport`.
   */
  inViewport: boolean
  /**
   * v7+: whether the observation retained a live binding to the ORIGINAL node,
   * so `act` can reach it. False only when the driver could not produce an
   * ElementHandle for a node it collected (for example the page was replaced
   * mid-observation): the node stays in the observation for view purposes,
   * `act` on its ref rejects with TARGET_UNBINDABLE, and `visualObserve`
   * omits it with reason `unbound`. With the atomic capture (v7) this is
   * exceptional, not a churn artifact.
   */
  bindable: boolean
  /** Query strings and fragments are removed. */
  href?: string
  /**
   * Bounded observable value of a value-bearing control, so a consumer can
   * prove an action against its own target instead of an unrelated node that
   * happened to change: `<input>` (except checkbox/radio/button/submit/reset/
   * image/file/hidden, whose `.value` is a checked-state, an interface label
   * already carried by `name`, or a fake upload path), `<textarea>`,
   * `<select>` (the selected option's `value`, which HTML defaults to the
   * option's text when the option carries no `value` attribute; for a
   * `multiple` select, the first selected option), any element carrying
   * `aria-valuetext`/`aria-valuenow`, and `contenteditable` elements (their
   * `textContent`, with the same secret withholding and 180-character bound).
   *
   * An empty string is a real observation ("this field is empty"); the ABSENCE
   * of the field means the element has no observable value at all, or that its
   * value was withheld — see `valueWithheld`. Never present together with
   * `valueWithheld`.
   *
   * Values are attacker-influenced strings and are bounded exactly like `name`:
   * whitespace runs are collapsed to single spaces, the string is trimmed, and
   * the result is clipped to 180 characters. A consumer comparing an intended
   * fill text against `value` must apply the same normalization.
   *
   * Like `inViewport`, the value fields are deliberately NOT part of the
   * identity fingerprint used to re-resolve a ref. A value change — typed,
   * scripted, or arriving asynchronously — must not invalidate a ref the way
   * navigation or a semantic change does.
   */
  value?: string
  /**
   * Present, and always `true`, when the element bears a value that this driver
   * deliberately never reads: `<input type="password">`, an `autocomplete`
   * token of `current-password`, `new-password`, `one-time-code`, `cc-number`,
   * or `cc-csc`, a value-bearing control inside an `aria-hidden="true"`
   * subtree (the shape used by masked secure widgets), or a control whose
   * computed `-webkit-text-security` is `disc`, `circle`, or `square` (CSS
   * text masking renders bullets to the user). The secret never leaves
   * the page. This explicit marker — rather than a silently missing field — is
   * what lets a consumer tell "no value here" apart from "value deliberately
   * not captured".
   */
  valueWithheld?: true
  /**
   * Present, and always `true`, when the observable value exceeded the
   * 180-character bound and `value` holds only its prefix. An equality
   * assertion against a truncated value is invalid.
   */
  valueTruncated?: true
}

/** v9: identity anchor for the element the driver last dispatched an action on. */
export interface BrowserObservationAnchor {
  /**
   * The anchored element's fresh ref in THIS observation when it was emitted
   * (identity binding, never a selector re-match); null when the visibility
   * gate or a budget excluded it — connected/contained stay truthful either
   * way.
   */
  ref: string | null
  /** Whether the original acted element is still connected to the document. */
  connected: boolean
  /**
   * Whether the acted element lies inside the within subtree (composed
   * containment: parent/host/assignedSlot chain). Null for a whole-page
   * observation (no within was given); false when it is connected elsewhere
   * or no longer connected at all.
   */
  contained: boolean | null
}

export interface BrowserObservation {
  ownerId: string
  epoch: number
  fingerprint: string
  expiresAt: string
  page: {
    url: string
    title: string
    viewport: { width: number; height: number }
  }
  /**
   * v8+: the root of a scoped observation (observe with a within ref), as the
   * driver observed it at resolution time. Null for a whole-page observation.
   * nodes are collected from this element's composed subtree; budgets and the
   * iframe marker are subtree-relative, while each node's inViewport keeps its
   * whole-page viewport-intersection meaning.
   */
  scope: BrowserObservationScope | null
  nodes: BrowserSemanticNode[]
  /**
   * v9: count of semantic-selector matches the visibility gate skipped
   * (visibility:hidden, display:none, opacity:0, zero/no client rects) within
   * the scanned range. A diagnostic of the observable-node projection, never
   * a truncation reason.
   */
  hiddenMatches: number
  /**
   * v9: true whenever collection stopped early (scan window, node budget, or
   * byte budget), i.e. hiddenMatches is a LOWER BOUND of the subtree's
   * gate-skipped matches. False means every match in the scanned range was
   * examined and the count is exact.
   */
  hiddenMatchesPartial: boolean
  /**
   * v9: present only when the observe requested anchorLastAction — in-page
   * truth about the element the driver last dispatched an action on (the
   * ORIGINAL handle, never a re-matched node).
   */
  anchor?: BrowserObservationAnchor
  /**
   * v9 (Phase C): coverage evidence for THIS observation, always present.
   * Without verifyCoverage it is {verified:false, reason:'skipped',
   * closedShadowRoots:0, probedNodes:0} and adds no truncation reason. With
   * verifyCoverage the bounded CDP probe ran over the observed subtree: see
   * BrowserCoverageEvidence. coverage.verified:true is the only evidence on
   * which a consumer may treat truncated:false as a complete projection.
   */
  coverage: BrowserCoverageEvidence
  /**
   * True whenever a selector-matching element that would have been emitted was
   * not: matches beyond the 500-match scan window, nodes cut by the node/byte
   * budgets, iframe content, and unresolved slot assignment (see
   * truncationReasons).
   */
  truncated: boolean
  /**
   * Present when truncated is true; names every reason the view is partial.
   * Reasons: scan-window-exceeded, node-budget-exceeded,
   * byte-budget-exceeded, iframe-not-traversed (the projection is main-frame
   * only; any iframe/frame element, same-origin included, sets truncated),
   * slot-unresolved (v9: an element's slot assignment could not be resolved
   * to a walkable render position — assignedElements threw or returned
   * something unusable; the element is then not emitted, and the marker
   * keeps the exclusion honest), closed-shadow-root (v9 Phase C: the
   * coverage probe found at least one closed shadow root in the observed
   * subtree; the content it renders is missing from the projection and is
   * never pierced, only detected), and shadow-coverage-unverified (v9
   * Phase C: verifyCoverage was requested but the probe did not run to
   * completion — over-budget, cdp-unavailable, root-unresolved, or error —
   * so closed-shadow-root absence is NOT proven for this observation).
   * In a scoped (within) observation every reason — the iframe marker
   * included — is relative to the subtree: an iframe elsewhere on the page
   * does not truncate the subtree view. v6's identity-binding-failed is
   * retired: v7 never drops a collected node because a handle could not be
   * made — such a node stays with bindable:false instead.
   */
  truncationReasons?: string[]
  limits: {
    maxNodes: number
    maxBytes: number
  }
}

export interface BrowserFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserVisualObserveRequest {
  /**
   * Exact observation fingerprint from browser_observe in the same Agent
   * scope. Omit to capture the latest observation.
   */
  fingerprint?: string
  /** Capture the full document instead of the current viewport. Defaults to false. */
  fullPage?: boolean
  /** Set-of-Mark budget, clamped to 1..200. Defaults to 80. */
  maxMarks?: number
  /** Output scale multiplier applied to the captured PNG, clamped to 1..3. Defaults to 1. */
  scale?: number
}

export type BrowserVisualQualityClassification =
  | 'usable'
  | 'transparent'
  | 'mostly-transparent'
  | 'near-black'
  | 'near-white'
  | 'near-uniform'

export interface BrowserVisualQuality {
  classification: BrowserVisualQualityClassification
  usable: boolean
  sampleCount: number
  visibleFraction: number
  meanLuminance: number
  luminanceVariance: number
  luminanceRange: number
  darkFraction: number
  lightFraction: number
  distinctColorBuckets: number
}

export interface BrowserVisualMark {
  /** Set-of-Mark label index, 1-based, matching the source node position. */
  number: number
  /** Opaque ref from the source observation. */
  ref: string
  /** Stable zero-based index in the source observation's nodes array. */
  sourceIndex: number
  /** Top-origin pixels in the native captured PNG (CSS pixels times scale). */
  nativePixelFrame: BrowserFrame
}

export interface BrowserVisualOmission {
  ref: string
  sourceIndex: number
  reason: string
}

export interface BrowserVisualCapture {
  ownerId: string
  epoch: number
  observationFingerprint: string
  capturedAt: string
  expiresAt: string
  page: {
    url: string
    title: string
    viewport: { width: number; height: number }
  }
  png: Uint8Array
  capture: {
    artifact: {
      format: 'png'
      byteLength: number
      sha256: string
      /** Absolute path to the PNG in the driver's session temporary area. */
      path: string
    }
    pointFrame: BrowserFrame
    pixelWidth: number
    pixelHeight: number
    scaleX: number
    scaleY: number
    fullPage: boolean
    quality: BrowserVisualQuality
  }
  marks: BrowserVisualMark[]
  omitted: BrowserVisualOmission[]
}

export type BrowserAction =
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; text: string }
  | { kind: 'press'; ref: string; key: string }
  | { kind: 'navigate'; url: string }
  /**
   * Scroll the referenced element into view (center-ish). This is the primary
   * form for reaching off-viewport controls. Scrolling mutates the viewport,
   * so — like every dispatched action — it invalidates the current
   * observation: observe again after scrolling to obtain fresh refs. A scroll
   * to an unreachable or detached ref fails (not rejects) with a reason.
   */
  | { kind: 'scroll'; ref: string }
  /**
   * Viewport scroll without a target, for exploratory paging. `amount`
   * defaults to `'page'` (one viewport height); a number scrolls that many CSS
   * pixels in the given direction. Scrolling mutates the viewport, so it
   * invalidates the current observation: observe again after scrolling.
   */
  | { kind: 'scroll'; direction: 'up' | 'down'; amount?: 'page' | number }
  /**
   * Select an option in a native `<select>`. The option is matched by
   * accessible label first, then by exact value; an ambiguous or missing
   * option fails with a clear reason instead of guessing. Selection uses the
   * underlying browser's native select mechanism so the page observes real
   * `input`/`change` events, never a JS value assignment.
   */
  | { kind: 'select'; ref: string; option: string }
  /**
   * Move the pointer over the element and keep the page in that hover state
   * long enough for a subsequent observe to see hover-revealed content. The
   * hover state persists until a later pointer-moving action (for example a
   * click on another element) moves the pointer away.
   */
  | { kind: 'hover'; ref: string }

export interface TargetChangedSnapshot {
  /** Observed role, present only when role is among the changed fields. */
  role?: string
  /** Observed accessible name, present only when name is among the changed fields. */
  name?: string
  /** Observed tag, present only when tag is among the changed fields. */
  tag?: string
  /** Observed disabled state, present only when disabled is among the changed fields. */
  disabled?: boolean
  /** Observed visibility gate state, present only when visible is among the changed fields. */
  visible?: boolean
}

export interface BrowserActionReceipt {
  receiptId: string
  ownerId: string
  action: BrowserActKind
  status: BrowserActionStatus
  startedAt: string
  completedAt: string
  /** True only after an input/navigation command was handed to the browser. */
  dispatched: boolean
  pageBefore: { url: string; title: string }
  pageAfter: { url: string; title: string }
  target?: {
    ref: string
    role: string
    name: string
  }
  observation?: {
    epoch: number
    fingerprint: string
  }
  verification?: {
    kind: 'browser-dispatch' | 'value-match' | 'navigation' | 'option-match'
    detail: string
  }
  code?: string
  reason?: string
  /**
   * Present on a TARGET_CHANGED refusal: the identity inputs that differ
   * between the observed node and the live element, in stable order
   * (role, name, tag, inputType, interactive, editable, disabled, visible,
   * download, href). A detached live element reports ['detached']. Values are
   * never inputs, so a value change alone never appears here.
   */
  changed?: string[]
  /** Present on a TARGET_CHANGED refusal: safe-subset snapshot BEFORE the change. */
  before?: TargetChangedSnapshot
  /** Present on a TARGET_CHANGED refusal: safe-subset snapshot AFTER the change. */
  after?: TargetChangedSnapshot
}

export interface BrowserConsoleEvidence {
  sequence: number
  at: string
  level: string
  text: string
  pageUrl: string
}

export interface BrowserNetworkEvidence {
  sequence: number
  at: string
  kind: 'response' | 'request-failed' | 'download-blocked'
  method: string
  url: string
  resourceType: string
  status?: number
  error?: string
}

export interface BrowserEvidenceOptions {
  maxConsole?: number
  maxNetwork?: number
}

export interface BrowserEvidence {
  ownerId: string
  page: { url: string; title: string }
  console: BrowserConsoleEvidence[]
  network: BrowserNetworkEvidence[]
  bounded: true
  limits: { console: number; network: number }
  dropped: { console: number; network: number }
}

export interface BrowserSessionStopResult {
  ownerId: string
  stopped: boolean
  reason: 'requested' | 'not-running'
  /**
   * Present, and always true, when the context close exceeded its bound (an
   * in-flight request the remote endpoint never answered) and the driver
   * force-killed the browser process before deleting the profile directory.
   */
  forced?: true
}

export interface ZSevenBrowserDriver {
  readonly kind: 'browser'
  readonly contractVersion: typeof BROWSER_DRIVER_CONTRACT_VERSION
  start(ownerId: string, options?: BrowserSessionStartOptions, signal?: AbortSignal): Promise<BrowserSessionInfo>
  observe(ownerId: string, options?: BrowserObservationOptions, signal?: AbortSignal): Promise<BrowserObservation>
  visualObserve(ownerId: string, request?: BrowserVisualObserveRequest, signal?: AbortSignal): Promise<BrowserVisualCapture>
  act(ownerId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserActionReceipt>
  evidence(ownerId: string, options?: BrowserEvidenceOptions, signal?: AbortSignal): Promise<BrowserEvidence>
  stop(ownerId: string): Promise<BrowserSessionStopResult>
  /** Abort/drain an in-flight start and close the active session for one host-owned Agent scope. */
  disposeScope(ownerId: string): Promise<void>
  dispose(): Promise<void>
}
