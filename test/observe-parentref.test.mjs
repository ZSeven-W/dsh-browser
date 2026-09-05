import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

// Contract v9 identity/ancestry pins:
//  - B1: every node carries parentRef — the ref of the nearest ANCESTOR in
//    the composed tree (light-DOM chain, through an assigned slot, crossing a
//    shadow root to its host) that is itself an emitted node in the SAME
//    observation; null when none.
//  - B2: scope.rootRef is a ref minted in THIS observation for the scope root
//    element (scope.ref keeps echoing the caller's ref). The root stays
//    resolvable through rootRef even when the visibility gate excluded it
//    from nodes.

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

async function serveFixture(t) {
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/phaseb') return res.end(fixtureHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-phaseb-parentref-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  t.after(async () => {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  })
  await manager.start('owner', { url: origin + '/phaseb' })
  return manager
}

/** Index of the node whose ref equals node.parentRef within the same view, or null. */
const parentIndexOf = (view, node) => {
  if (!('parentRef' in node)) return 'missing'
  if (node.parentRef === null) return null
  return view.nodes.findIndex((candidate) => candidate.ref === node.parentRef)
}

test('parentRef: nearest emitted composed ancestor in the same observation, null at the top', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  const manager = await serveFixture(t)

  const whole = await manager.observe('owner', { maxNodes: 100 })
  assert.equal(whole.scope, null)
  assert.ok(whole.nodes.length > 8, 'the fixture must expose its regions whole-page: ' + JSON.stringify(whole.nodes.map((node) => node.name)))
  assert.equal(whole.nodes[0].name, 'Phase B fixture', 'the h1 opens the whole-page view')

  // Structural invariants: parentRef is null at the top of the view and, for
  // every other node, names an earlier node of the SAME observation.
  for (let i = 0; i < whole.nodes.length; i += 1) {
    const node = whole.nodes[i]
    assert.ok('parentRef' in node, 'whole-page node ' + i + ' must carry parentRef: ' + JSON.stringify(node))
    const parent = parentIndexOf(whole, node)
    assert.notEqual(parent, 'missing', 'whole-page node ' + i + ' must carry parentRef')
    assert.notEqual(parent, -1, 'whole-page node ' + i + ' parentRef must resolve inside the same view')
    if (i === 0) assert.equal(node.parentRef, null, 'the first node of a whole-page view has no emitted ancestor')
    else assert.ok(parent < i, 'whole-page node ' + i + ' parentRef must point at an earlier node')
  }

  // Composed ancestry through light DOM: anchor-button's nearest emitted
  // ancestor is its region (the roleless div wrappers are not semantic).
  const anchorRegion = whole.nodes.find((node) => node.name === 'Phase B anchor region')
  const anchorButton = whole.nodes.find((node) => node.name === 'anchor-button')
  assert.ok(anchorRegion && anchorButton)
  assert.equal(anchorButton.parentRef, anchorRegion.ref, 'anchor-button must parent to its region')

  // Composed ancestry through slot assignment and a shadow root: the slotted
  // button's chain runs slot -> shadow div -> shadow root -> host -> region,
  // and the first EMITTED node on it is the region.
  const slotRegion = whole.nodes.find((node) => node.name === 'Phase B slot region')
  const slotted = whole.nodes.find((node) => node.name === 'slotted-late')
  assert.ok(slotRegion && slotted, 'the slot region and its slotted button must be in the whole-page view: ' + JSON.stringify(whole.nodes.map((node) => node.name)))
  assert.equal(slotted.parentRef, slotRegion.ref, 'slotted-late must parent to the slot region across the shadow boundary')

  // Scoped views: the root has no emitted ancestor (parentRef null), and
  // every other node parents to the root or an earlier subtree node.
  const scoped = await manager.observe('owner', { within: slotRegion.ref, maxNodes: 100 })
  assert.equal(scoped.nodes[0].name, 'Phase B slot region')
  assert.equal(scoped.nodes[0].parentRef, null, 'the scoped root has no emitted ancestor in the same observation')
  const scopedSlotted = scoped.nodes.find((node) => node.name === 'slotted-late')
  assert.ok(scopedSlotted)
  assert.equal(scopedSlotted.parentRef, scoped.nodes[0].ref, 'the slotted button must parent to the scoped root (its nearest emitted composed ancestor)')
  for (let i = 1; i < scoped.nodes.length; i += 1) {
    const parent = parentIndexOf(scoped, scoped.nodes[i])
    assert.notEqual(parent, -1, 'scoped node ' + i + ' parentRef must resolve inside the same view')
    assert.ok(parent < i, 'scoped node ' + i + ' parentRef must point at an earlier node')
  }
})

