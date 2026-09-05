import test from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  BROWSER_DRIVER_CONTRACT_VERSION,
  BROWSER_DRIVER_SERVICE,
  BROWSER_TOOL_NAMES,
  browserToolList,
  createBrowserTools,
  mountBrowser,
} from '../lib/index.js'

function fakeDriver(events = []) {
  const page = { url: 'about:blank', title: '' }
  return {
    kind: 'browser',
    contractVersion: BROWSER_DRIVER_CONTRACT_VERSION,
    async start(ownerId) {
      events.push(`start:${ownerId}`)
      return {
        ownerId, state: 'running', headless: true,
        browser: { channel: 'chrome', version: 'fixture' }, page,
        isolation: 'ephemeral-user-data',
        navigationPolicy: { mode: 'allowlist', allowedOrigins: [] },
      }
    },
    async observe(ownerId) {
      events.push(`observe:${ownerId}`)
      return {
        ownerId, epoch: 1, fingerprint: 'fingerprint', expiresAt: '2026-08-24T00:00:00.000Z',
        page: { ...page, viewport: { width: 1280, height: 800 } }, scope: null, nodes: [], truncated: false,
        limits: { maxNodes: 60, maxBytes: 49152 },
        hiddenMatches: 0, hiddenMatchesPartial: false,
        coverage: { verified: false, reason: 'skipped', closedShadowRoots: 0, probedNodes: 0 },
      }
    },
    async act(ownerId, action) {
      events.push(`act:${ownerId}:${action.kind}`)
      return {
        receiptId: 'receipt', ownerId, action: action.kind, status: 'confirmed',
        startedAt: '2026-08-24T00:00:00.000Z', completedAt: '2026-08-24T00:00:01.000Z',
        dispatched: true, pageBefore: page, pageAfter: page,
      }
    },
    async evidence(ownerId) {
      events.push(`evidence:${ownerId}`)
      return {
        ownerId, page, console: [], network: [], bounded: true,
        limits: { console: 50, network: 50 }, dropped: { console: 0, network: 0 },
      }
    },
    async stop(ownerId) { events.push(`stop:${ownerId}`); return { ownerId, stopped: true, reason: 'requested' } },
    async disposeScope(ownerId) { events.push(`scope:dispose:${ownerId}`) },
    async dispose() { events.push('manager:dispose') },
  }
}

test('raw tools use full JSON Schema, renderer ContentBlocks, and agent-owned identity', async () => {
  assert.equal(BROWSER_DRIVER_CONTRACT_VERSION, 9)
  const events = []
  const tools = browserToolList(createBrowserTools(fakeDriver(events)))
  assert.deepEqual(tools.map((tool) => tool.name), BROWSER_TOOL_NAMES)
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.equal(tool.isConcurrencySafe(), false)
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, false)
    const blocks = tool.output.render({}, { ok: true })
    assert.deepEqual(blocks, [{ type: 'text', text: '{\n  "ok": true\n}' }])
    const required = tool.parameters.required ?? []
    for (const key of required) assert.ok(Object.hasOwn(tool.parameters.properties, key))
  }
  await tools[0].execute({}, { agent: { id: 'agent-a' } })
  assert.deepEqual(events, ['start:agent-a'])
  await assert.rejects(tools[0].execute({}, {}), /exec\.agent\.id/)
})

test('Cordis mount provides driver, registers five tools, and unloads consumers before manager', async () => {
  const events = []
  const registered = []
  let provided
  let agentDisposed
  const manager = fakeDriver(events)
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
        events.push(`register:${tool.name}`)
        return () => events.push(`unregister:${tool.name}`)
      },
    },
    effect(factory) {
      const dispose = factory()
      return async () => { if (typeof dispose === 'function') await dispose() }
    },
    on(event, listener) {
      assert.equal(event, 'agent/disposed')
      agentDisposed = listener
      events.push(`on:${event}`)
      return () => events.push(`off:${event}`)
    },
    provide(name, value) {
      provided = { name, value }
      events.push(`provide:${name}`)
      return () => events.push(`unprovide:${name}`)
    },
    logger: { info() {} },
  }
  const dispose = mountBrowser(ctx, { manager })
  assert.equal(provided.name, BROWSER_DRIVER_SERVICE)
  assert.equal(provided.value, manager)
  assert.equal(provided.value.kind, 'browser')
  assert.equal(provided.value.contractVersion, BROWSER_DRIVER_CONTRACT_VERSION)
  assert.deepEqual(registered.map((tool) => tool.name), BROWSER_TOOL_NAMES)
  await agentDisposed({ agent: { id: 'agent-a' } })
  assert.ok(events.includes('scope:dispose:agent-a'))
  await agentDisposed({ agent: { id: 42 } })
  assert.equal(events.filter((event) => event.startsWith('scope:dispose:')).length, 1)
  await dispose()
  const unprovideAt = events.indexOf(`unprovide:${BROWSER_DRIVER_SERVICE}`)
  const managerAt = events.indexOf('manager:dispose')
  assert.ok(unprovideAt > events.indexOf('unregister:browser_session_start'))
  assert.ok(unprovideAt < managerAt)
  await dispose()
  assert.equal(events.filter((event) => event === 'manager:dispose').length, 1)
})

