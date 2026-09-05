import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { BrowserManager, collectSemanticTargets, discoverInstalledBrowser } from '../lib/index.js'

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

// Same layout, but the page removes the container 1200ms after load: a ref
// observed before the removal resolves TARGET_CHANGED afterwards.
const removalHtml = fixtureHtml.replace(
  '</body>',
  '<script>setTimeout(() => document.getElementById("container").remove(), 1200)</script></body>',
)

// Page that self-navigates (no driver action), so an observation survives with
// a changed URL and PAGE_CHANGED fires for its refs.
const selfNavHtml = '<!doctype html><html><head><title>Selfnav fixture</title></head><body>' +
  '<h1>Selfnav fixture</h1>' +
  '<script>setTimeout(() => { if (location.pathname === "/scoped-selfnav") location.href = "/other" }, 1500)</script>' +
  '</body></html>'

// A container whose subtree exceeds the 48 KiB emission budget well before the
// 100-node budget: 300 visible links with ~500-byte hrefs and 180-byte names.
const fatBytesHtml = '<!doctype html><html><head><title>Scoped byte fixture</title>' +
  '<style>.fat{display:block;height:10px;width:240px;margin:0;padding:0;box-sizing:border-box}</style></head><body>' +
  '<h1>Scoped byte fixture</h1>' +
  '<div id="fat" role="region" aria-label="Fat container">' +
  Array.from({ length: 300 }, (_, i) =>
    '<a class="fat" href="https://example.com/fat/' + 'x'.repeat(480) + '-' + i + '" aria-label="fat-' + i + ' ' + 'y'.repeat(160) + '">fat-' + i + '</a>'
  ).join('') +
  '</div></body></html>'

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
  assert.equal(narrow.scope.name, 'Scope anchor region')
  const container = narrow.nodes.find((node) => node.name === 'Deep container')
  assert.ok(container, 'the narrow observation must include the container as its 100th node: ' + JSON.stringify(narrow.nodes.map((node) => node.name).slice(-4)))
  return { container, narrow }
}

