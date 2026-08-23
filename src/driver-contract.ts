/** Public driver contract consumed by dsh-qa and other orchestration plugins. */

export const BROWSER_DRIVER_SERVICE = 'zsevenBrowserDriver' as const
export const BROWSER_DRIVER_CONTRACT_VERSION = 1 as const

export type BrowserActionStatus = 'confirmed' | 'unknown' | 'rejected' | 'failed'
export type BrowserActKind = 'click' | 'fill' | 'press' | 'navigate'

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

export type BrowserAction =
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; text: string }
  | { kind: 'press'; ref: string; key: string }
  | { kind: 'navigate'; url: string }

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
    kind: 'browser-dispatch' | 'value-match' | 'navigation'
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
  act(ownerId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserActionReceipt>
  evidence(ownerId: string, options?: BrowserEvidenceOptions, signal?: AbortSignal): Promise<BrowserEvidence>
  stop(ownerId: string): Promise<BrowserSessionStopResult>
  /** Abort/drain an in-flight start and close the active session for one host-owned Agent scope. */
  disposeScope(ownerId: string): Promise<void>
  dispose(): Promise<void>
}