test('installed DSH ToolRuntime registers and executes every definition through schema, render, and lossless gates', async (t) => {
  const here = dirname(fileURLToPath(import.meta.url))
  const runtimePath = join(here, '..', '..', 'dsh-ios', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
  try { await access(runtimePath) } catch {
    t.skip('sibling DSH ToolRuntime is not installed in this standalone checkout')
    return
  }
  const module = await import(pathToFileURL(runtimePath).href)
  const ToolRuntime = module.default
  const definitions = new Map()
  const inserted = []
  const runtime = Object.create(ToolRuntime.prototype)
  runtime.ctx = {
    get() { return undefined },
    logger: { warn() {} },
    async waterfall(...args) { return args.at(-1)() },
    events: { dispatch() { return [] } },
  }
  runtime.defaultMode = 'native'
  runtime.maxParallelSubCalls = 10
  runtime.deferredContexts = new WeakMap()
  runtime.concludingExecutions = new WeakSet()
  runtime.cancellationStates = new WeakMap()
  runtime.contentFinalizers = new WeakMap()
  runtime.canonicalResults = new WeakMap()
  runtime.get = (name) => definitions.get(name)
  runtime.resolveExecution = (name) => definitions.get(name)
  runtime.modeFor = () => 'native'
  runtime.guardReason = () => undefined
  runtime.layers = {
    effect(_ctx, callback) {
      callback({ tools: { insert(name, definition) { inserted.push({ name, definition }); definitions.set(name, definition) } } })
      return () => { definitions.clear() }
    },
  }
  const tools = browserToolList(createBrowserTools(fakeDriver()))
  const disposers = tools.map((definition) => runtime.register(definition))
  assert.deepEqual(inserted.map((item) => item.name), BROWSER_TOOL_NAMES)
  assert.ok(disposers.every((dispose) => typeof dispose === 'function'))

  const calls = [
    ['browser_session_start', {}],
    ['browser_observe', {}],
    ['browser_act', { action: 'navigate', url: 'about:blank' }],
    ['browser_evidence', {}],
    ['browser_session_stop', {}],
  ]
  for (const [index, [name, arguments_]] of calls.entries()) {
    const result = await runtime.execute({
      callId: `call-${index}`,
      name,
      arguments: arguments_,
      signal: new AbortController().signal,
      agent: { id: 'host-agent' },
    })
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`)
    assert.equal(result.content[0].type, 'text')
    assert.deepEqual(JSON.parse(result.content[0].text), result.value)
    assert.equal(Object.isFrozen(result.value), true)
  }
})

test('browser_act maps scroll, select, and hover arguments to driver actions', async () => {
  const captured = []
  const driver = {
    kind: 'browser',
    contractVersion: BROWSER_DRIVER_CONTRACT_VERSION,
    async act(_ownerId, action) {
      captured.push(action)
      return {
        receiptId: 'r', ownerId: 'o', action: action.kind, status: 'confirmed',
        startedAt: '', completedAt: '', dispatched: true,
        pageBefore: { url: '', title: '' }, pageAfter: { url: '', title: '' },
      }
    },
  }
  const tools = createBrowserTools(driver)
  await tools.browserAct.execute({ action: 'scroll', ref: 'br_x' }, { agent: { id: 'a' } })
  await tools.browserAct.execute({ action: 'scroll', direction: 'down', amount: 'page' }, { agent: { id: 'a' } })
  await tools.browserAct.execute({ action: 'scroll', direction: 'up', amount: 120 }, { agent: { id: 'a' } })
  await tools.browserAct.execute({ action: 'select', ref: 'br_s', option: 'Blue' }, { agent: { id: 'a' } })
  await tools.browserAct.execute({ action: 'hover', ref: 'br_h' }, { agent: { id: 'a' } })
  assert.deepEqual(captured, [
    { kind: 'scroll', ref: 'br_x' },
    { kind: 'scroll', direction: 'down', amount: 'page' },
    { kind: 'scroll', direction: 'up', amount: 120 },
    { kind: 'select', ref: 'br_s', option: 'Blue' },
    { kind: 'hover', ref: 'br_h' },
  ])
  await assert.rejects(tools.browserAct.execute({ action: 'scroll' }, { agent: { id: 'a' } }), /scroll requires ref or direction/)
  await assert.rejects(tools.browserAct.execute({ action: 'select', ref: 'br_s' }, { agent: { id: 'a' } }), /select requires ref and option/)
  await assert.rejects(tools.browserAct.execute({ action: 'hover' }, { agent: { id: 'a' } }), /hover requires ref/)
})

