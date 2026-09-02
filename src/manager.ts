import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type BrowserContext, type CDPSession, type ElementHandle, type Page } from 'playwright-core'
import { discoverInstalledBrowser, type BrowserExecutable } from './browser-discovery.js'
import type {
  BrowserAction,
  BrowserActionReceipt,
  BrowserConsoleEvidence,
  BrowserEvidence,
  BrowserEvidenceOptions,
  BrowserFrame,
  BrowserNetworkEvidence,
  BrowserObservation,
  BrowserObservationOptions,
  BrowserSessionInfo,
  BrowserSessionStartOptions,
  BrowserSessionStopResult,
  BrowserVisualCapture,
  BrowserVisualMark,
  BrowserVisualObserveRequest,
  BrowserVisualOmission,
  ZSevenBrowserDriver,
} from './driver-contract.js'
import { BROWSER_DRIVER_CONTRACT_VERSION } from './driver-contract.js'
import { classifyActionRisk, normalizeNavigationUrl } from './risk.js'
import {
  collectSemanticCandidates,
  inspectSemanticHandle,
  observationFingerprint,
  opaqueRef,
  publicSemanticNode,
  semanticFingerprint,
  SEMANTIC_SELECTOR,
  type RawSemanticCandidate,
  type StoredSemanticTarget,
} from './semantic.js'
import { analyzePng, measureSemanticBoxesByHandles } from './visual.js'

const DEFAULT_OBSERVATION_TTL_MS = 30_000
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_ACTION_TIMEOUT_MS = 15_000
const MAX_OBSERVATION_BYTES = 48 * 1024
const MAX_EVIDENCE_RING = 200
const DEFAULT_MAX_CAPTURE_PIXELS = 4096 * 4096
const DEFAULT_MAX_CAPTURE_BYTES = 16 * 1024 * 1024
const MAX_CAPTURE_SCALE = 3
const MAX_MARKS = 200
const DEFAULT_MARKS = 80

type PersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>
type PersistentLauncher = (userDataDir: string, options: PersistentContextOptions) => Promise<BrowserContext>

export interface BrowserManagerOptions {
  rootDir?: string
  observationTtlMs?: number
  idleTimeoutMs?: number
  actionTimeoutMs?: number
  /** Operator-owned exact http(s) origins. Undefined means unrestricted; [] denies all web navigation. */
  allowedOrigins?: readonly string[]
  /** Maximum visual capture size in pixels (width x height). Defaults to 4096^2. */
  maxCapturePixels?: number
  /** Maximum visual capture size in PNG bytes. Defaults to 16 MiB. */
  maxCaptureBytes?: number
  now?: () => number
  discoverBrowser?: () => Promise<BrowserExecutable>
  launchPersistentContext?: PersistentLauncher
}

interface ObservationRecord {
  epoch: number
  fingerprint: string
  rawUrl: string
  expiresAtMs: number
  targets: Map<string, StoredSemanticTarget>
}

interface ManagedSession {
  ownerId: string
  context: BrowserContext
  page: Page
  executable: BrowserExecutable
  userDataDir: string
  headless: boolean
  secret: Buffer
  epoch: number
  observation: ObservationRecord | undefined
  console: BrowserConsoleEvidence[]
  network: BrowserNetworkEvidence[]
  consoleDropped: number
  networkDropped: number
  sequence: number
  closed: boolean
  closing: boolean
  dirRemoval: Promise<void> | undefined
  idleTimer?: NodeJS.Timeout
  tail: Promise<void>
  policyPages: WeakSet<Page>
  policySessions: Set<CDPSession>
  attachedPages: WeakSet<Page>
  readyPages: Set<Page>
}

class DriverIssue extends Error {
  constructor(readonly code: string, message: string, readonly rejected: boolean) {
    super(message)
    this.name = 'DriverIssue'
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function compact(value: string, max: number): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, max)
}

function isDetachedElementError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:element|node).{0,40}(?:detached|not attached)|not connected to the document/iu.test(message)
}

export function publicPageUrl(value: string): string {
  if (value === 'about:blank') return value
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.href.slice(0, 1000)
  } catch {
    return value.slice(0, 1000)
  }
}

export function redactEvidenceText(value: string): string {
  return compact(value, 800)
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/giu, '[REDACTED_AUTH]')
    .replace(/(authorization|proxy-authorization)\s*[:=]\s*[^\s,;]+/giu, '$1: [REDACTED]')
    .replace(/([?&](?:token|access_token|api_key|key|secret|code)=)[^&\s]+/giu, '$1[REDACTED]')
}

function evidenceUrl(value: string): string {
  return publicPageUrl(value)
}

function validateOwner(ownerId: string): string {
  if (typeof ownerId !== 'string' || ownerId.trim() === '') throw new DriverIssue('AGENT_ID_REQUIRED', 'exec.agent.id is required for browser session isolation', true)
  const normalized = ownerId.trim()
  if (normalized.length > 256) throw new DriverIssue('AGENT_ID_INVALID', 'agent id exceeds 256 characters', true)
  return normalized
}

function normalizePolicyOrigin(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('allowedOrigins entries must be non-empty origins')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error(`invalid allowed origin: ${value}`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`allowed origin must use http or https: ${value}`)
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`allowedOrigins accepts exact origins only (scheme + host + optional port): ${value}`)
  }
  return parsed.origin
}

async function pageSummary(page: Page): Promise<{ url: string; title: string }> {
  let title = ''
  try { title = compact(await page.title(), 300) } catch { /* closed/crashed page */ }
  let url = 'about:blank'
  try { url = publicPageUrl(page.url()) } catch { /* closed/crashed page */ }
  return { url, title }
}

