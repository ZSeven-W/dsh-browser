import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

// Contract v9 slot assignment (B4): the collection walk follows
// HTMLSlotElement.assignedElements({ flatten: true }), so a light-DOM child
// slotted into an OPEN shadow root is emitted once, at its flattened render
// position (inside the slot, not at its light-tree position), and its
// parentRef chain crosses the slot to the host. Light children NOT assigned
// to any slot have no flattened render position and are not emitted. Where
// assignment cannot be resolved (a slot inside a closed shadow root), the
// view is marked truncated with reason slot-unresolved.

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

const fixtureHtml = await readFile(
  fileURLToPath(new URL('./fixtures/observe-phaseb.html', import.meta.url)),
  'utf8',
)

test('slotted light-DOM children emit once at their flattened render position with slot ancestry', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/phaseb') return res.end(fixtureHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-phaseb-slots-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/phaseb' })
    const whole = await manager.observe('owner', { maxNodes: 100 })
    const slotRegion = whole.nodes.find((node) => node.name === 'Phase B slot region')
    assert.ok(slotRegion, 'the slot region must be visible whole-page')

    const scoped = await manager.observe('owner', { within: slotRegion.ref, maxNodes: 100 })
    const names = scoped.nodes.map((node) => node.name)
    assert.deepEqual(
      names,
      ['Phase B slot region', 'shadow-button', 'slotted-late', 'slotted-early', 'after-host'],
      'flattened emission order: slotted light children render inside their open-shadow slots (late slot before early slot), not in light order',
    )
    const slottedLate = scoped.nodes.find((node) => node.name === 'slotted-late')
    const slottedEarly = scoped.nodes.find((node) => node.name === 'slotted-early')
    assert.ok(slottedLate && slottedEarly)
    assert.equal(
      scoped.nodes.filter((node) => node.name === 'slotted-late').length,
      1,
      'a slotted element must be emitted exactly once (its flattened render position), never at its light-tree position too',
    )
    assert.equal(
      scoped.nodes.filter((node) => node.name === 'slotted-early').length,
      1,
      'every slotted element must be emitted exactly once (its flattened render position), never at its light-tree position too',
    )
    assert.ok(!names.includes('before-slot-light'), 'an unassigned light child has no flattened render position and must not be emitted')
    assert.equal(slottedLate.parentRef, scoped.nodes[0].ref, 'the slotted element must parent to the scoped root across the slot/shadow boundary')
    assert.equal(slottedEarly.parentRef, scoped.nodes[0].ref, 'the slotted element must parent to the scoped root across the slot/shadow boundary')
    assert.equal(scoped.nodes[0].ref, scoped.scope.rootRef, 'the scoped root keeps its fresh rootRef')
    assert.equal(scoped.truncated, false, 'the slot subtree fits with no reasons: ' + JSON.stringify(scoped.truncationReasons))
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('assignment that cannot be resolved marks the view truncated with slot-unresolved', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  // A page whose slot assignment resolution fails: the page overrides
  // HTMLSlotElement.prototype.assignedElements to throw, so the driver's
  // flattened walk cannot resolve the slot's render position. The view must
  // be marked truncated with slot-unresolved instead of crashing or silently
  // dropping the slotted element.
  const slotThrowHtml = '<!doctype html><html><head><title>Slot throw fixture</title>' +
    '<style>body{margin:0}.box{display:block;width:240px;height:24px;margin:0;padding:0;box-sizing:border-box}</style></head><body>' +
    '<h1>Slot throw fixture</h1>' +
    // The region keeps its own box (40px) so the gate emits it even though
    // the host's shadow content renders nothing visible.
    '<div id="throw-region" role="region" aria-label="Throw region" style="height:40px">' +
    '<div id="throw-host"></div>' +
    '</div>' +
    '<script>' +
    'const throwHost = document.getElementById("throw-host");' +
    'const throwRoot = throwHost.attachShadow({ mode: "open" });' +
    'throwRoot.innerHTML = "<div><slot></slot></div>";' +
    'const throwLight = document.createElement("button");' +
    'throwLight.className = "box";' +
    'throwLight.textContent = "throw-slotted-button";' +
    'throwHost.appendChild(throwLight);' +
    'HTMLSlotElement.prototype.assignedElements = function () { throw new Error("assignment unavailable") };' +
    '</script>' +
    '</body></html>'
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/phaseb') return res.end(fixtureHtml)
    if (requestUrl.pathname === '/slot-throw') return res.end(slotThrowHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-phaseb-slotunresolved-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/phaseb' })

    // Closed-root slot assignment is INVISIBLE in-page (assignedSlot is null
    // there by spec): the element honestly stays at its light-tree position —
    // Phase C's CDP probe, not this walk, is what will mark such roots.
    const whole = await manager.observe('owner', { maxNodes: 100 })
    const closedRegion = whole.nodes.find((node) => node.name === 'Phase B closed region')
    assert.ok(closedRegion, 'the closed region must be visible whole-page')
    const closedScoped = await manager.observe('owner', { within: closedRegion.ref, maxNodes: 100 })
    assert.deepEqual(
      closedScoped.nodes.map((node) => node.name),
      ['Phase B closed region', 'closed-slotted-button'],
      'a closed-root slotted child keeps its light-tree position until Phase C',
    )
    assert.equal(closedScoped.truncated, false, 'no truncation marker exists for closed-root assignment in v9')
    assert.equal(closedScoped.nodes[0].ref, closedScoped.scope.rootRef, 'the region root keeps its fresh rootRef')

    // Assignment resolution that genuinely fails must truncate the view.
    await manager.act('owner', { kind: 'navigate', url: origin + '/slot-throw' })
    const throwWhole = await manager.observe('owner', { maxNodes: 100 })
    const throwRegion = throwWhole.nodes.find((node) => node.name === 'Throw region')
    assert.ok(throwRegion, 'the throw region must be visible whole-page')
    const throwScoped = await manager.observe('owner', { within: throwRegion.ref, maxNodes: 100 })
    assert.equal(throwScoped.nodes.length, 1, 'only the region root itself can be emitted: ' + JSON.stringify(throwScoped.nodes.map((node) => node.name)))
    assert.equal(throwScoped.nodes[0].name, 'Throw region')
    assert.equal(throwScoped.truncated, true, 'an unresolved assignment must truncate the view')
    assert.ok(throwScoped.truncationReasons?.includes('slot-unresolved'), 'the truncation must name slot-unresolved: ' + JSON.stringify(throwScoped.truncationReasons))
    assert.equal(throwScoped.nodes[0].ref, throwScoped.scope.rootRef, 'the region root keeps its fresh rootRef')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})