test('scoped observe reaches a deep target beyond the whole-page window and proves its subtree fits', { timeout: 120_000 }, async (t) => {
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
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-scoped-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/scoped' })

    // Whole-page observations at shipped budgets never reach the container or
    // its deep target: the page exposes 132 visible matches and the container
    // is the 102nd.
    const wholeDefault = await manager.observe('owner')
    const whole100 = await manager.observe('owner', { maxNodes: 100 })
    for (const observed of [wholeDefault, whole100]) {
      assert.equal(observed.nodes.some((node) => node.name === 'Deep container'), false, 'container must sit beyond the whole-page window')
      assert.equal(observed.nodes.some((node) => node.name === 'Deep scoped target'), false, 'deep target must sit beyond the whole-page window')
      assert.equal(observed.scope, null, 'whole-page observations must report scope null')
    }
    assert.ok(whole100.truncationReasons?.includes('node-budget-exceeded'), JSON.stringify(whole100.truncationReasons))
    assert.ok(!whole100.truncationReasons?.includes('scan-window-exceeded'), JSON.stringify(whole100.truncationReasons))

    // Narrow to the main region: the container lands exactly at the 100th node.
    const { container, narrow } = await reachContainer(manager)
    assert.equal(narrow.nodes.length, 100)
    assert.ok(narrow.truncated, 'the narrow observation is partial: the subtree keeps 32 more nodes')
    assert.ok(narrow.truncationReasons?.includes('node-budget-exceeded'), JSON.stringify(narrow.truncationReasons))
    assert.ok(narrow.truncationReasons?.includes('iframe-not-traversed'), 'the iframe inside main must flag the main-scoped view: ' + JSON.stringify(narrow.truncationReasons))
    assert.deepEqual(narrow.scope, { ref: narrow.scope.ref, role: 'region', name: 'Scope anchor region', tag: 'main' })
    assert.ok(!narrow.nodes.some((node) => node.name === 'Deep scoped target'), 'the deep target stays beyond the narrow budget')

    // Scope to the container: the whole subtree fits, truncated false with no
    // reasons — absence inside the container is now provable.
    const scoped = await manager.observe('owner', { within: container.ref, maxNodes: 40 })
    const deep = scoped.nodes.find((node) => node.name === 'Deep scoped target')
    assert.ok(deep, 'the scoped observe must return the deep target: ' + JSON.stringify(scoped.nodes.map((node) => node.name)))
    assert.equal(scoped.truncated, false, 'a subtree that fits must report truncated false')
    assert.equal(scoped.truncationReasons, undefined, 'no reasons when the subtree fits: ' + JSON.stringify(scoped.truncationReasons))
    assert.equal(scoped.limits.maxNodes, 40, 'limits.maxNodes keeps reporting the applied budget')
    assert.deepEqual(scoped.scope, { ref: container.ref, role: 'region', name: 'Deep container', tag: 'div' })
    assert.equal(scoped.nodes.length, 32, 'the container subtree holds 32 semantic matches')
    assert.ok(!scoped.nodes.some((node) => node.name.startsWith('probe-')), 'the scoped view must contain subtree nodes only')
    assert.ok(scoped.nodes.some((node) => node.name.startsWith('shadow-deep-')), 'open shadow roots must pierce inside the scope')
    assert.ok(scoped.nodes.every((node) => node.name !== 'anchor-prev'), 'nodes outside the subtree must not leak in')
    assert.equal(deep.href, 'https://example.com/scoped/page', 'the deep target keeps its scrubbed href')
    assert.equal(deep.inViewport, false, 'a scrolled-out subtree node must report inViewport false (whole-page viewport semantics)')
    assert.ok(!scoped.truncated, 'the iframe outside the container must not truncate the subtree view')

    // Scroll the container into view by ref, then re-chain: the same node flips
    // to inViewport true, proving inViewport is viewport intersection, not
    // subtree membership.
    const preScroll = await reachContainer(manager)
    const scrollReceipt = await manager.act('owner', { kind: 'scroll', ref: preScroll.container.ref })
    assert.equal(scrollReceipt.status, 'confirmed', JSON.stringify(scrollReceipt))
    const postScroll = await reachContainer(manager)
    const scopedInView = await manager.observe('owner', { within: postScroll.container.ref, maxNodes: 40 })
    const deepInView = scopedInView.nodes.find((node) => node.name === 'Deep scoped target')
    assert.equal(deepInView.inViewport, true, 'the deep target must enter the viewport after the scroll')
    assert.equal(scopedInView.truncated, false, 'the subtree still fits after the scroll')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('scoped observe refusals are distinct and never fall back to a whole-page view', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/scoped') return res.end(fixtureHtml)
    if (requestUrl.pathname === '/scoped-removal') return res.end(removalHtml)
    if (requestUrl.pathname === '/scoped-selfnav') return res.end(selfNavHtml)
    if (requestUrl.pathname === '/other') return res.end('<h1>Other</h1>')
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-scoped-refusals-'))
  let now = Date.now()
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 1_000, now: () => now })
  const refuse = async (options) => {
    const code = await rejectedCode(manager.observe('owner', options))
    assert.ok(code !== null, 'the scoped observe must REJECT, never return a whole-page view: ' + JSON.stringify(options))
    return code
  }
  try {
    await manager.start('owner', { url: origin + '/scoped' })
    await manager.observe('owner')

    // Malformed ref: same vocabulary as act's ref validation.
    assert.equal(await refuse({ within: 'x'.repeat(200) }), 'REF_INVALID')
    assert.equal(await refuse({ within: 42 }), 'REF_INVALID')

    // Unknown ref: not part of the latest observation.
    assert.equal(await refuse({ within: 'br_bogus_ref' }), 'REF_UNKNOWN')

    // Consumed ref: a later observation replaced the one that minted it.
    const first = await reachContainer(manager)
    await manager.observe('owner')
    assert.equal(await refuse({ within: first.container.ref }), 'REF_UNKNOWN')

    // Consumed by a dispatched action: the observation no longer exists.
    const second = await reachContainer(manager)
    const scrolled = await manager.act('owner', { kind: 'scroll', direction: 'down', amount: 100 })
    assert.equal(scrolled.status, 'confirmed', JSON.stringify(scrolled))
    assert.equal(await refuse({ within: second.container.ref }), 'OBSERVATION_REQUIRED')

    // Expired ref: the observation TTL elapsed.
    const third = await reachContainer(manager)
    now += 1_001
    assert.equal(await refuse({ within: third.container.ref }), 'REF_EXPIRED')
    now = Date.now()

    // Page changed under the observation (self-navigation, no driver action).
    await manager.act('owner', { kind: 'navigate', url: origin + '/scoped-selfnav' })
    const selfNav = await manager.observe('owner')
    const heading = selfNav.nodes.find((node) => node.tag === 'h1')
    assert.ok(heading)
    // The page self-navigates 1500ms after load, well after the observation's
    // atomic capture settled; the within call then finds the URL changed.
    await new Promise((resolve) => setTimeout(resolve, 1_700))
    assert.equal(await refuse({ within: heading.ref }), 'PAGE_CHANGED')

    // Detached target: the page removed the container after the observation.
    await manager.act('owner', { kind: 'navigate', url: origin + '/scoped-removal' })
    const doomed = await reachContainer(manager)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    assert.equal(await refuse({ within: doomed.container.ref }), 'TARGET_CHANGED')

    // A refusal never breaks the next legitimate observation.
    await manager.act('owner', { kind: 'navigate', url: origin + '/scoped' })
    const after = await reachContainer(manager)
    const scoped = await manager.observe('owner', { within: after.container.ref, maxNodes: 40 })
    assert.ok(scoped.nodes.some((node) => node.name === 'Deep scoped target'), 'the session still observes normally after refusals')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('the byte ceiling applies inside a large subtree', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/scoped-bytes') return res.end(fatBytesHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-scoped-bytes-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000 })
  try {
    await manager.start('owner', { url: origin + '/scoped-bytes' })
    const whole = await manager.observe('owner')
    const fat = whole.nodes.find((node) => node.name === 'Fat container')
    assert.ok(fat, 'the fat container is within the whole-page window')
    const scoped = await manager.observe('owner', { within: fat.ref, maxNodes: 100 })
    assert.equal(scoped.limits.maxNodes, 100)
    assert.equal(scoped.truncated, true, 'the fat subtree must truncate')
    assert.ok(scoped.truncationReasons?.includes('byte-budget-exceeded'), 'the byte budget must be named: ' + JSON.stringify(scoped.truncationReasons))
    assert.ok(scoped.truncationReasons?.includes('node-budget-exceeded'), JSON.stringify(scoped.truncationReasons))
    assert.ok(!scoped.truncationReasons?.includes('scan-window-exceeded'), '300 subtree matches fit the scan window: ' + JSON.stringify(scoped.truncationReasons))
    assert.ok(scoped.nodes.length < 100, 'the byte budget must cut before the node budget: ' + scoped.nodes.length)
    assert.ok(scoped.nodes.length > 0)
    assert.ok(scoped.nodes.every((node) => node.tag !== 'h1'), 'the scoped byte view must contain subtree nodes only')
    assert.ok(scoped.nodes[0].name === 'Fat container', 'the scoped root is the first subtree node')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('collectSemanticTargets refuses a detached or non-element root', { timeout: 60_000 }, async (t) => {
  let executable
  try { executable = await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  const browser = await chromium.launch({ headless: true, executablePath: executable.path })
  try {
    const page = await browser.newPage()
    await page.setContent('<h1>Root checks</h1><div id="box"><button>inside</button></div>')
    const textRoot = await page.evaluateHandle(() => document.createTextNode('text-root'))
    const notElement = await collectSemanticTargets(page, { scanLimit: 500, maxNodes: 60, root: textRoot })
    assert.equal(notElement.rootFailure, 'not-element')
    assert.equal(notElement.candidates.length, 0)

    const detachedRoot = await page.evaluateHandle(() => {
      const el = document.createElement('button')
      el.textContent = 'floating'
      return el
    })
    const detached = await collectSemanticTargets(page, { scanLimit: 500, maxNodes: 60, root: detachedRoot })
    assert.equal(detached.rootFailure, 'detached')
    assert.equal(detached.candidates.length, 0)

    // Sanity: a real element root collects exactly its composed subtree.
    const boxRoot = await page.locator('#box').elementHandle()
    const scoped = await collectSemanticTargets(page, { scanLimit: 500, maxNodes: 60, root: boxRoot })
    assert.equal(scoped.rootFailure, undefined)
    assert.equal(scoped.candidates.length, 1)
    assert.equal(scoped.candidates[0].name, 'inside')
    assert.equal(scoped.iframeCount, 0)
  } finally {
    await browser.close()
  }
})
