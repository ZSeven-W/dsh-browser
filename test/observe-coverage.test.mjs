import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

// Phase C verified boundaries (contract v9, additive): observe({ verifyCoverage:
// true }) runs a bounded CDP probe over the observed subtree (the within
// root's subtree, or the whole document) and reports per-observation coverage
// evidence. Closed shadow roots are invisible in-page (Element.shadowRoot is
// null for them), so content they render is missing from the projection; the
// probe detects them among ALL element descendants — non-semantic hosts
// included — and the observation then carries:
//   coverage: { verified, closedShadowRoots, probedNodes, reason? }
//   closedShadowRoots > 0        -> truncation reason closed-shadow-root
//   probe skipped/failed/over-budget -> reason shadow-coverage-unverified
// Only coverage.verified === true lets a consumer read truncated:false as
// "every semantic node of the subtree is in the projection". Without
// verifyCoverage the observation carries coverage {verified:false,
// reason:'skipped', closedShadowRoots:0, probedNodes:0} and NO extra
// truncation reason — ordinary polls are unchanged in cost and semantics.

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

const fixtureHtml = await readFile(
  fileURLToPath(new URL('./fixtures/observe-phasec.html', import.meta.url)),
  'utf8',
)

// A small page with no shadow roots at all: a whole-page verifyCoverage probe
// must complete and report verified with zero closed roots.
const cleanHtml = '<!doctype html><html><head><title>Clean coverage fixture</title>' +
  '<style>body{margin:0}.box{display:block;width:240px;height:24px;margin:0;padding:0;box-sizing:border-box}</style></head><body>' +
  '<h1>Clean coverage fixture</h1>' +
  '<button class="box">clean-button</button>' +
  '<div role="region" aria-label="Clean region"><button class="box">clean-region-button</button></div>' +
  '</body></html>'

// A synthetic page whose document far exceeds the probe node cap (5,000 DOM
// nodes): every probe — whole-page and scoped alike — must report over-budget
// honestly instead of claiming verified.
const hugeHtml = '<!doctype html><html><head><title>Huge coverage fixture</title>' +
  '<style>body{margin:0}.box{display:block;width:240px;height:10px;margin:0;padding:0;box-sizing:border-box}</style></head><body>' +
  '<h1>Huge coverage fixture</h1>' +
  Array.from({ length: 7000 }, (_, i) => '<button class="box" data-i="' + i + '">huge-' + i + '</button>').join('') +
  '</body></html>'

// Every public node field except the observation-specific ref/parentRef (both
// re-minted per observation; the probe must change NOTHING else).
const nodeFields = (node) => {
  const { ref, parentRef, ...fields } = node
  return fields
}

const assertSameNodes = (a, b, label) => {
  assert.equal(a.nodes.length, b.nodes.length, label + ': node count must be untouched by the probe')
  for (let i = 0; i < a.nodes.length; i += 1) {
    assert.deepEqual(
      nodeFields(a.nodes[i]),
      nodeFields(b.nodes[i]),
      label + ': index ' + i + ' must be field-identical with and without the probe: ' +
        JSON.stringify(a.nodes[i]) + ' vs ' + JSON.stringify(b.nodes[i]),
    )
  }
}

