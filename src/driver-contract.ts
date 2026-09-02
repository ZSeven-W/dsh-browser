/** Public driver contract consumed by dsh-qa and other orchestration plugins. */

export const BROWSER_DRIVER_SERVICE = 'zsevenBrowserDriver' as const
export const BROWSER_DRIVER_CONTRACT_VERSION = 6 as const

export type BrowserActionStatus = 'confirmed' | 'unknown' | 'rejected' | 'failed'
export type BrowserActKind = 'click' | 'fill' | 'press' | 'navigate' | 'scroll' | 'select' | 'hover'

/**
 * One cookie in the Playwright storageState JSON format. The caller (dsh-qa)
 * injects ALREADY-FILTERED state: this driver performs no origin filtering
 * and applies the entries verbatim to a fresh ephemeral profile.
 */
export interface BrowserStorageCookie {
  name: string
  value: string
  /** Exact host or dot-prefixed parent (`.example.com`). Never a wildcard. */
  domain: string
  path: string
  /** Unix time in seconds. */
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

/**
 * Playwright storageState JSON shape (cookies + per-origin localStorage).
 * The driver accepts this verbatim; ownership of the origin/domain scoping
 * decision (fail-closed filtering) belongs to the caller, not to the driver.
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
   * Owner-authorized, already-filtered login state to pre-load into the fresh
   * ephemeral profile. The driver applies it at context creation and does NOT
   * filter, validate, copy, or persist it; the profile is destroyed on stop as
   * always. The caller must never pass state containing entries outside the
   * explicitly authorized origins.
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
}

export interface BrowserSemanticNode {
  /**
   * Opaque, short-lived handle. Never a selector or backend node id. A ref is
   * bound to the ORIGINAL DOM node observed: if that node is removed and an
   * identical twin takes its place, acting on the ref rejects (TARGET_CHANGED)
   * instead of silently re-resolving to the twin; Set-of-Mark boxes are
   * measured on the same original node.
   */
  ref: string
  role: string
  name: string
  tag: string
  interactive: boolean
  editable: boolean
  disabled: boolean
  /**
   * Whether the element's box currently intersects the viewport. Off-viewport
   * nodes still carry a ref so `scroll` can reach them, but they are omitted
   * from a viewport `visualObserve` capture with reason `off-viewport`.
   */
  inViewport: boolean
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
   * `multiple` select, the first selected option), and any element carrying
   * `aria-valuetext`/`aria-valuenow`.
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
   * or `cc-csc`, or a value-bearing control inside an `aria-hidden="true"`
   * subtree (the shape used by masked secure widgets). The secret never leaves
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
  nodes: BrowserSemanticNode[]
  /**
   * True whenever a selector-matching element that would have been emitted was
   * not: matches beyond the 500-match scan window, nodes cut by the node/byte
   * budgets, and iframe content (see truncationReasons).
   */
  truncated: boolean
  /**
   * Present when truncated is true; names every reason the view is partial.
   * Reasons: scan-window-exceeded, node-budget-exceeded,
   * byte-budget-exceeded, iframe-not-traversed.
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
