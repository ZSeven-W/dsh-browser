import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

// Contract v9 scoped-proof retention (QA-BL-068): when the observation
// consumed by a dispatched action was scoped, the driver retains its scope
// root per session, so observe({ within: <that observation's scope.rootRef> })
// — or the literal alias within: 'last-scope' — resolves through the retained
// handle after the action and BEFORE the next observe. A plain node ref from
// the consumed observation keeps today's refusal; a missing or released
// retention (navigation, next observe) refuses with the distinct
// SCOPE_UNAVAILABLE. Works together with anchorLastAction.

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

const fixtureHtml = await readFile(
  fileURLToPath(new URL('./fixtures/observe-scoped.html', import.meta.url)),
  'utf8',
)

// Rejection code of a promise that must REJECT with a DriverIssue-shaped error.
async function rejectedCode(promise) {
  try {
    await promise
  } catch (error) {
    return error && typeof error.code === 'string' ? error.code : String(error)
  }
  return null
}

// Reach the deep container the way a caller must: whole-page observe (the
// container is beyond its window), then scope to the main region, whose first
// 100 nodes are main + 98 probes + the container.
async function reachContainer(manager) {
  const whole = await manager.observe('owner', { maxNodes: 100 })
  const anchor = whole.nodes.find((node) => node.name === 'Scope anchor region')
  assert.ok(anchor, 'the scope anchor must be inside the whole-page 100-node window')
  const narrow = await manager.observe('owner', { within: anchor.ref, maxNodes: 100 })
  const container = narrow.nodes.find((node) => node.name === 'Deep container')
  assert.ok(container, 'the narrow observation must include the container: ' + JSON.stringify(narrow.nodes.map((node) => node.name).slice(-4)))
  return { container }
}