async function waitForAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    onAbort()
    throw new DriverIssue('CANCELLED', 'browser operation was cancelled', true)
  }
  let rejectAbort: ((error: Error) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const listener = (): void => {
    onAbort()
    rejectAbort?.(new DriverIssue('CANCELLED', 'browser operation was cancelled', true))
  }
  signal.addEventListener('abort', listener, { once: true })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

/** Managed, one-browser-context-per-agent implementation of the QA driver contract. */
export class BrowserManager implements ZSevenBrowserDriver {
  readonly #sessions = new Map<string, ManagedSession>()
  readonly #startControllers = new Map<string, AbortController>()
  readonly #startWaiters = new Set<Promise<void>>()
  readonly #startWaitersByOwner = new Map<string, Promise<void>>()
  readonly #pendingCleanup = new Set<Promise<void>>()
  readonly #rootDir: string
  readonly #observationTtlMs: number
  readonly #idleTimeoutMs: number
  readonly #actionTimeoutMs: number
  readonly #allowedOrigins: ReadonlySet<string> | undefined
  readonly #maxCapturePixels: number
  readonly #maxCaptureBytes: number
  readonly #now: () => number
  readonly #discoverBrowser: () => Promise<BrowserExecutable>
  readonly #launch: PersistentLauncher
  #disposed = false
  #disposePromise: Promise<void> | undefined

  constructor(options: BrowserManagerOptions = {}) {
    this.#rootDir = options.rootDir ?? join(tmpdir(), 'dsh-browser')
    this.#observationTtlMs = clampInt(options.observationTtlMs, DEFAULT_OBSERVATION_TTL_MS, 1_000, 5 * 60_000)
    this.#idleTimeoutMs = clampInt(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 0, 24 * 60 * 60_000)
    this.#actionTimeoutMs = clampInt(options.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT_MS, 1_000, 60_000)
    this.#allowedOrigins = options.allowedOrigins === undefined
      ? undefined
      : new Set(options.allowedOrigins.map(normalizePolicyOrigin))
    this.#maxCapturePixels = clampInt(options.maxCapturePixels, DEFAULT_MAX_CAPTURE_PIXELS, 1, 512 * 1024 * 1024)
    this.#maxCaptureBytes = clampInt(options.maxCaptureBytes, DEFAULT_MAX_CAPTURE_BYTES, 1, 512 * 1024 * 1024)
    this.#now = options.now ?? Date.now
    this.#discoverBrowser = options.discoverBrowser ?? (() => discoverInstalledBrowser())
    this.#launch = options.launchPersistentContext
      ?? ((userDataDir, launchOptions) => chromium.launchPersistentContext(userDataDir, launchOptions))
  }

  readonly kind = 'browser' as const
  readonly contractVersion = BROWSER_DRIVER_CONTRACT_VERSION

  activeOwners(): string[] {
    return [...this.#sessions.keys()].sort()
  }

  async start(ownerId: string, options: BrowserSessionStartOptions = {}, signal?: AbortSignal): Promise<BrowserSessionInfo> {
    const owner = validateOwner(ownerId)
    if (this.#disposed) throw new DriverIssue('DRIVER_DISPOSED', 'browser driver is disposed', true)
    if (this.#sessions.has(owner) || this.#startControllers.has(owner)) throw new DriverIssue('SESSION_EXISTS', 'this agent already owns a running or starting browser session; stop it before starting another', true)
    const lifecycleAbort = new AbortController()
    this.#startControllers.set(owner, lifecycleAbort)
    const operationSignal = signal === undefined
      ? lifecycleAbort.signal
      : AbortSignal.any([signal, lifecycleAbort.signal])
    let settleStart!: () => void
    const startWaiter = new Promise<void>((resolve) => { settleStart = resolve })
    this.#startWaiters.add(startWaiter)
    this.#startWaitersByOwner.set(owner, startWaiter)
    const headless = options.headless !== false
    const initialUrl = options.url === undefined ? 'about:blank' : normalizeNavigationUrl(options.url)
    this.#assertAllowedUrl(initialUrl)
    let userDataDir: string | undefined
    let context: BrowserContext | undefined
    let managedSession: ManagedSession | undefined
    try {
      const executable = await waitForAbortable(this.#discoverBrowser(), operationSignal, () => {})
      if (this.#disposed || operationSignal.aborted) throw new DriverIssue('DRIVER_DISPOSED', 'browser driver was disposed while the session was starting', true)
      await mkdir(this.#rootDir, { recursive: true })
      userDataDir = await mkdtemp(join(this.#rootDir, 'session-'))
      const launchPromise = this.#launch(userDataDir, {
        executablePath: executable.path,
        headless,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: false,
        args: [
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-sync',
          '--no-default-browser-check',
          '--no-first-run',
        ],
      })
      try {
        context = await waitForAbortable(launchPromise, operationSignal, () => {})
      } catch (error) {
        // A launcher may ignore AbortSignal entirely. Drain it, close the late
        // context, and only then let dispose/start settle.
        if (operationSignal.aborted) {
          const lateContext = await launchPromise.catch(() => undefined)
          if (lateContext) await lateContext.close().catch(() => {})
        }
        throw error
      }
      if (this.#disposed || operationSignal.aborted) {
        await context.close().catch(() => {})
        throw new DriverIssue('DRIVER_DISPOSED', 'browser driver was disposed while the browser process was launching', true)
      }
      const pages = context.pages()
      const page = pages[0] ?? await context.newPage()
      const session: ManagedSession = {
        ownerId: owner,
        context,
        page,
        executable,
        userDataDir,
        headless,
        secret: randomBytes(32),
        epoch: 0,
        observation: undefined,
        console: [],
        network: [],
        consoleDropped: 0,
        networkDropped: 0,
        sequence: 0,
        closed: false,
        closing: false,
        dirRemoval: undefined,
        tail: Promise.resolve(),
        policyPages: new WeakSet(),
        policySessions: new Set(),
        attachedPages: new WeakSet(),
        readyPages: new Set(),
      }
      if (this.#disposed || operationSignal.aborted) {
        await context.close().catch(() => {})
        throw new DriverIssue('DRIVER_DISPOSED', 'browser driver was disposed before session registration', true)
      }
      managedSession = session
      this.#sessions.set(owner, session)
      await this.#installOriginPolicy(session)
      if (this.#disposed || operationSignal.aborted || session.closed) throw new DriverIssue('DRIVER_DISPOSED', 'browser driver was disposed during policy installation', true)
      for (const openPage of context.pages()) {
        this.#attachPage(session, openPage)
        session.readyPages.add(openPage)
      }
      context.on('page', (opened) => {
        void this.#adoptPage(session, opened)
      })
      context.on('close', () => { this.#trackCleanup(this.#onContextClosed(session)) })
      this.#touch(session)

      const storageState = options.storageState
      if (storageState !== undefined) {
        // launchPersistentContext has no storageState option (that parameter
        // belongs to newContext), so the pre-filtered state is applied
        // explicitly: cookies through the context, localStorage by visiting
        // each origin once before the session's first real navigation. Every
        // storage origin must clear the same origin allowlist as navigation.
        if (storageState.cookies.length > 0) {
          await this.#abortClosesSession(session, operationSignal, context.addCookies(storageState.cookies))
        }
        for (const entry of storageState.origins) {
          const originUrl = normalizeNavigationUrl(entry.origin)
          this.#assertAllowedUrl(originUrl)
          await this.#abortClosesSession(
            session,
            operationSignal,
            page
              .goto(originUrl, { waitUntil: 'domcontentloaded', timeout: this.#actionTimeoutMs })
              .then(() => page.evaluate((items) => {
                for (const item of items) localStorage.setItem(item.name, item.value)
              }, entry.localStorage)),
          )
        }
        if (storageState.origins.length > 0 && initialUrl === 'about:blank') {
          await this.#abortClosesSession(session, operationSignal, page.goto('about:blank', { timeout: this.#actionTimeoutMs }))
        }
      }

      if (initialUrl !== 'about:blank') {
        await this.#abortClosesSession(
          session,
          operationSignal,
          page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: this.#actionTimeoutMs }),
        )
      }
      const summary = await pageSummary(session.page)
      return {
        ownerId: owner,
        state: 'running',
        headless,
        browser: {
          channel: executable.channel,
          version: compact(context.browser()?.version() ?? 'unknown', 100),
        },
        page: summary,
        isolation: 'ephemeral-user-data',
        navigationPolicy: {
          mode: this.#allowedOrigins === undefined ? 'unrestricted' : 'allowlist',
          allowedOrigins: this.#allowedOrigins === undefined ? [] : [...this.#allowedOrigins].sort(),
        },
      }
    } catch (error) {
      if (managedSession) await this.#closeSession(managedSession).catch(() => {})
      else {
        if (context) await context.close().catch(() => {})
        if (userDataDir !== undefined) await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
      }
      throw error
    } finally {
      if (this.#startControllers.get(owner) === lifecycleAbort) this.#startControllers.delete(owner)
      settleStart()
      this.#startWaiters.delete(startWaiter)
      if (this.#startWaitersByOwner.get(owner) === startWaiter) this.#startWaitersByOwner.delete(owner)
    }
  }

  async observe(ownerId: string, options: BrowserObservationOptions = {}, signal?: AbortSignal): Promise<BrowserObservation> {
    const owner = validateOwner(ownerId)
    return this.#exclusive(owner, signal, async (session) => {
      const maxNodes = clampInt(options.maxNodes, 60, 1, 100)
      const scan = await this.#abortClosesSession(session, signal, collectSemanticCandidates(session.page, 500))
      const raw = scan.candidates
      const epoch = session.epoch + 1
      session.epoch = epoch
      const expiresAtMs = this.#now() + this.#observationTtlMs
      const targets: StoredSemanticTarget[] = []
      let bytes = 2
      let nodeBudgetExceeded = false
      let byteBudgetExceeded = false
      for (const [index, candidate] of raw.entries()) {
        if (targets.length >= maxNodes) {
          nodeBudgetExceeded = raw.length > targets.length
          break
        }
        const fingerprint = semanticFingerprint(candidate)
        const target: StoredSemanticTarget = {
          ...candidate,
          fingerprint,
          ref: opaqueRef(session.secret, epoch, fingerprint, index),
        }
        const publicNode = publicSemanticNode(target)
        const nodeBytes = Buffer.byteLength(JSON.stringify(publicNode), 'utf8') + 1
        if (bytes + nodeBytes > MAX_OBSERVATION_BYTES) {
          byteBudgetExceeded = true
          break
        }
        bytes += nodeBytes
        targets.push(target)
      }
      const rawUrl = session.page.url()
      const title = compact(await session.page.title().catch(() => ''), 300)
      // Bind each emitted target to the Playwright element handle of the exact
      // node it denotes. A ref must resolve to the ORIGINAL node identity, never
      // to a selector re-match, so an identical twin sliding into the stored
      // selector path cannot be substituted. A target whose binding cannot be
      // verified is dropped and the observation is flagged truncated.
      const bindingDropped = await this.#bindTargetHandles(session, targets)
      if (bindingDropped > 0) targets.splice(0, targets.length, ...targets.filter((target) => target.handle !== undefined))
      const fingerprint = observationFingerprint(rawUrl, title, targets)
      const previous = session.observation
      session.observation = {
        epoch,
        fingerprint,
        rawUrl,
        expiresAtMs,
        targets: new Map(targets.map((target) => [target.ref, target])),
      }
      if (previous) void this.#disposeObservationHandles(previous)
      const viewport = session.page.viewportSize() ?? { width: 0, height: 0 }
      const truncationReasons: string[] = []
      if (scan.scanned < scan.totalMatches) truncationReasons.push('scan-window-exceeded')
      if (nodeBudgetExceeded) truncationReasons.push('node-budget-exceeded')
      if (byteBudgetExceeded) truncationReasons.push('byte-budget-exceeded')
      if (bindingDropped > 0) truncationReasons.push('identity-binding-failed')
      this.#touch(session)
      return {
        ownerId: owner,
        epoch,
        fingerprint,
        expiresAt: iso(expiresAtMs),
        page: {
          url: publicPageUrl(rawUrl),
          title,
          viewport: { width: viewport.width, height: viewport.height },
        },
        nodes: targets.map(publicSemanticNode),
        truncated: truncationReasons.length > 0,
        ...(truncationReasons.length > 0 ? { truncationReasons } : {}),
        limits: { maxNodes, maxBytes: MAX_OBSERVATION_BYTES },
      }
    })
  }

  async visualObserve(ownerId: string, request: BrowserVisualObserveRequest = {}, signal?: AbortSignal): Promise<BrowserVisualCapture> {
    const owner = validateOwner(ownerId)
    return this.#exclusive(owner, signal, async (session) => {
      const observation = session.observation
      if (!observation) throw new DriverIssue('OBSERVATION_REQUIRED', 'call browser_observe before requesting a visual capture', true)
      if (this.#now() > observation.expiresAtMs) throw new DriverIssue('REF_EXPIRED', 'the semantic observation expired; observe again before visual capture', true)
      if (session.page.url() !== observation.rawUrl) throw new DriverIssue('PAGE_CHANGED', 'the page URL changed after observation; observe again before visual capture', true)
      if (request.fingerprint !== undefined && request.fingerprint !== observation.fingerprint) {
        throw new DriverIssue('OBSERVATION_STALE', 'the requested observation fingerprint is not the latest observation; observe again', true)
      }
      const fullPage = request.fullPage === true
      const scale = clampInt(request.scale, 1, 1, MAX_CAPTURE_SCALE)
      const maxMarks = clampInt(request.maxMarks, DEFAULT_MARKS, 1, MAX_MARKS)
      const targets = [...observation.targets.values()]

      if (fullPage) {
        await this.#abortClosesSession(session, signal, session.page.evaluate(() => { window.scrollTo(0, 0) }))
      }
      const measured = await this.#abortClosesSession(
        session,
        signal,
        measureSemanticBoxesByHandles(session.page, targets.map((target) => target.handle ?? null)),
      ).catch((error: unknown) => {
        if (error instanceof DriverIssue) throw error
        // Same-URL reloads and replaced documents destroy the execution
        // context the retained handles live in; the observed DOM no longer
        // exists, so the capture cannot be honest.
        throw new DriverIssue('OBSERVATION_STALE', 'the observed document was replaced or destroyed; observe again', true)
      })
      const viewport = session.page.viewportSize() ?? { width: 0, height: 0 }
      const captureWidth = fullPage ? measured.docWidth : viewport.width
      const captureHeight = fullPage ? measured.docHeight : viewport.height
      if (captureWidth <= 0 || captureHeight <= 0) throw new DriverIssue('CAPTURE_EMPTY', 'the page has no renderable area to capture', true)
      const pixelWidth = Math.ceil(captureWidth * scale)
      const pixelHeight = Math.ceil(captureHeight * scale)
      const totalPixels = pixelWidth * pixelHeight
      if (totalPixels > this.#maxCapturePixels) {
        throw new DriverIssue(
          'CAPTURE_TOO_LARGE',
          `capture would be ${pixelWidth}x${pixelHeight} (${totalPixels} px), exceeding the ${this.#maxCapturePixels} px budget; reduce scale or capture the viewport only`,
          true,
        )
      }

      const png = await this.#abortClosesSession(session, signal, this.#capturePng(session, fullPage, captureWidth, captureHeight, scale))
      if (png.byteLength > this.#maxCaptureBytes) {
        throw new DriverIssue('CAPTURE_TOO_LARGE', `capture produced ${png.byteLength} bytes, exceeding the ${this.#maxCaptureBytes} byte budget`, true)
      }
      const analysis = analyzePng(png)
      const artifactPath = await this.#writeCaptureFile(session, png)

      const marks: BrowserVisualMark[] = []
      const omitted: BrowserVisualOmission[] = []
      for (const [index, target] of targets.entries()) {
        const row = measured.rows[index]
        let omitReason: string | undefined
        let markBox: BrowserFrame | undefined
        if (!row) {
          omitReason = 'not-found'
        } else if (!row.found) {
          omitReason = 'not-found'
        } else if (!row.connected) {
          omitReason = 'detached'
        } else if (row.hidden) {
          omitReason = 'hidden'
        } else if (row.zeroSize) {
          omitReason = 'zero-size'
        } else if (!fullPage && !row.inViewport) {
          omitReason = 'off-viewport'
        } else if (fullPage && !row.inDocument) {
          omitReason = 'off-page'
        } else if (row.occluded) {
          omitReason = 'occluded'
        } else {
          const css = fullPage ? row.box : row.viewportBox
          const x = Math.max(0, Math.min(captureWidth, css.x))
          const y = Math.max(0, Math.min(captureHeight, css.y))
          const right = Math.max(x, Math.min(captureWidth, css.x + css.width))
          const bottom = Math.max(y, Math.min(captureHeight, css.y + css.height))
          if (right - x <= 0 || bottom - y <= 0) {
            omitReason = fullPage ? 'off-page' : 'off-viewport'
          } else {
            markBox = { x, y, width: right - x, height: bottom - y }
          }
        }
        if (omitReason !== undefined) {
          omitted.push({ ref: target.ref, sourceIndex: index, reason: omitReason })
        } else if (marks.length < maxMarks) {
          const box = markBox as BrowserFrame
          marks.push({
            number: index + 1,
            ref: target.ref,
            sourceIndex: index,
            nativePixelFrame: {
              x: box.x * scale,
              y: box.y * scale,
              width: box.width * scale,
              height: box.height * scale,
            },
          })
        } else {
          omitted.push({ ref: target.ref, sourceIndex: index, reason: 'mark-budget-exceeded' })
        }
      }

      const capturedAtMs = this.#now()
      const title = compact(await session.page.title().catch(() => ''), 300)
      this.#touch(session)
      return {
        ownerId: owner,
        epoch: observation.epoch,
        observationFingerprint: observation.fingerprint,
        capturedAt: iso(capturedAtMs),
        expiresAt: iso(observation.expiresAtMs),
        page: {
          url: publicPageUrl(observation.rawUrl),
          title,
          viewport: { width: viewport.width, height: viewport.height },
        },
        png: new Uint8Array(png),
        capture: {
          artifact: {
            format: 'png',
            byteLength: png.byteLength,
            sha256: createHash('sha256').update(png).digest('hex'),
            path: artifactPath,
          },
          pointFrame: { x: 0, y: 0, width: captureWidth, height: captureHeight },
          pixelWidth: analysis.width,
          pixelHeight: analysis.height,
          scaleX: analysis.width / captureWidth,
          scaleY: analysis.height / captureHeight,
          fullPage,
          quality: analysis.quality,
        },
        marks,
        omitted,
      }
    })
  }

  async act(ownerId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserActionReceipt> {
    const owner = typeof ownerId === 'string' && ownerId.trim() !== '' ? ownerId.trim() : String(ownerId ?? '')
    const startedMs = this.#now()
    const startedAt = iso(startedMs)
    let session = this.#sessions.get(owner)
    const fallbackPage = { url: 'about:blank', title: '' }
    if (!session || session.closed) {
      return {
        receiptId: randomUUID(), ownerId: owner, action: action.kind, status: 'failed', startedAt,
        completedAt: iso(this.#now()), dispatched: false, pageBefore: fallbackPage, pageAfter: fallbackPage,
        code: 'SESSION_NOT_RUNNING', reason: 'this agent has no running browser session',
      }
    }

    return this.#exclusive(owner, signal, async (active) => {
      session = active
      const pageBefore = await pageSummary(active.page)
      let pageAfter = pageBefore
      let dispatched = false
      let targetResult: BrowserActionReceipt['target']
      let observationResult: BrowserActionReceipt['observation']
      let verification: BrowserActionReceipt['verification']
      let status: BrowserActionReceipt['status'] = 'failed'
      let code: string | undefined
      let reason: string | undefined

      try {
        if (!action || !['click', 'fill', 'press', 'navigate', 'scroll', 'select', 'hover'].includes(action.kind)) {
          throw new DriverIssue('ACTION_INVALID', 'action kind must be click, fill, press, navigate, scroll, select, or hover', true)
        }
        if (action.kind === 'navigate') {
          const decision = classifyActionRisk(action)
          if (!decision.allowed) throw new DriverIssue(decision.code, decision.reason, true)
          const destination = normalizeNavigationUrl(action.url)
          this.#assertAllowedUrl(destination)
          dispatched = true
          await this.#abortClosesSession(
            active,
            signal,
            active.page.goto(destination, { waitUntil: 'domcontentloaded', timeout: this.#actionTimeoutMs }),
          )
          this.#assertAllowedUrl(active.page.url())
          status = 'confirmed'
          verification = { kind: 'navigation', detail: 'browser reported DOMContentLoaded for the validated destination' }
        } else if (action.kind === 'scroll' && !('ref' in action)) {
          // Viewport scroll without a target, for exploratory paging.
          if (action.direction !== 'up' && action.direction !== 'down') {
            throw new DriverIssue('SCROLL_DIRECTION_INVALID', 'scroll direction must be "up" or "down"', true)
          }
          const amount = action.amount === undefined ? 'page' : action.amount
          if (amount !== 'page' && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) {
            throw new DriverIssue('SCROLL_AMOUNT_INVALID', 'scroll amount must be "page" or a non-negative pixel count', true)
          }
          const before = await this.#abortClosesSession(active, signal, active.page.evaluate(() => window.scrollY))
          dispatched = true
          const after = await this.#abortClosesSession(active, signal, active.page.evaluate(({ direction, amount }) => {
            const delta = amount === 'page' ? window.innerHeight : amount
            window.scrollBy(0, direction === 'up' ? -delta : delta)
            return window.scrollY
          }, { direction: action.direction, amount }))
          status = 'confirmed'
          verification = {
            kind: 'browser-dispatch',
            detail: `viewport scroll ${action.direction} by ${amount === 'page' ? 'one page' : `${amount}px`} (scrollY ${before} -> ${after})`,
          }
          await delay(100)
          if (active.closed) throw new DriverIssue('SESSION_CLOSED_AFTER_ACTION', 'the session closed fail-closed during action navigation', true)
          this.#assertAllowedUrl(active.page.url())
        } else {
          if (typeof action.ref !== 'string' || action.ref.length > 128) {
            throw new DriverIssue('REF_INVALID', 'ref must be a short opaque reference from browser_observe', true)
          }
          // A scroll that cannot resolve its ref is a capability failure, not
          // a policy refusal: the browser genuinely could not scroll to it.
          const resolved = await this.#resolveTarget(active, action.ref, signal, action.kind !== 'scroll')
          {
            targetResult = { ref: action.ref, role: resolved.target.role, name: resolved.target.name }
            const observed = active.observation
            if (observed) observationResult = { epoch: observed.epoch, fingerprint: observed.fingerprint }
            if (action.kind === 'scroll') {
              // Positional: no interactivity, disabled, risk, or hit-test gate.
              dispatched = true
              await this.#abortClosesSession(active, signal, resolved.handle.evaluate((element) => {
                element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
              }))
              const inView = await resolved.handle.evaluate((element) => {
                if (!element.isConnected) return false
                const rect = element.getBoundingClientRect()
                return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight
              })
              if (!inView) {
                status = 'failed'
                code = 'SCROLL_TARGET_UNREACHABLE'
                reason = 'the referenced element could not be scrolled into the viewport'
                verification = { kind: 'browser-dispatch', detail: 'scroll command completed but the element did not intersect the viewport' }
              } else {
                status = 'confirmed'
                verification = { kind: 'browser-dispatch', detail: 'scrolled the bound backend node into view (center) and verified it intersects the viewport' }
              }
            } else {
              if (!resolved.target.interactive) throw new DriverIssue('TARGET_NOT_INTERACTIVE', 'the live target is not semantically interactive', true)
              if (resolved.target.disabled) throw new DriverIssue('TARGET_DISABLED', 'the live target is disabled', true)
              if (action.kind === 'fill' && !resolved.target.editable) throw new DriverIssue('TARGET_NOT_EDITABLE', 'fill requires a live editable target', true)
              if (action.kind === 'fill' && (typeof action.text !== 'string' || action.text.length > 10_000)) {
                throw new DriverIssue('TEXT_INVALID', 'fill text must be a string of at most 10000 characters', true)
              }
              if (action.kind === 'press' && (typeof action.key !== 'string' || action.key.trim() === '' || action.key.length > 80)) {
                throw new DriverIssue('KEY_INVALID', 'press key must be a non-empty Playwright key of at most 80 characters', true)
              }
              if (action.kind === 'select' && resolved.target.tag !== 'select') {
                throw new DriverIssue('SELECT_NOT_SELECT', 'select requires a live native <select> target', false)
              }
              if (action.kind === 'select' && (typeof action.option !== 'string' || action.option.trim() === '' || action.option.length > 1000)) {
                throw new DriverIssue('OPTION_INVALID', 'select option must be a non-empty string of at most 1000 characters', true)
              }
              const decision = classifyActionRisk(action, resolved.target)
              if (!decision.allowed) throw new DriverIssue(decision.code, decision.reason, true)
              if (action.kind === 'click' && resolved.target.href !== undefined && !this.#originAllowed(resolved.target.href)) {
                this.#scheduleClose(active)
                throw new DriverIssue('ORIGIN_POLICY_VIOLATION', 'link target origin is outside the operator-owned allowlist', true)
              }

              await this.#hitTest(resolved.handle)
              if (action.kind === 'click') {
                dispatched = true
                await this.#abortClosesSession(active, signal, resolved.handle.click({ timeout: this.#actionTimeoutMs }))
                verification = { kind: 'browser-dispatch', detail: 'Playwright completed click on the same bound backend node used for risk and hit-test' }
                status = 'confirmed'
              } else if (action.kind === 'fill') {
                dispatched = true
                await this.#abortClosesSession(active, signal, resolved.handle.fill(action.text, { timeout: this.#actionTimeoutMs }))
                const liveValue = await resolved.handle.inputValue()
                status = liveValue === action.text ? 'confirmed' : 'failed'
                verification = {
                  kind: 'value-match',
                  detail: liveValue === action.text
                    ? `live value matched on the bound backend node (${action.text.length} characters; value omitted)`
                    : `live value did not match requested length ${action.text.length} (values omitted)`,
                }
                if (status === 'failed') {
                  code = 'VALUE_MISMATCH'
                  reason = 'the editable target did not retain the requested value'
                }
              } else if (action.kind === 'press') {
                dispatched = true
                await this.#abortClosesSession(active, signal, resolved.handle.press(action.key, { timeout: this.#actionTimeoutMs }))
                verification = { kind: 'browser-dispatch', detail: 'Playwright completed key dispatch on the same bound backend node used for risk and hit-test' }
                status = 'confirmed'
              } else if (action.kind === 'select') {
                const match = await resolved.handle.evaluate((element, wanted) => {
                  const normalize = (value: string | null | undefined): string => String(value ?? '').replace(/\s+/gu, ' ').trim()
                  const options = Array.from((element as HTMLSelectElement).options)
                  const labelMatches: number[] = []
                  const valueMatches: number[] = []
                  for (let index = 0; index < options.length; index += 1) {
                    const option = options[index] as HTMLOptionElement
                    const label = normalize(option.getAttribute('label') ?? option.textContent ?? '')
                    if (label === wanted) labelMatches.push(index)
                    if (option.value === wanted) valueMatches.push(index)
                  }
                  let kind: 'label' | 'value' | 'ambiguous-label' | 'ambiguous-value' | 'missing' = 'missing'
                  let index = -1
                  let count = 0
                  if (labelMatches.length === 1) {
                    kind = 'label'
                    index = labelMatches[0] ?? -1
                  } else if (labelMatches.length > 1) {
                    kind = 'ambiguous-label'
                    count = labelMatches.length
                  } else if (valueMatches.length === 1) {
                    kind = 'value'
                    index = valueMatches[0] ?? -1
                  } else if (valueMatches.length > 1) {
                    kind = 'ambiguous-value'
                    count = valueMatches.length
                  }
                  return { kind, index, count }
                }, action.option)
                if (match.kind === 'missing') {
                  status = 'failed'
                  code = 'SELECT_OPTION_MISSING'
                  reason = `option "${action.option}" matches no option label or value`
                  verification = { kind: 'option-match', detail: 'no option label or value matched the requested option' }
                } else if (match.kind === 'ambiguous-label' || match.kind === 'ambiguous-value') {
                  status = 'failed'
                  code = 'SELECT_OPTION_AMBIGUOUS'
                  reason = `option "${action.option}" matches ${match.count} options by ${match.kind === 'ambiguous-label' ? 'label' : 'value'}; use a unique label or value`
                  verification = { kind: 'option-match', detail: 'multiple options matched the requested option' }
                } else {
                  dispatched = true
                  await this.#abortClosesSession(active, signal, resolved.handle.selectOption({ index: match.index }))
                  const selected = await resolved.handle.evaluate((element, index) => {
                    const select = element as HTMLSelectElement
                    const option = select.options[index]
                    return option !== undefined && option.selected === true && select.value === option.value
                  }, match.index)
                  if (selected) {
                    status = 'confirmed'
                    verification = { kind: 'option-match', detail: `selected the option matched by ${match.kind} on the bound select` }
                  } else {
                    status = 'failed'
                    code = 'OPTION_MISMATCH'
                    reason = 'the select did not retain the chosen option'
                    verification = { kind: 'option-match', detail: 'the native select did not retain the chosen option' }
                  }
                }
              } else {
                dispatched = true
                await this.#abortClosesSession(active, signal, resolved.handle.hover({ timeout: this.#actionTimeoutMs }))
                verification = { kind: 'browser-dispatch', detail: 'Playwright completed hover on the same bound backend node used for risk and hit-test; the pointer stays over the element' }
                status = 'confirmed'
              }
            }
            // Let popup/navigation policy handlers run before confirming the
            // session remains controllable.
            await delay(100)
            if (active.closed) throw new DriverIssue('SESSION_CLOSED_AFTER_ACTION', 'the session closed fail-closed during action navigation', true)
            this.#assertAllowedUrl(active.page.url())
          }
        }
      } catch (error) {
        if (!(error instanceof DriverIssue) && isDetachedElementError(error)) {
          error = new DriverIssue('TARGET_DETACHED', 'the bound backend node detached or was replaced before dispatch', true)
        }
        if (error instanceof DriverIssue) {
          if (error.code === 'TARGET_DETACHED') dispatched = false
          status = error.rejected && !dispatched ? 'rejected' : (dispatched ? 'unknown' : 'failed')
          code = error.code
          reason = error.message
        } else if (signal?.aborted) {
          status = dispatched ? 'unknown' : 'rejected'
          code = 'CANCELLED'
          reason = dispatched
            ? 'cancellation closed the isolated browser after dispatch; the page outcome is unknown'
            : 'operation was cancelled before browser dispatch'
        } else {
          status = dispatched ? 'unknown' : 'failed'
          code = dispatched ? 'DISPATCH_OUTCOME_UNKNOWN' : 'BROWSER_OPERATION_FAILED'
          reason = compact(error instanceof Error ? error.message : String(error), 500)
        }
      } finally {
        if (dispatched) {
          const previous = active.observation
          active.observation = undefined
          void this.#disposeObservationHandles(previous)
        }
        pageAfter = await pageSummary(active.page)
        if (!active.closed) this.#touch(active)
      }

      return {
        receiptId: randomUUID(),
        ownerId: owner,
        action: action.kind,
        status,
        startedAt,
        completedAt: iso(this.#now()),
        dispatched,
        pageBefore,
        pageAfter,
        ...(targetResult === undefined ? {} : { target: targetResult }),
        ...(observationResult === undefined ? {} : { observation: observationResult }),
        ...(verification === undefined ? {} : { verification }),
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      }
    }).catch(async (error: unknown) => {
      const summary = session && !session.closed ? await pageSummary(session.page) : fallbackPage
      const issue = error instanceof DriverIssue ? error : undefined
      return {
        receiptId: randomUUID(), ownerId: owner, action: action.kind,
        status: issue?.rejected ? 'rejected' : 'failed', startedAt, completedAt: iso(this.#now()),
        dispatched: false, pageBefore: summary, pageAfter: summary,
        code: issue?.code ?? 'BROWSER_OPERATION_FAILED',
        reason: compact(issue?.message ?? (error instanceof Error ? error.message : String(error)), 500),
      }
    })
  }

  async evidence(ownerId: string, options: BrowserEvidenceOptions = {}, signal?: AbortSignal): Promise<BrowserEvidence> {
    const owner = validateOwner(ownerId)
    return this.#exclusive(owner, signal, async (session) => {
      if (signal?.aborted) throw new DriverIssue('CANCELLED', 'browser evidence collection was cancelled', true)
      const consoleLimit = clampInt(options.maxConsole, 50, 1, 100)
      const networkLimit = clampInt(options.maxNetwork, 50, 1, 100)
      const consoleOmitted = Math.max(0, session.console.length - consoleLimit)
      const networkOmitted = Math.max(0, session.network.length - networkLimit)
      this.#touch(session)
      return {
        ownerId: owner,
        page: await pageSummary(session.page),
        console: session.console.slice(-consoleLimit),
        network: session.network.slice(-networkLimit),
        bounded: true,
        limits: { console: consoleLimit, network: networkLimit },
        dropped: {
          console: session.consoleDropped + consoleOmitted,
          network: session.networkDropped + networkOmitted,
        },
      }
    })
  }

  async stop(ownerId: string): Promise<BrowserSessionStopResult> {
    const owner = validateOwner(ownerId)
    const session = this.#sessions.get(owner)
    if (!session) return { ownerId: owner, stopped: false, reason: 'not-running' }
    await this.#closeSession(session)
    return { ownerId: owner, stopped: true, reason: 'requested' }
  }

  async disposeScope(ownerId: string): Promise<void> {
    const owner = validateOwner(ownerId)
    this.#startControllers.get(owner)?.abort()
    const startWaiter = this.#startWaitersByOwner.get(owner)
    if (startWaiter) await startWaiter
    const session = this.#sessions.get(owner)
    if (session) await this.#closeSession(session)
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeAll()
    return this.#disposePromise
  }

  async #disposeAll(): Promise<void> {
    this.#disposed = true
    for (const controller of this.#startControllers.values()) controller.abort()
    while (this.#startWaiters.size > 0) await Promise.all([...this.#startWaiters])
    await Promise.all([...this.#sessions.values()].map((session) => this.#closeSession(session)))
    while (this.#pendingCleanup.size > 0) await Promise.all([...this.#pendingCleanup])
  }

  async #exclusive<T>(owner: string, signal: AbortSignal | undefined, operation: (session: ManagedSession) => Promise<T>): Promise<T> {
    const session = this.#sessions.get(owner)
    if (!session || session.closed) throw new DriverIssue('SESSION_NOT_RUNNING', 'this agent has no running browser session', false)
    const task = session.tail.then(async () => {
      if (signal?.aborted) throw new DriverIssue('CANCELLED', 'browser operation was cancelled before it began', true)
      if (session.closed || this.#sessions.get(owner) !== session) throw new DriverIssue('SESSION_CLOSED', 'browser session closed before the operation began', false)
      return operation(session)
    })
    session.tail = task.then(() => {}, () => {})
    return task
  }

  async #abortClosesSession<T>(session: ManagedSession, signal: AbortSignal | undefined, operation: Promise<T>): Promise<T> {
    return waitForAbortable(operation, signal, () => { this.#scheduleClose(session) })
  }

  async #resolveTarget(session: ManagedSession, ref: string, signal?: AbortSignal, failureRejected = true): Promise<{ target: RawSemanticCandidate; handle: ElementHandle<Element> }> {
    const observation = session.observation
    if (!observation) throw new DriverIssue('OBSERVATION_REQUIRED', 'call browser_observe and use a ref from the latest observation', failureRejected)
    if (this.#now() > observation.expiresAtMs) throw new DriverIssue('REF_EXPIRED', 'the semantic ref expired; observe again', failureRejected)
    if (session.page.url() !== observation.rawUrl) throw new DriverIssue('PAGE_CHANGED', 'the page URL changed after observation; observe again', failureRejected)
    const stored = observation.targets.get(ref)
    if (!stored) throw new DriverIssue('REF_UNKNOWN', 'the ref is not part of the latest observation', failureRejected)
    // A ref binds to the ORIGINAL node identity: the element handle captured at
    // observation time. There is deliberately no selector re-resolution here —
    // an identical twin occupying the stored selector path must never be
    // substituted for the observed node.
    const handle = stored.handle
    if (!handle) {
      throw new DriverIssue('TARGET_CHANGED', 'the observation retained no live binding for this ref; observe again', failureRejected)
    }
    const connected = await this.#abortClosesSession(session, signal, handle.evaluate((element) => element.isConnected)).catch(() => false)
    if (!connected) {
      throw new DriverIssue('TARGET_CHANGED', 'the element the ref denotes was removed from the page; observe again', failureRejected)
    }
    const bound = await inspectSemanticHandle(handle, stored.selector).catch(() => null)
    if (!bound || semanticFingerprint(bound) !== stored.fingerprint) {
      throw new DriverIssue('TARGET_CHANGED', 'the live element no longer matches the observed semantic fingerprint', failureRejected)
    }
    return { target: bound, handle }
  }

  /**
   * Capture a Playwright element handle for each emitted target, zipped by the
   * match index recorded during collection, and verify in-page that every
   * handle still denotes the node at that index. Unused handles are disposed;
   * targets whose binding cannot be verified keep no handle (the caller drops
   * them and flags the observation). Fail closed: if capture throws, no target
   * keeps a handle.
   */
  async #bindTargetHandles(session: ManagedSession, targets: StoredSemanticTarget[]): Promise<number> {
    if (targets.length === 0) return 0
    const indexes = targets.map((target) => target.matchIndex)
    const allHandles: Array<ElementHandle<SVGElement | HTMLElement>> = await session.page.$$(SEMANTIC_SELECTOR)
    try {
      const picked: Array<ElementHandle<SVGElement | HTMLElement> | null> = indexes.map((index) => index === undefined ? null : allHandles[index] ?? null)
      const used = new Set(picked.filter((handle): handle is ElementHandle<SVGElement | HTMLElement> => handle !== null))
      for (const handle of allHandles) {
        if (!used.has(handle)) void handle.dispose().catch(() => {})
      }
      const verified = await session.page.evaluate(
        ([handles, list, selector]) => {
          const all = document.querySelectorAll(selector)
          return list.map((index, k) => handles[k] != null && index !== undefined && (all[index] as Element) === (handles[k] as unknown as Element))
        },
        [picked, indexes, SEMANTIC_SELECTOR] as const,
      )
      let dropped = 0
      for (let k = 0; k < targets.length; k += 1) {
        const handle = picked[k]
        if (verified[k] === true && handle !== null && handle !== undefined) {
          targets[k]!.handle = handle
        } else {
          dropped += 1
          void handle?.dispose().catch(() => {})
        }
      }
      return dropped
    } catch {
      for (const handle of allHandles) void handle.dispose().catch(() => {})
      return targets.length
    }
  }

  async #disposeObservationHandles(observation: ObservationRecord | undefined): Promise<void> {
    if (!observation) return
    await Promise.allSettled([...observation.targets.values()].map((target) => target.handle?.dispose().catch(() => {})))
  }

  async #hitTest(handle: ElementHandle<Element>): Promise<void> {
    const visible = await handle.isVisible().catch(() => false)
    if (!visible) throw new DriverIssue('TARGET_NOT_VISIBLE', 'the live target is not visible', true)
    const hit = await handle.evaluate((element) => {
      if (!element.isConnected) return false
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2))
      const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2))
      const top = document.elementFromPoint(x, y)
      return top !== null && (top === element || element.contains(top) || top.contains(element))
    }).catch(() => false)
    if (!hit) throw new DriverIssue('TARGET_OCCLUDED', 'center-point hit-test did not resolve to the live target', true)
  }

  async #capturePng(session: ManagedSession, fullPage: boolean, width: number, height: number, scale: number): Promise<Buffer> {
    if (scale === 1) {
      return session.page.screenshot({ type: 'png', fullPage })
    }
    // Numeric scale is honored through CDP so the PNG is genuinely rendered at
    // the requested device pixel ratio, and mark frames are reported in those
    // native pixels. Playwright's own screenshot only supports 1x vs device.
    const cdp = await session.context.newCDPSession(session.page)
    try {
      const result = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        ...(fullPage ? { captureBeyondViewport: true } : {}),
        clip: { x: 0, y: 0, width, height, scale },
      })
      return Buffer.from(result.data as string, 'base64')
    } finally {
      await cdp.detach().catch(() => {})
    }
  }

  async #writeCaptureFile(session: ManagedSession, png: Buffer): Promise<string> {
    const capturesDir = join(session.userDataDir, 'captures')
    await mkdir(capturesDir, { recursive: true })
    const path = join(capturesDir, `visual-${session.epoch}-${randomUUID()}.png`)
    await writeFile(path, png)
    return path
  }

  #attachPage(session: ManagedSession, page: Page): void {
    if (session.attachedPages.has(page)) return
    session.attachedPages.add(page)
    page.setDefaultTimeout(this.#actionTimeoutMs)
    page.setDefaultNavigationTimeout(this.#actionTimeoutMs)
    page.on('console', (message) => {
      this.#pushConsole(session, message.type(), message.text(), page.url())
    })
    page.on('pageerror', (error) => {
      this.#pushConsole(session, 'pageerror', error.message, page.url())
    })
    page.on('crash', () => {
      this.#pushConsole(session, 'crash', 'page crashed', page.url())
    })
    page.on('requestfailed', (request) => {
      this.#pushNetwork(session, {
        kind: 'request-failed',
        method: request.method(),
        url: evidenceUrl(request.url()),
        resourceType: request.resourceType(),
        error: compact(request.failure()?.errorText ?? 'request failed', 300),
      })
    })
    page.on('response', (response) => {
      const request = response.request()
      const resourceType = request.resourceType()
      if (response.status() < 400 && !['document', 'xhr', 'fetch'].includes(resourceType)) return
      this.#pushNetwork(session, {
        kind: 'response',
        method: request.method(),
        url: evidenceUrl(response.url()),
        resourceType,
        status: response.status(),
      })
    })
    page.on('dialog', (dialog) => {
      this.#pushConsole(session, 'dialog-dismissed', `${dialog.type()}: ${dialog.message()}`, page.url())
      void dialog.dismiss().catch(() => {})
    })
    page.on('download', (download) => {
      this.#pushNetwork(session, {
        kind: 'download-blocked',
        method: 'GET',
        url: evidenceUrl(download.url()),
        resourceType: 'download',
        error: 'download cancelled by managed-browser policy',
      })
      void download.cancel().catch(() => {})
    })
    page.on('close', () => {
      session.readyPages.delete(page)
      if (session.page !== page) return
      const replacement = [...session.readyPages].filter((candidate) => !candidate.isClosed()).at(-1)
      if (replacement) session.page = replacement
      else if (!session.closed) this.#scheduleClose(session)
    })
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || this.#originAllowed(frame.url())) return
      this.#pushConsole(session, 'origin-policy', `blocked top-level origin: ${publicPageUrl(frame.url())}`, frame.url())
      this.#scheduleClose(session)
    })
  }

  async #installOriginPolicy(session: ManagedSession): Promise<void> {
    if (this.#allowedOrigins === undefined) return
    // Context-wide interception exists before any plugin-triggered navigation
    // or popup. Unlike per-page CDP setup, this catches a popup's very first
    // target=_blank/window.open document request before that page can become
    // the active controllable page.
    await session.context.route('**/*', async (route) => {
      const request = route.request()
      if (!request.isNavigationRequest()) {
        await route.continue().catch(() => {})
        return
      }
      let topLevel = true
      try { topLevel = request.frame().parentFrame() === null } catch { /* fail closed for detached/unknown navigation frames */ }
      if (topLevel && !this.#originAllowed(request.url())) {
        this.#pushConsole(session, 'origin-policy', `blocked top-level origin: ${publicPageUrl(request.url())}`, request.url())
        await route.abort('blockedbyclient').catch(() => {})
        this.#scheduleClose(session)
        return
      }
      await route.continue().catch(() => {})
    })
    await Promise.all(session.context.pages().map((page) => this.#installPageOriginPolicy(session, page)))
  }

  async #adoptPage(session: ManagedSession, page: Page): Promise<void> {
    try {
      if (session.closed || !this.#originAllowed(page.url())) {
        await page.close().catch(() => {})
        if (!session.closed) this.#scheduleClose(session)
        return
      }
      await this.#installPageOriginPolicy(session, page)
      if (session.closed || page.isClosed() || !this.#originAllowed(page.url())) {
        await page.close().catch(() => {})
        if (!session.closed) this.#scheduleClose(session)
        return
      }
      this.#attachPage(session, page)
      session.readyPages.add(page)
      session.page = page
    } catch {
      await page.close().catch(() => {})
      this.#scheduleClose(session)
    }
  }

  async #installPageOriginPolicy(session: ManagedSession, page: Page): Promise<void> {
    if (this.#allowedOrigins === undefined || session.policyPages.has(page) || page.isClosed()) return
    session.policyPages.add(page)
    const cdp = await session.context.newCDPSession(page)
    session.policySessions.add(cdp)
    const tree = await cdp.send('Page.getFrameTree')
    const mainFrameId = tree.frameTree.frame.id
    cdp.on('Fetch.requestPaused', (event) => {
      const isTopDocument = event.resourceType === 'Document' && event.frameId === mainFrameId
      const allowed = !isTopDocument || this.#originAllowed(event.request.url)
      if (!allowed) {
        this.#pushConsole(session, 'origin-policy', `blocked top-level origin: ${publicPageUrl(event.request.url)}`, event.request.url)
        void cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
        return
      }
      void cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {})
    })
    cdp.on('close', () => { session.policySessions.delete(cdp) })
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    })
  }

  #originAllowed(value: string): boolean {
    if (value === '' || value === 'about:blank') return true
    if (this.#allowedOrigins === undefined) return true
    try { return this.#allowedOrigins.has(new URL(value).origin) } catch { return false }
  }

  #assertAllowedUrl(value: string): void {
    if (this.#originAllowed(value)) return
    let origin = 'invalid URL'
    try { origin = new URL(value).origin } catch { /* retain generic text */ }
    throw new DriverIssue('ORIGIN_POLICY_VIOLATION', `top-level origin ${origin} is not in the operator-owned allowlist`, true)
  }

  #pushConsole(session: ManagedSession, level: string, text: string, pageUrl: string): void {
    if (session.closed) return
    session.sequence += 1
    if (session.console.length >= MAX_EVIDENCE_RING) {
      session.console.shift()
      session.consoleDropped += 1
    }
    session.console.push({
      sequence: session.sequence,
      at: iso(this.#now()),
      level: compact(level, 40),
      text: redactEvidenceText(text),
      pageUrl: publicPageUrl(pageUrl),
    })
  }

  #pushNetwork(
    session: ManagedSession,
    value: Omit<BrowserNetworkEvidence, 'sequence' | 'at'>,
  ): void {
    if (session.closed) return
    session.sequence += 1
    if (session.network.length >= MAX_EVIDENCE_RING) {
      session.network.shift()
      session.networkDropped += 1
    }
    session.network.push({ sequence: session.sequence, at: iso(this.#now()), ...value })
  }

  #touch(session: ManagedSession): void {
    if (session.closed || this.#idleTimeoutMs === 0) return
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => { this.#scheduleClose(session) }, this.#idleTimeoutMs)
    session.idleTimer.unref?.()
  }

  async #onContextClosed(session: ManagedSession): Promise<void> {
    session.closed = true
    if (session.idleTimer) clearTimeout(session.idleTimer)
    if (this.#sessions.get(session.ownerId) === session) this.#sessions.delete(session.ownerId)
    if (!session.closing) await this.#removeSessionDir(session)
  }

  async #closeSession(session: ManagedSession): Promise<void> {
    if (!session.closed) {
      session.closing = true
      session.closed = true
      if (session.idleTimer) clearTimeout(session.idleTimer)
      if (this.#sessions.get(session.ownerId) === session) this.#sessions.delete(session.ownerId)
      void this.#disposeObservationHandles(session.observation)
      session.observation = undefined
      session.readyPages.clear()
      session.secret.fill(0)
      for (const cdp of session.policySessions) await cdp.detach().catch(() => {})
      session.policySessions.clear()
      await session.context.close().catch(() => {})
      session.closing = false
    }
    await this.#removeSessionDir(session)
  }

  async #removeSessionDir(session: ManagedSession): Promise<void> {
    if (session.dirRemoval) return session.dirRemoval

    const removal = (async () => {
      let lastError: unknown
      // Chrome can release (or briefly recreate) profile files after the
      // BrowserContext close event. Treat cleanup as an owned lifecycle gate,
      // not a best-effort callback: remove, wait for filesystem quiescence,
      // verify absence, then retry the exact directory when necessary.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          await rm(session.userDataDir, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
          })
          await delay(25 * (attempt + 1))
          try {
            await access(session.userDataDir)
            lastError = new Error('browser profile directory reappeared after removal')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
            lastError = error
          }
        } catch (error) {
          lastError = error
        }
      }
      throw new Error(
        `failed to remove owned browser profile ${session.userDataDir}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      )
    })()

    session.dirRemoval = removal
    try {
      await removal
    } finally {
      // A later lifecycle path may safely retry. Never memoize a rejected
      // cleanup promise and silently convert a temporary file-lock race into a
      // permanent profile leak.
      if (session.dirRemoval === removal) session.dirRemoval = undefined
    }
  }

  #scheduleClose(session: ManagedSession): void {
    this.#trackCleanup(this.#closeSession(session))
  }

  #trackCleanup(promise: Promise<void>): void {
    let tracked: Promise<void>
    tracked = promise.finally(() => { this.#pendingCleanup.delete(tracked) })
    this.#pendingCleanup.add(tracked)
  }
}