test('verifyCoverage probes the observed subtree: imperative and declarative closed roots are detected, nested-in-open roots are found, a clean subtree verifies', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/phasec') return res.end(fixtureHtml)
    if (requestUrl.pathname === '/clean') return res.end(cleanHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-phasec-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/phasec' })

    // Without verifyCoverage every observation carries the skipped marker and
    // NO extra truncation reason: ordinary polls are unchanged.
    const whole = await manager.observe('owner', { maxNodes: 100 })
    assert.deepEqual(
      whole.coverage,
      { verified: false, reason: 'skipped', closedShadowRoots: 0, probedNodes: 0 },
      'an ordinary observe must carry coverage {verified:false, reason:skipped}',
    )
    assert.ok(!whole.truncationReasons?.includes('closed-shadow-root'), 'no probe, no closed-shadow-root reason')
    assert.ok(!whole.truncationReasons?.includes('shadow-coverage-unverified'), 'no probe, no shadow-coverage-unverified reason')

    // Every scoped observe consumes the observation that minted its within
    // ref, so each region is re-chained from a fresh whole-page view.
    const freshRegion = async (name) => {
      const view = await manager.observe('owner', { maxNodes: 100 })
      const node = view.nodes.find((candidate) => candidate.name === name)
      assert.ok(node, 'the region must be within the whole-page window: ' + name)
      return node
    }

    // Region (a): imperative closed root. The in-page projection misses
    // closed-imperative-button; without the probe the scoped view looks
    // complete. With it, the closed root is counted and named.
    const imperativeRegion = await freshRegion('Imperative closed region')
    const imperativePlain = await manager.observe('owner', { within: imperativeRegion.ref, maxNodes: 100 })
    assert.ok(imperativePlain.nodes.some((node) => node.name === 'imperative-light-button'))
    assert.ok(!imperativePlain.nodes.some((node) => node.name === 'closed-imperative-button'), 'closed-root content is invisible in-page')
    assert.equal(imperativePlain.truncated, false, 'without the probe the subtree falsely reports complete')
    assert.deepEqual(imperativePlain.coverage, { verified: false, reason: 'skipped', closedShadowRoots: 0, probedNodes: 0 })

    const imperativeRegionChecked = await freshRegion('Imperative closed region')
    const imperativeChecked = await manager.observe('owner', { within: imperativeRegionChecked.ref, verifyCoverage: true, maxNodes: 100 })
    assert.equal(imperativeChecked.coverage.verified, false)
    assert.equal(imperativeChecked.coverage.reason, undefined, 'a completed probe that found a root names the count, not a failure reason')
    assert.ok(imperativeChecked.coverage.closedShadowRoots >= 1, JSON.stringify(imperativeChecked.coverage))
    assert.ok(imperativeChecked.coverage.probedNodes >= 2, JSON.stringify(imperativeChecked.coverage))
    assert.equal(imperativeChecked.truncated, true, 'closed root content is missing from the projection')
    assert.ok(imperativeChecked.truncationReasons?.includes('closed-shadow-root'), JSON.stringify(imperativeChecked.truncationReasons))
    assert.ok(!imperativeChecked.truncationReasons?.includes('shadow-coverage-unverified'), 'a completed probe is not unverified: ' + JSON.stringify(imperativeChecked.truncationReasons))
    assertSameNodes(imperativePlain, imperativeChecked, 'imperative region')

    // Region (b): declarative <template shadowrootmode="closed">.
    const declarativeRegion = await freshRegion('Declarative closed region')
    const declarativePlain = await manager.observe('owner', { within: declarativeRegion.ref, maxNodes: 100 })
    assert.ok(!declarativePlain.nodes.some((node) => node.name === 'closed-declarative-button'), 'declarative closed content is invisible in-page')
    assert.equal(declarativePlain.truncated, false)
    const declarativeRegionChecked = await freshRegion('Declarative closed region')
    const declarativeChecked = await manager.observe('owner', { within: declarativeRegionChecked.ref, verifyCoverage: true, maxNodes: 100 })
    assert.equal(declarativeChecked.coverage.verified, false)
    assert.ok(declarativeChecked.coverage.closedShadowRoots >= 1, 'the declarative closed root must be detected: ' + JSON.stringify(declarativeChecked.coverage))
    assert.equal(declarativeChecked.truncated, true)
    assert.ok(declarativeChecked.truncationReasons?.includes('closed-shadow-root'), JSON.stringify(declarativeChecked.truncationReasons))
    assertSameNodes(declarativePlain, declarativeChecked, 'declarative region')

    // A closed root nested INSIDE an open root must be found too: the walk
    // pierces the open root (open-pierced-button is emitted) and the probe
    // still detects the inner closed root the projection misses.
    const nestedRegion = await freshRegion('Nested open region')
    const nestedChecked = await manager.observe('owner', { within: nestedRegion.ref, verifyCoverage: true, maxNodes: 100 })
    assert.ok(nestedChecked.nodes.some((node) => node.name === 'open-pierced-button'), 'open roots stay pierced in the projection')
    assert.ok(!nestedChecked.nodes.some((node) => node.name === 'nested-closed-button'), 'the inner closed content stays invisible in-page')
    assert.equal(nestedChecked.coverage.verified, false)
    assert.ok(nestedChecked.coverage.closedShadowRoots >= 1, 'a closed root inside an open root must be detected: ' + JSON.stringify(nestedChecked.coverage))
    assert.equal(nestedChecked.truncated, true)
    assert.ok(nestedChecked.truncationReasons?.includes('closed-shadow-root'), JSON.stringify(nestedChecked.truncationReasons))

    // Region (c): no shadow roots. The probe completes and verifies: only then
    // may truncated:false be read as "every semantic node is in the projection".
    const cleanRegion = await freshRegion('Clean region')
    const cleanPlain = await manager.observe('owner', { within: cleanRegion.ref, maxNodes: 100 })
    assert.equal(cleanPlain.truncated, false)
    const cleanRegionChecked = await freshRegion('Clean region')
    const cleanChecked = await manager.observe('owner', { within: cleanRegionChecked.ref, verifyCoverage: true, maxNodes: 100 })
    assert.equal(cleanChecked.coverage.verified, true, JSON.stringify(cleanChecked.coverage))
    assert.equal(cleanChecked.coverage.closedShadowRoots, 0)
    assert.ok(cleanChecked.coverage.probedNodes >= 2, JSON.stringify(cleanChecked.coverage))
    assert.equal(cleanChecked.coverage.reason, undefined)
    assert.equal(cleanChecked.truncated, false, 'a verified clean subtree must stay truncated false')
    assert.equal(cleanChecked.truncationReasons, undefined, JSON.stringify(cleanChecked.truncationReasons))
    assertSameNodes(cleanPlain, cleanChecked, 'clean region')

    // Whole-page on the fixture: the probe sees every closed root of the page
    // (three here) and marks the whole-page view accordingly.
    const wholeChecked = await manager.observe('owner', { verifyCoverage: true, maxNodes: 100 })
    assert.equal(wholeChecked.coverage.verified, false)
    assert.ok(wholeChecked.coverage.closedShadowRoots >= 3, 'the whole-page probe must find all three closed roots: ' + JSON.stringify(wholeChecked.coverage))
    assert.equal(wholeChecked.truncated, true)
    assert.ok(wholeChecked.truncationReasons?.includes('closed-shadow-root'), JSON.stringify(wholeChecked.truncationReasons))
    assert.equal(wholeChecked.truncationReasons?.length, 1, 'the small fixture fits every v9 budget: only the coverage reason applies: ' + JSON.stringify(wholeChecked.truncationReasons))

    // Whole-page on a small clean page: the probe completes and verifies.
    await manager.act('owner', { kind: 'navigate', url: origin + '/clean' })
    const cleanWhole = await manager.observe('owner', { verifyCoverage: true, maxNodes: 100 })
    assert.equal(cleanWhole.coverage.verified, true, JSON.stringify(cleanWhole.coverage))
    assert.equal(cleanWhole.coverage.closedShadowRoots, 0)
    assert.ok(cleanWhole.coverage.probedNodes >= 3, JSON.stringify(cleanWhole.coverage))
    assert.equal(cleanWhole.truncated, false, 'the clean page must stay truncated false')
    assert.equal(cleanWhole.truncationReasons, undefined, JSON.stringify(cleanWhole.truncationReasons))
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('verifyCoverage over a document larger than the probe node cap reports over-budget and shadow-coverage-unverified', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/huge') return res.end(hugeHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-phasec-huge-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/huge' })
    const plain = await manager.observe('owner', { maxNodes: 60 })
    const checked = await manager.observe('owner', { verifyCoverage: true, maxNodes: 60 })
    assert.equal(checked.coverage.verified, false, 'a probe over its node cap must never claim verified')
    assert.equal(checked.coverage.reason, 'over-budget', JSON.stringify(checked.coverage))
    assert.equal(checked.coverage.closedShadowRoots, 0)
    assert.ok(checked.coverage.probedNodes > 5000, 'the probe must report how far it got: ' + JSON.stringify(checked.coverage))
    assert.equal(checked.truncated, true)
    assert.ok(checked.truncationReasons?.includes('shadow-coverage-unverified'), 'an incomplete probe must be named: ' + JSON.stringify(checked.truncationReasons))
    assert.ok(checked.truncationReasons?.includes('node-budget-exceeded'), 'the v9 budget reasons stay: ' + JSON.stringify(checked.truncationReasons))
    assert.ok(!checked.truncationReasons?.includes('closed-shadow-root'), JSON.stringify(checked.truncationReasons))
    assertSameNodes(plain, checked, 'huge page')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('verifyCoverage reports cdp-unavailable when the CDP session cannot be created, reuses one session per managed session, and never crashes', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/clean') return res.end(cleanHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-phasec-cdp-'))
  // Simulate CDP session creation failing: shadow context.newCDPSession so the
  // coverage probe's lazy session creation throws while every other manager
  // path keeps working. The probe must report cdp-unavailable — never crash,
  // never claim verified.
  let cdpShouldThrow = false
  let cdpSessionCreations = 0
  const manager = new BrowserManager({
    rootDir,
    allowedOrigins: [origin],
    observationTtlMs: 120_000,
    launchPersistentContext: async (userDataDir, launchOptions) => {
      const context = await chromium.launchPersistentContext(userDataDir, launchOptions)
      const original = context.newCDPSession.bind(context)
      context.newCDPSession = async (...args) => {
        cdpSessionCreations += 1
        if (cdpShouldThrow) throw new Error('stubbed CDP session creation failure')
        return original(...args)
      }
      return context
    },
  })
  try {
    await manager.start('owner', { url: origin + '/clean' })
    const creationsAtStart = cdpSessionCreations
    assert.ok(creationsAtStart > 0, 'the manager still creates its lifecycle CDP sessions through the stub')

    // Ordinary observes never touch CDP for coverage: the count stays put.
    await manager.observe('owner')
    assert.equal(cdpSessionCreations, creationsAtStart, 'an observe without verifyCoverage must not create a coverage CDP session')

    // CDP session creation fails: the probe is unverified with cdp-unavailable,
    // the view is marked, and the observation still returns normally.
    cdpShouldThrow = true
    const unavailable = await manager.observe('owner', { verifyCoverage: true, maxNodes: 60 })
    assert.deepEqual(
      unavailable.coverage,
      { verified: false, reason: 'cdp-unavailable', closedShadowRoots: 0, probedNodes: 0 },
      JSON.stringify(unavailable.coverage),
    )
    assert.equal(unavailable.truncated, true)
    assert.ok(unavailable.truncationReasons?.includes('shadow-coverage-unverified'), JSON.stringify(unavailable.truncationReasons))
    assert.ok(unavailable.nodes.length > 0, 'the projection itself must be unaffected by the probe failure')
    assert.equal(cdpSessionCreations, creationsAtStart + 1, 'one failed session attempt, nothing retried inside the call')

    // Recovery: once session creation works again the probe verifies, and the
    // NEXT probe reuses the same managed session instead of creating another.
    cdpShouldThrow = false
    const recovered = await manager.observe('owner', { verifyCoverage: true, maxNodes: 60 })
    assert.equal(recovered.coverage.verified, true, JSON.stringify(recovered.coverage))
    assert.equal(recovered.truncated, false)
    assert.equal(cdpSessionCreations, creationsAtStart + 2, 'the first successful probe creates exactly one session')
    const reused = await manager.observe('owner', { verifyCoverage: true, maxNodes: 60 })
    assert.equal(reused.coverage.verified, true)
    assert.equal(cdpSessionCreations, creationsAtStart + 2, 'the second probe must reuse the managed coverage session')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})