test('scoped proof after an action: the consumed scope.rootRef resolves within, anchored, until the next observe', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/scoped') return res.end(fixtureHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-scope-retention-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/scoped' })
    const { container } = await reachContainer(manager)
    const scoped = await manager.observe('owner', { within: container.ref, maxNodes: 40 })
    const deep = scoped.nodes.find((node) => node.name === 'Deep scoped target')
    assert.ok(deep, 'the scoped observe must return the deep target')
    assert.equal(deep.inViewport, false)
    const rootRef = scoped.scope.rootRef

    const receipt = await manager.act('owner', { kind: 'scroll', ref: deep.ref })
    assert.equal(receipt.status, 'confirmed', JSON.stringify(receipt))

    // A plain node ref from the consumed observation keeps today's refusal:
    // it is the observation's node ref, not its retained scope root.
    const plainCode = await rejectedCode(manager.observe('owner', { within: deep.ref }))
    assert.equal(plainCode, 'OBSERVATION_REQUIRED', 'a plain node ref must still be refused after the action: ' + plainCode)

    // The scope root SURVIVES the action: the same flow that today throws
    // OBSERVATION_REQUIRED must return a fresh scoped view of the SAME root.
    const proof = await manager.observe('owner', { within: rootRef, anchorLastAction: true, maxNodes: 40 })
    assert.ok(proof.scope, 'the post-action within must produce a scoped view, never a whole-page fallback')
    assert.equal(proof.scope.ref, rootRef, 'scope.ref echoes the within ref the caller passed')
    assert.notEqual(proof.scope.rootRef, rootRef, 'scope.rootRef must be freshly minted in THIS observation')
    assert.equal(proof.scope.name, 'Deep container')
    assert.equal(proof.scope.role, 'region')
    const proofDeep = proof.nodes.find((node) => node.name === 'Deep scoped target')
    assert.ok(proofDeep, 'the acted node must be present in the scoped proof view')
    assert.equal(proofDeep.inViewport, true, 'the scrolled target must be in the viewport')
    assert.equal(proof.truncated, false, 'the container subtree must still fit')
    assert.deepEqual(
      proof.anchor,
      { ref: proofDeep.ref, connected: true, contained: true },
      'the anchor must bind the acted element inside the retained scope root',
    )

    // The successful observation consumed the retention: the old rootRef is an
    // ordinary unknown ref again, and the alias names nothing.
    const staleRootCode = await rejectedCode(manager.observe('owner', { within: rootRef }))
    assert.equal(staleRootCode, 'REF_UNKNOWN', 'a consumed rootRef must refuse as today: ' + staleRootCode)
    const staleAliasCode = await rejectedCode(manager.observe('owner', { within: 'last-scope' }))
    assert.equal(staleAliasCode, 'SCOPE_UNAVAILABLE', 'the alias must refuse once the retention is released: ' + staleAliasCode)
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('last-scope alias resolves the retained root; navigation and release refuse SCOPE_UNAVAILABLE', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/scoped') return res.end(fixtureHtml)
    if (requestUrl.pathname === '/other') return res.end('<h1>Other</h1>')
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-scope-alias-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/scoped' })
    await manager.observe('owner')

    // No scoped action yet: the alias names nothing.
    const noneCode = await rejectedCode(manager.observe('owner', { within: 'last-scope' }))
    assert.equal(noneCode, 'SCOPE_UNAVAILABLE', 'last-scope without a retained scope root must refuse: ' + noneCode)

    // Alias flow: dispatch the scroll from a scoped observation, then re-scope
    // through the literal alias and prove the acted node inside the SAME root.
    const { container } = await reachContainer(manager)
    const scoped = await manager.observe('owner', { within: container.ref, maxNodes: 40 })
    const deep = scoped.nodes.find((node) => node.name === 'Deep scoped target')
    assert.ok(deep)
    const receipt = await manager.act('owner', { kind: 'scroll', ref: deep.ref })
    assert.equal(receipt.status, 'confirmed', JSON.stringify(receipt))
    const aliased = await manager.observe('owner', { within: 'last-scope', maxNodes: 40 })
    assert.ok(aliased.scope, 'the alias must produce a scoped view, never a whole-page fallback')
    assert.equal(aliased.scope.ref, 'last-scope', 'scope.ref echoes the literal alias')
    assert.equal(aliased.scope.name, 'Deep container')
    const aliasedDeep = aliased.nodes.find((node) => node.name === 'Deep scoped target')
    assert.ok(aliasedDeep, 'the acted node must be present through the alias')
    assert.equal(aliasedDeep.inViewport, true)

    // Navigation flow: retain a root with a scroll action, then navigate away.
    // The binding dies with the document; the ref and the alias must refuse
    // with the distinct SCOPE_UNAVAILABLE, never a whole-page fallback.
    const reached = await reachContainer(manager)
    const scoped2 = await manager.observe('owner', { within: reached.container.ref, maxNodes: 40 })
    const deep2 = scoped2.nodes.find((node) => node.name === 'Deep scoped target')
    assert.ok(deep2)
    const rootRef2 = scoped2.scope.rootRef
    const receipt2 = await manager.act('owner', { kind: 'scroll', ref: deep2.ref })
    assert.equal(receipt2.status, 'confirmed', JSON.stringify(receipt2))
    const nav = await manager.act('owner', { kind: 'navigate', url: origin + '/other' })
    assert.equal(nav.status, 'confirmed', JSON.stringify(nav))
    const navRootCode = await rejectedCode(manager.observe('owner', { within: rootRef2 }))
    assert.equal(navRootCode, 'SCOPE_UNAVAILABLE', 'a retained rootRef must refuse after navigation: ' + navRootCode)
    const navAliasCode = await rejectedCode(manager.observe('owner', { within: 'last-scope' }))
    assert.equal(navAliasCode, 'SCOPE_UNAVAILABLE', 'the alias must refuse after navigation: ' + navAliasCode)

    // The session stays healthy: a plain whole-page observe still works.
    const other = await manager.observe('owner')
    assert.ok(other.nodes.some((node) => node.tag === 'h1'), 'the session must still observe normally after all refusals')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})
