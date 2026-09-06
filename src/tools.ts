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
  parentRef: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  role: { type: 'string' },
  name: { type: 'string' },
  nameSource: { type: 'string', enum: ['label', 'content'] },
  tag: { type: 'string' },
  interactive: { type: 'boolean' },
  editable: { type: 'boolean' },
  disabled: { type: 'boolean' },
  inViewport: { type: 'boolean' },
  bindable: { type: 'boolean' },
  href: { type: 'string' },
  value: { type: 'string' },
  valueWithheld: { type: 'boolean', const: true },
  valueTruncated: { type: 'boolean', const: true },
}, ['ref', 'parentRef', 'role', 'name', 'nameSource', 'tag', 'interactive', 'editable', 'disabled', 'inViewport', 'bindable'])
const observationScopeSchema = closedObject({
  ref: { type: 'string' },
  rootRef: { type: 'string' },
  role: { type: 'string' },
  name: { type: 'string' },
  tag: { type: 'string' },
  nameChanged: { type: 'boolean', const: true },
}, ['ref', 'rootRef', 'role', 'name', 'tag'])
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
  scope: { oneOf: [observationScopeSchema, { type: 'null' }] },
  nodes: { type: 'array', items: semanticNodeSchema },
  hiddenMatches: { type: 'integer' },
  hiddenMatchesPartial: { type: 'boolean' },
  anchor: closedObject({
    ref: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    connected: { type: 'boolean' },
    contained: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
  }),
  coverage: closedObject({
    verified: { type: 'boolean' },
    closedShadowRoots: { type: 'integer' },
    probedNodes: { type: 'integer' },
    reason: { type: 'string', enum: ['skipped', 'over-budget', 'cdp-unavailable', 'root-unresolved', 'error'] },
  }, ['verified', 'closedShadowRoots', 'probedNodes']),
  truncated: { type: 'boolean' },
  truncationReasons: { type: 'array', items: { type: 'string' } },
  limits: closedObject({ maxNodes: { type: 'integer' }, maxBytes: { type: 'integer' } }),
}, ['ownerId', 'epoch', 'fingerprint', 'expiresAt', 'page', 'scope', 'nodes', 'hiddenMatches', 'hiddenMatchesPartial', 'coverage', 'truncated', 'limits'])
const actionReceiptSchema = closedObject({
  receiptId: { type: 'string' },
  ownerId: { type: 'string' },
  action: { type: 'string', enum: ['click', 'fill', 'press', 'navigate', 'scroll', 'select', 'hover'] },
  status: { type: 'string', enum: ['confirmed', 'unknown', 'rejected', 'failed'] },
  startedAt: { type: 'string' },
  completedAt: { type: 'string' },
  dispatched: { type: 'boolean' },
  pageBefore: pageSchema,
  pageAfter: pageSchema,
  target: closedObject({ ref: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' } }),
  observation: closedObject({ epoch: { type: 'integer' }, fingerprint: { type: 'string' } }),
  verification: closedObject({
    kind: { type: 'string', enum: ['browser-dispatch', 'value-match', 'navigation', 'option-match'] },
    detail: { type: 'string' },
  }),
  code: { type: 'string' },
  reason: { type: 'string' },
  changed: { type: 'array', items: { type: 'string' } },
  before: closedObject({
    role: { type: 'string' },
    name: { type: 'string' },
    tag: { type: 'string' },
    disabled: { type: 'boolean' },
    visible: { type: 'boolean' },
  }, []),
  after: closedObject({
    role: { type: 'string' },
    name: { type: 'string' },
    tag: { type: 'string' },
    disabled: { type: 'boolean' },
    visible: { type: 'boolean' },
  }, []),
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
  forced: { type: 'boolean', const: true },
}, ['ownerId', 'stopped', 'reason'])

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

  const browserObserve = tool<{ max_nodes?: number; within?: string; anchor_last_action?: true; verify_coverage?: true }, BrowserObservation>({
    name: 'browser_observe',
    description: 'Return a bounded semantic view of the active page main frame only: iframe content is never included (its presence sets truncated), and hidden or zero-size elements are excluded (hiddenMatches counts them; hiddenMatchesPartial marks the count a lower bound). At most 500 selector matches are scanned; whenever a visible match could not be emitted - scan window, node or byte budget, an iframe, or unresolved slot assignment - truncated is true and truncationReasons names every cause, so an absent node is never silently read as absent from the page. A within ref (from the latest browser_observe, including a scoped scope.rootRef) scopes the collection to that element\'s flattened subtree instead of the whole page: maxNodes, the byte ceiling, the scan window, and the iframe marker all become subtree-relative, so a subtree that fits reports truncated:false and absence inside it is provable; unknown, expired, consumed, non-element, or detached within refs reject instead of falling back to the whole page. Every node carries parentRef (the nearest emitted composed ancestor, null at the top), and the scope carries a fresh rootRef that keeps binding the root even when hidden. anchor_last_action verifies in-page, against the original acted handle, whether the last acted element is still connected and inside the within subtree (ANCHOR_UNAVAILABLE when none). verify_coverage runs a bounded CDP probe over the observed subtree after collection to detect closed shadow roots (content they render is invisible to the projection): coverage reports {verified, closedShadowRoots, probedNodes, reason?}; found roots push the closed-shadow-root truncation reason, an incomplete probe pushes shadow-coverage-unverified, and only coverage.verified:true lets truncated:false be read as a complete projection — use it only on the terminal absence-proof path, never on settle polls (without it coverage is {verified:false, reason:skipped} at no extra cost). Every node carries nameSource: \'label\' for authored names (aria-label/aria-labelledby/title/alt/associated label) and \'content\' for descendant-text aggregation; a content-named node with a container role (search/region/list/listbox/group/navigation/main/form/table/menu) keeps its identity when its aggregated name changes, so observe({within: its ref}) still resolves and reports scope.nameChanged:true instead of TARGET_CHANGED - act keeps the strict check. Editable controls carry a bounded value; secret-bearing fields (passwords, autocomplete secrets, CSS-masked fields) are marked valueWithheld and never exposed. Interactive nodes carry opaque refs tied to this Agent, page, observation epoch, fingerprint, and short expiry. A dispatched action invalidates the observation; after it exactly two bindings survive: the acted element (anchor_last_action) and, when the consumed observation was scoped, its scope root — observe({within: <that scope.rootRef>} or within:"last-scope") re-scopes the projection to the SAME root until the next observe, while a plain node ref from the consumed observation is refused as before (SCOPE_UNAVAILABLE names a missing or released scope root).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_nodes: { type: 'integer', description: 'Maximum semantic nodes to return (1..100, default 60).' },
        within: { type: 'string', description: 'Optional ref from the latest browser_observe (including scope.rootRef); after a dispatched action also the consumed scoped observation scope.rootRef or the literal "last-scope" alias (the retained scope root): collect semantic nodes from the flattened subtree rooted at that element (subtree-relative budgets, truncated:false when the subtree fits) instead of the whole page.' },
        anchor_last_action: { type: 'boolean', const: true, description: 'Report an anchor for the element the driver last dispatched an action on: connected, contained in the within subtree, and its fresh ref; rejects ANCHOR_UNAVAILABLE when no action target is retained.' },
        verify_coverage: { type: 'boolean', const: true, description: 'After collection, run a bounded CDP probe (5,000-node / 250ms caps) over the observed subtree to detect closed shadow roots; found roots push truncation reason closed-shadow-root, an incomplete probe pushes shadow-coverage-unverified, and only coverage.verified:true makes truncated:false provably complete. Use only on the terminal absence-proof path.' },
      },
    },
    output: outputFor(observationSchema),
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return driver.observe(ownerFromExec(exec), {
        ...(args.max_nodes === undefined ? {} : { maxNodes: args.max_nodes }),
        ...(args.within === undefined ? {} : { within: args.within }),
        ...(args.anchor_last_action === undefined ? {} : { anchorLastAction: args.anchor_last_action }),
        ...(args.verify_coverage === undefined ? {} : { verifyCoverage: args.verify_coverage }),
      }, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Observe browser semantics' }),
  })

  const browserAct = tool<{
    action: 'click' | 'fill' | 'press' | 'navigate' | 'scroll' | 'select' | 'hover'
    ref?: string
    text?: string
    key?: string
    url?: string
    direction?: 'up' | 'down'
    amount?: 'page' | number
    option?: string
  }, BrowserActionReceipt>({
    name: 'browser_act',
    description: 'Perform exactly one browser action. click/fill/press/scroll(ref)/select/hover require a ref from the latest browser_observe; the driver acts on the original observed DOM node and re-verifies its identity (removal or replacement rejects, never a silent click on a lookalike), then hit-tests it (scroll resolves without a hit-test so it can reach off-viewport targets; an off-viewport click rejects TARGET_OFF_VIEWPORT). A TARGET_CHANGED refusal carries `changed` (the identity fields that differ, e.g. [\'name\'] or [\'visible\'] when the target became display:none, [\'detached\'] when it was removed) plus `before`/`after` snapshots for the safe subset (role, name, tag, disabled, visible) — never any value. scroll(direction) pages the viewport without a ref. select fires real input/change events and matches an option by accessible label first and exact value second, failing (not guessing) when ambiguous or missing. Every dispatched action invalidates the observation, so observe again after acting. Deterministic policy rejects destructive, financial, publish/send, credential, file-upload, and download semantics. Every call returns a confirmed/unknown/rejected/failed receipt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['click', 'fill', 'press', 'navigate', 'scroll', 'select', 'hover'] },
        ref: { type: 'string', description: 'Opaque ref required for click, fill, press, scroll(ref), select, and hover.' },
        text: { type: 'string', description: 'Text required for fill; never echoed in receipts.' },
        key: { type: 'string', description: 'Playwright key name/chord required for press.' },
        url: { type: 'string', description: 'Absolute http(s) URL required for navigate.' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Direction for a ref-less viewport scroll.' },
        amount: { description: 'Scroll amount for a direction scroll: "page" (one viewport height) or a non-negative pixel count. Defaults to "page".', oneOf: [{ type: 'string', const: 'page' }, { type: 'number', minimum: 0 }] },
        option: { type: 'string', description: 'Option label or value required for select; matched by label first, then value.' },
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
      } else if (args.action === 'scroll') {
        if (args.ref !== undefined) {
          action = { kind: 'scroll', ref: args.ref }
        } else if (args.direction !== undefined) {
          action = { kind: 'scroll', direction: args.direction, ...(args.amount === undefined ? {} : { amount: args.amount }) }
        } else {
          throw new Error('browser_act scroll requires ref or direction')
        }
      } else if (args.action === 'select') {
        if (args.ref === undefined || args.option === undefined) throw new Error('browser_act select requires ref and option')
        action = { kind: 'select', ref: args.ref, option: args.option }
      } else if (args.action === 'hover') {
        if (args.ref === undefined) throw new Error('browser_act hover requires ref')
        action = { kind: 'hover', ref: args.ref }
      } else {
        throw new Error('browser_act action must be click, fill, press, navigate, scroll, select, or hover')
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