test('scope.rootRef: a fresh per-observation ref that still binds a gate-excluded root', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  const manager = await serveFixture(t)

  const whole = await manager.observe('owner', { maxNodes: 100 })
  const root = whole.nodes.find((node) => node.name === 'Phase B hidden root')
  assert.ok(root, 'the hidden-root region must be visible at load: ' + JSON.stringify(whole.nodes.map((node) => node.name)))

  const scoped = await manager.observe('owner', { within: root.ref, maxNodes: 100 })
  assert.notEqual(scoped.scope, null, 'a within observe must report a scope')
  assert.equal(typeof scoped.scope.rootRef, 'string', 'the scope must carry a fresh rootRef string')
  assert.equal(scoped.scope.ref, root.ref, 'scope.ref keeps echoing the caller ref')
  assert.equal(scoped.nodes[0].name, 'Phase B hidden root', 'the visible root is the first subtree node')
  assert.equal(scoped.nodes[0].ref, scoped.scope.rootRef, "rootRef is the root node's fresh ref in THIS observation when the root is emitted")
  assert.equal(scoped.nodes[0].parentRef, null)

  // The fixture flips the root to visibility:hidden after 4000ms. Poll by
  // re-scoping through the PREVIOUS observation's rootRef (each poll re-mints
  // it, so the chain stays alive with no intervening whole-page observe).
  let hidden = null
  let current = scoped
  for (let i = 0; i < 25; i += 1) {
    const next = await manager.observe('owner', { within: current.scope.rootRef, maxNodes: 100 })
    assert.notEqual(next.scope, null, 'a rootRef within must never fall back to a whole-page view')
    assert.equal(typeof next.scope.rootRef, 'string', 'every scoped observation must mint a fresh rootRef')
    assert.equal(next.scope.ref, current.scope.rootRef, 'scope.ref must echo the caller ref')
    current = next
    if (!current.nodes.some((node) => node.name === 'Phase B hidden root')) {
      hidden = current
      break
    }
    await delay(400)
  }
  assert.ok(hidden, 'the fixture must eventually hide the root (visibility:hidden)')

  // The gate excluded the root AND its inheriting child from nodes — but the
  // scope still binds the root through rootRef, and the hidden state is
  // honest (the root may be absent from nodes while rootRef binds it).
  assert.equal(hidden.nodes.length, 0, 'the hidden subtree must emit no nodes: ' + JSON.stringify(hidden.nodes.map((node) => node.name)))
  assert.ok(hidden.nodes.every((node) => node.ref !== hidden.scope.rootRef), 'no node may claim the hidden root ref')

  // A follow-up scoped observe through the hidden observation's rootRef must
  // still RESOLVE (not REF_UNKNOWN/TARGET_CHANGED) and keep binding the root.
  const again = await manager.observe('owner', { within: hidden.scope.rootRef, maxNodes: 100 })
  assert.notEqual(again.scope, null)
  assert.equal(typeof again.scope.rootRef, 'string')
  assert.equal(again.scope.ref, hidden.scope.rootRef)
  assert.equal(again.nodes.length, 0, 'the still-hidden root must stay out of nodes')
  assert.notEqual(again.scope.rootRef, hidden.scope.rootRef, 'rootRef must be re-minted per observation')
})
