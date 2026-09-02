import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BROWSER_DRIVER_CONTRACT_VERSION, browserToolList, createBrowserTools } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))

function fakeDriver() {
  const page = { url: 'about:blank', title: '' }
  return {
    kind: 'browser',
    contractVersion: BROWSER_DRIVER_CONTRACT_VERSION,
    async start(ownerId) {
      return { ownerId, state: 'running', headless: true, browser: { channel: 'chrome', version: 'fixture' }, page, isolation: 'ephemeral-user-data', navigationPolicy: { mode: 'allowlist', allowedOrigins: [] } }
    },
    async observe(ownerId) {
      return { ownerId, epoch: 1, fingerprint: 'fp', expiresAt: '2026-08-24T00:00:00.000Z', page: { ...page, viewport: { width: 1280, height: 800 } }, nodes: [], truncated: false, limits: { maxNodes: 60, maxBytes: 49152 } }
    },
    async act(ownerId, action) {
      return { receiptId: 'r', ownerId, action: action.kind, status: 'confirmed', startedAt: '', completedAt: '', dispatched: true, pageBefore: page, pageAfter: page }
    },
    async evidence(ownerId) {
      return { ownerId, page, console: [], network: [], bounded: true, limits: { console: 50, network: 50 }, dropped: { console: 0, network: 0 } }
    },
    async stop(ownerId) { return { ownerId, stopped: true, reason: 'requested' } },
    async disposeScope() {},
    async dispose() {},
  }
}

test('README contract-version mentions are pinned to the exported constant', async () => {
  const english = await readFile(join(here, '..', 'README.md'), 'utf8')
  const chinese = await readFile(join(here, '..', 'README.zh.md'), 'utf8')
  for (const [label, text] of [['README.md', english], ['README.zh.md', chinese]]) {
    assert.ok(
      text.includes(`BROWSER_DRIVER_CONTRACT_VERSION, // ${BROWSER_DRIVER_CONTRACT_VERSION}`),
      `${label} must show the imported constant (currently ${BROWSER_DRIVER_CONTRACT_VERSION})`,
    )
    assert.ok(
      text.includes(`contractVersion: ${BROWSER_DRIVER_CONTRACT_VERSION}`),
      `${label} must advertise the current contractVersion (${BROWSER_DRIVER_CONTRACT_VERSION})`,
    )
  }
})

test('tool descriptions are long enough and observe/act descriptions state the real semantics', () => {
  const tools = browserToolList(createBrowserTools(fakeDriver()))
  for (const tool of tools) {
    assert.ok(tool.description.length >= 80, `${tool.name} description is only ${tool.description.length} chars`)
  }
  const observe = tools.find((tool) => tool.name === 'browser_observe')
  assert.ok(observe.description.includes('truncated'), 'browser_observe must explain truncated semantics: ' + observe.description)
  assert.ok(observe.description.includes('main frame'), 'browser_observe must state the main-frame-only projection: ' + observe.description)
  assert.ok(observe.description.includes('valueWithheld'), 'browser_observe must explain value/valueWithheld semantics: ' + observe.description)
  const act = tools.find((tool) => tool.name === 'browser_act')
  assert.ok(act.description.includes('dispatched action invalidates'), 'only dispatched actions invalidate the observation: ' + act.description)
  assert.equal(act.description.includes('Every action invalidates'), false, 'the false "every action invalidates" claim must be gone')
})

test('README no longer claims cookie borrowing is impossible', async () => {
  const english = await readFile(join(here, '..', 'README.md'), 'utf8')
  const chinese = await readFile(join(here, '..', 'README.zh.md'), 'utf8')
  assert.equal(english.includes('No existing-profile, cookie, extension'), false, 'README.md must not claim cookies are never borrowed')
  assert.equal(chinese.includes('不读取现有 Profile、Cookie'), false, 'README.zh.md must not claim cookies are never borrowed')
  assert.ok(english.includes('storageState'), 'README.md must document the storageState injection path')
  assert.ok(chinese.includes('storageState'), 'README.zh.md must document the storageState injection path')
})
