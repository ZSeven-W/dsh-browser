/** Public driver contract consumed by dsh-qa and other orchestration plugins. */

export const BROWSER_DRIVER_SERVICE = 'zsevenBrowserDriver' as const
export const BROWSER_DRIVER_CONTRACT_VERSION = 3 as const

export type BrowserActionStatus = 'confirmed' | 'unknown' | 'rejected' | 'failed'
export type BrowserActKind = 'click' | 'fill' | 'press' | 'navigate' | 'scroll' | 'select' | 'hover'

export interface BrowserSessionStartOptions {
  /** Initial http(s) URL. Omit to start at about:blank. */
  url?: string
  /** Defaults to true. Headful mode is intended for local diagnosis only. */
  headless?: boolean
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
  /** Opaque, short-lived handle. Never a selector or backend node id. */
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
  truncated: boolean
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
