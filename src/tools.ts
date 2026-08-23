import type {
  BrowserAction,
  BrowserActionReceipt,
  BrowserEvidence,
  BrowserObservation,
  BrowserSessionInfo,
  BrowserSessionStopResult,
  ZSevenBrowserDriver,
} from './driver-contract.js'

export const BROWSER_TOOL_NAMES = [
  'browser_session_start',
  'browser_observe',
  'browser_act',
  'browser_evidence',
  'browser_session_stop',
] as const

export interface ToolExecutionContext {
  signal?: AbortSignal
  agent?: { id?: unknown }
}

export interface StructuralToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  timeoutMs: number
  isConcurrencySafe: () => boolean
  execute: (args: never, exec: ToolExecutionContext) => Promise<unknown>
  presentCall: () => { card: 'generic'; title: string }
}

export interface BrowserTools {
  browserSessionStart: StructuralToolDefinition
  browserObserve: StructuralToolDefinition
  browserAct: StructuralToolDefinition
  browserEvidence: StructuralToolDefinition
  browserSessionStop: StructuralToolDefinition
}

const renderJson = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

const closedObject = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
})
const pageSchema = closedObject({ url: { type: 'string' }, title: { type: 'string' } })
const sessionInfoSchema = closedObject({
  ownerId: { type: 'string' },
  state: { type: 'string', const: 'running' },
  headless: { type: 'boolean' },
  browser: closedObject({
    channel: { type: 'string', enum: ['chrome', 'edge', 'chromium', 'custom'] },
    version: { type: 'string' },
  }),
  page: pageSchema,
  isolation: { type: 'string', const: 'ephemeral-user-data' },
  navigationPolicy: closedObject({
    mode: { type: 'string', enum: ['unrestricted', 'allowlist'] },
    allowedOrigins: { type: 'array', items: { type: 'string' } },
  }),
})
const semanticNodeSchema = closedObject({
  ref: { type: 'string' },
  role: { type: 'string' },
  name: { type: 'string' },
  tag: { type: 'string' },
  interactive: { type: 'boolean' },
  editable: { type: 'boolean' },
  disabled: { type: 'boolean' },
  href: { type: 'string' },
}, ['ref', 'role', 'name', 'tag', 'interactive', 'editable', 'disabled'])
const observationSchema = closedObject({
  ownerId: { type: 'string' },
  epoch: { type: 'integer' },
  fingerprint: { type: 'string' },
  expiresAt: { type: 'string' },
  page: closedObject({
    url: { type: 'string' },
    title: { type: 'string' },
    viewport: closedObject({ width: { type: 'integer' }, height: { type: 'integer' } }),
  }),
  nodes: { type: 'array', items: semanticNodeSchema },
  truncated: { type: 'boolean' },
  limits: closedObject({ maxNodes: { type: 'integer' }, maxBytes: { type: 'integer' } }),
})
const actionReceiptSchema = closedObject({
  receiptId: { type: 'string' },
  ownerId: { type: 'string' },
  action: { type: 'string', enum: ['click', 'fill', 'press', 'navigate'] },
  status: { type: 'string', enum: ['confirmed', 'unknown', 'rejected', 'failed'] },
  startedAt: { type: 'string' },
  completedAt: { type: 'string' },
  dispatched: { type: 'boolean' },
  pageBefore: pageSchema,
  pageAfter: pageSchema,
  target: closedObject({ ref: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' } }),
  observation: closedObject({ epoch: { type: 'integer' }, fingerprint: { type: 'string' } }),
  verification: closedObject({
    kind: { type: 'string', enum: ['browser-dispatch', 'value-match', 'navigation'] },
    detail: { type: 'string' },
  }),
  code: { type: 'string' },
  reason: { type: 'string' },
}, [
  'receiptId', 'ownerId', 'action', 'status', 'startedAt', 'completedAt',
  'dispatched', 'pageBefore', 'pageAfter',
])
const consoleEvidenceSchema = closedObject({
  sequence: { type: 'integer' }, at: { type: 'string' }, level: { type: 'string' },
  text: { type: 'string' }, pageUrl: { type: 'string' },
})
const networkEvidenceSchema = closedObject({
  sequence: { type: 'integer' },
  at: { type: 'string' },
  kind: { type: 'string', enum: ['response', 'request-failed', 'download-blocked'] },
  method: { type: 'string' },
  url: { type: 'string' },
  resourceType: { type: 'string' },
  status: { type: 'integer' },
  error: { type: 'string' },
}, ['sequence', 'at', 'kind', 'method', 'url', 'resourceType'])
const evidenceSchema = closedObject({
  ownerId: { type: 'string' },
  page: pageSchema,
  console: { type: 'array', items: consoleEvidenceSchema },
  network: { type: 'array', items: networkEvidenceSchema },
  bounded: { type: 'boolean', const: true },
  limits: closedObject({ console: { type: 'integer' }, network: { type: 'integer' } }),
  dropped: closedObject({ console: { type: 'integer' }, network: { type: 'integer' } }),
})
const stopSchema = closedObject({
  ownerId: { type: 'string' },
  stopped: { type: 'boolean' },
  reason: { type: 'string', enum: ['requested', 'not-running'] },
})

const outputFor = (schema: Record<string, unknown>) => ({ schema, render: renderJson })

function ownerFromExec(exec: ToolExecutionContext): string {
  const raw = exec.agent?.id
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('browser tools require exec.agent.id; anonymous sessions are never shared')
  }
  return String(raw)
}

function tool<TArgs, TResult>(spec: Omit<StructuralToolDefinition, 'execute'> & {
  execute: (args: TArgs, exec: ToolExecutionContext) => Promise<TResult>
}): StructuralToolDefinition {
  return spec as unknown as StructuralToolDefinition
}

/** Five-tool model surface backed by the exported QA driver service. */
export function createBrowserTools(driver: ZSevenBrowserDriver): BrowserTools {
  const browserSessionStart = tool<{ url?: string; headless?: boolean }, BrowserSessionInfo>({
    name: 'browser_session_start',
    description: 'Start one isolated managed Chrome/Edge/Chromium session for this Agent. The profile is temporary and deleted on stop. Headless defaults to true. This does not attach to an existing personal browser profile.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Optional absolute http(s) URL. Omit for about:blank.' },
        headless: { type: 'boolean', description: 'Run without a visible browser window (default true).' },
      },
    },
    output: outputFor(sessionInfoSchema),
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return driver.start(ownerFromExec(exec), {
        ...(args.url === undefined ? {} : { url: args.url }),
        ...(args.headless === undefined ? {} : { headless: args.headless }),
      }, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Start managed browser' }),
  })

  const browserObserve = tool<{ max_nodes?: number }, BrowserObservation>({
    name: 'browser_observe',
    description: 'Return a bounded semantic view of the active page. Interactive nodes carry opaque refs tied to this Agent, page, observation epoch, fingerprint, and short expiry. Observe again after every action.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_nodes: { type: 'integer', description: 'Maximum semantic nodes to return (1..100, default 60).' },
      },
    },
    output: outputFor(observationSchema),
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return driver.observe(ownerFromExec(exec), {
        ...(args.max_nodes === undefined ? {} : { maxNodes: args.max_nodes }),
      }, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Observe browser semantics' }),
  })

  const browserAct = tool<{
    action: 'click' | 'fill' | 'press' | 'navigate'
    ref?: string
    text?: string
    key?: string
    url?: string
  }, BrowserActionReceipt>({
    name: 'browser_act',
    description: 'Perform exactly one browser action. click/fill/press require a ref from the latest browser_observe; the driver live re-resolves and hit-tests it. Deterministic policy rejects destructive, financial, publish/send, credential, file-upload, and download semantics. Every call returns a confirmed/unknown/rejected/failed receipt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['click', 'fill', 'press', 'navigate'] },
        ref: { type: 'string', description: 'Opaque ref required for click, fill, and press.' },
        text: { type: 'string', description: 'Text required for fill; never echoed in receipts.' },
        key: { type: 'string', description: 'Playwright key name/chord required for press.' },
        url: { type: 'string', description: 'Absolute http(s) URL required for navigate.' },
      },
    },
    output: outputFor(actionReceiptSchema),
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      let action: BrowserAction
      if (args.action === 'click') {
        if (args.ref === undefined) throw new Error('browser_act click requires ref')
        action = { kind: 'click', ref: args.ref }
      } else if (args.action === 'fill') {
        if (args.ref === undefined || args.text === undefined) throw new Error('browser_act fill requires ref and text')
        action = { kind: 'fill', ref: args.ref, text: args.text }
      } else if (args.action === 'press') {
        if (args.ref === undefined || args.key === undefined) throw new Error('browser_act press requires ref and key')
        action = { kind: 'press', ref: args.ref, key: args.key }
      } else if (args.action === 'navigate') {
        if (args.url === undefined) throw new Error('browser_act navigate requires url')
        action = { kind: 'navigate', url: args.url }
      } else {
        throw new Error('browser_act action must be click, fill, press, or navigate')
      }
      return driver.act(ownerFromExec(exec), action, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Act in managed browser' }),
  })

  const browserEvidence = tool<{ max_console?: number; max_network?: number }, BrowserEvidence>({
    name: 'browser_evidence',
    description: 'Read bounded, redacted console and network evidence for this Agent session. Network records contain metadata only—no headers or bodies—and URLs omit credentials, query strings, and fragments.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_console: { type: 'integer', description: 'Latest console records to return (1..100, default 50).' },
        max_network: { type: 'integer', description: 'Latest network records to return (1..100, default 50).' },
      },
    },
    output: outputFor(evidenceSchema),
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return driver.evidence(ownerFromExec(exec), {
        ...(args.max_console === undefined ? {} : { maxConsole: args.max_console }),
        ...(args.max_network === undefined ? {} : { maxNetwork: args.max_network }),
      }, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Collect browser evidence' }),
  })

  const browserSessionStop = tool<Record<string, never>, BrowserSessionStopResult>({
    name: 'browser_session_stop',
    description: 'Close this Agent browser context, terminate its managed browser process when unused, zero its ref secret, and delete its exact temporary user-data directory. Idempotent when no session is running.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: outputFor(stopSchema),
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      return driver.stop(ownerFromExec(exec))
    },
    presentCall: () => ({ card: 'generic', title: 'Stop managed browser' }),
  })

  return { browserSessionStart, browserObserve, browserAct, browserEvidence, browserSessionStop }
}

export function browserToolList(tools: BrowserTools): StructuralToolDefinition[] {
  return [
    tools.browserSessionStart,
    tools.browserObserve,
    tools.browserAct,
    tools.browserEvidence,
    tools.browserSessionStop,
  ]
}
