import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'
import { chromium } from 'playwright-core'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

// 1500 selector matches, all visible: the worst case for the retired design,
// which materialized a Playwright ElementHandle for EVERY match on the page.
function manyButtons(count, prefix) {
  return Array.from({ length: count }, (_, i) => `<button>${prefix}-${i}</button>`).join('')
}

// 200 elements removed + 200 inserted every 20ms, in a container ordered BEFORE
// the 120 stable buttons, so every 60-node selection is drawn from the churn
// region. Names are unique per generation: a node that vanishes never comes
// back under the same name, so "vanish then reappear" can only mean the
// observation briefly lost a live node.
const churnPage = `<!doctype html><html><body>
  <div id="churn"></div>
  <style>#churn button{display:block;height:20px;margin:0}</style>
  ${manyButtons(120, 'stable')}
  <script>
    let tick = 0
    const container = document.getElementById('churn')
    const fill = () => {
      const fragment = document.createDocumentFragment()
      for (let i = 0; i < 200; i += 1) {
        const button = document.createElement('button')
        button.textContent = 'churn-' + tick + '-' + i
        fragment.appendChild(button)
      }
      container.replaceChildren(fragment)
      tick += 1
    }
    fill()
    setInterval(fill, 20)
  </script></body></html>`

const shadowPage = `<!doctype html><html><body>
  <div id="host"></div>
  <div role="status" id="s">idle</div>
  <script>
    const host = document.getElementById('host')
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<button id="shadow-act" style="display:block;width:240px;height:44px">Shadow act</button>'
    root.getElementById('shadow-act').addEventListener('click', () => {
      document.getElementById('s').textContent = 'shadow-clicked'
    })
  </script></body></html>`

// Patch the Playwright Page/JSHandle/Locator prototypes through a probe
// browser of the SAME playwright-core module instance the manager uses, so
// every observe() can be watched without touching production code.
// ElementHandles inherit dispose from JSHandle.prototype (verified: no own
// override), so one dispose counter sees every handle release. Every handle
// observe() creates is either kept on the current observation (<= maxNodes at
// any time) or released through this method, so per-observe dispose
// invocations bound per-observe handle creation.
//
// Every patched method drives at least one driver->browser protocol call, so
// roundTripCalls counts observe()'s round trips. The per-method counters keep
// the QA-BL-037 regression fingerprints assertable: page.$$ (full-page
// element query), page.$ (per-node binding), locator.evaluateAll (the retired
// full-page re-verification) and locator.elementHandles (per-match handle
// materialization).
test('observe captures atomically: O(nodes) round trips, no full-page handle query, bounded handle churn', { timeout: 120_000 }, async (t) => {
  const discovered = await discoverInstalledBrowser().catch((error) => {
    t.skip(`installed Chrome/Edge/Chromium unavailable: ${error.message}`)
    return null
  })
  if (!discovered) return

  let probeBrowser
  try {
    probeBrowser = await chromium.launch({ executablePath: discovered.path, headless: true })
  } catch (error) {
    t.skip(`probe browser launch failed: ${error.message}`)
    return
  }
  const probePage = await probeBrowser.newPage()
  const pagePrototype = Object.getPrototypeOf(probePage)
  assert.equal(typeof pagePrototype.$$, 'function', 'expected page.$$ on the Playwright Page prototype')
  const probeHandle = await probePage.evaluateHandle(() => 1)
  const handlePrototype = Object.getPrototypeOf(probeHandle)
  assert.equal(typeof handlePrototype.dispose, 'function', 'expected dispose on the Playwright JSHandle prototype')
  const locatorPrototype = Object.getPrototypeOf(probePage.locator('body'))

  let roundTripCalls = 0
  const countsByName = {
    pageEvaluateHandle: 0,
    pageEvaluate: 0,
    pageTitle: 0,
    pageDollar: 0,
    pageDollarDollar: 0,
    handleEvaluate: 0,
    handleGetProperty: 0,
    handleGetProperties: 0,
    handleDispose: 0,
    locatorCount: 0,
    locatorEvaluateAll: 0,
    locatorElementHandles: 0,
  }
  const spy = (prototype, name, label) => {
    const original = prototype[name]
    assert.equal(typeof original, 'function', `expected ${name} on the Playwright prototype`)
    prototype[name] = function observeCaptureSpy(...args) {
      roundTripCalls += 1
      countsByName[label] += 1
      return original.apply(this, args)
    }
  }
  spy(pagePrototype, 'evaluateHandle', 'pageEvaluateHandle')
  spy(pagePrototype, 'evaluate', 'pageEvaluate')
  spy(pagePrototype, 'title', 'pageTitle')
  spy(pagePrototype, '$', 'pageDollar')
  spy(pagePrototype, '$$', 'pageDollarDollar')
  spy(handlePrototype, 'evaluate', 'handleEvaluate')
  spy(handlePrototype, 'getProperty', 'handleGetProperty')
  spy(handlePrototype, 'getProperties', 'handleGetProperties')
  spy(handlePrototype, 'dispose', 'handleDispose')
  spy(locatorPrototype, 'count', 'locatorCount')
  spy(locatorPrototype, 'evaluateAll', 'locatorEvaluateAll')
  spy(locatorPrototype, 'elementHandles', 'locatorElementHandles')
  await probeHandle.dispose().catch(() => {})
  await probeBrowser.close().catch(() => {})
  roundTripCalls = 0
  for (const key of Object.keys(countsByName)) countsByName[key] = 0

  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/many') return res.end(`<html><body>${manyButtons(1500, 'b')}</body></html>`)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-capture-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin] })
  try {
    await manager.start('owner', { url: origin + '/many' })
    const maxNodes = 60
    // (a) ElementHandles materialized per observe must track the NODES emitted
    // (<= maxNodes), not the matches on the page (1500). Dispose calls are the
    // observable trace of handle churn: each observe may release the previous
    // observation's handles (<= maxNodes) plus its one array JSHandle.
    const perPoll = []
    // (c) Round-trip budget — the structural replacement for the retired
    // wall-clock ratio, which flaked under CPU load: one observe must make
    // O(returned nodes) driver->browser calls, never O(matches). The atomic
    // capture costs a fixed handful of calls (<= 8 across the page-side
    // capture, the two parallel property pulls, one materializing getProperties
    // and the capture/array releases — doubled only by the document-replacement
    // retry), plus <= 2 fixed observe-level calls (title, iframe count) and
    // the previous observation's <= maxNodes handle releases, so a budget of
    // 2 * maxNodes + 16 keeps >= 2x headroom. A reintroduced per-node page.$
    // binding would add 2 calls per returned node (~190 total on this page)
    // and per-match handle materialization would add ~1500; both trip this
    // bound deterministically, which wall clock never could.
    const roundTripBudgets = []
    for (let poll = 0; poll < 9; poll += 1) {
      const disposeBefore = countsByName.handleDispose
      const callsBefore = roundTripCalls
      const countsBefore = { ...countsByName }
      const observed = await manager.observe('owner', { maxNodes })
      const released = countsByName.handleDispose - disposeBefore
      const used = roundTripCalls - callsBefore
      perPoll.push(released)
      roundTripBudgets.push(used)
      assert.equal(observed.nodes.length, maxNodes, `poll ${poll} returned ${observed.nodes.length} nodes`)
      const budget = 2 * maxNodes + 16
      const delta = Object.keys(countsByName)
        .filter((key) => countsByName[key] > countsBefore[key])
        .map((key) => `${key}:${countsByName[key] - countsBefore[key]}`)
        .join(' ')
      assert.ok(
        used <= budget,
        `poll ${poll}: observe used ${used} driver->browser calls for ${observed.nodes.length} returned nodes (budget ${budget}); breakdown ${delta}`,
      )
      assert.ok(
        released <= maxNodes + 4,
        `poll ${poll} released ${released} handles; a full-page handle query would release ~1440`,
      )
    }
    console.log('handle releases per observe (1500 matches, maxNodes 60):', perPoll.join(','))
    console.log('driver->browser calls per observe (1500 matches, maxNodes 60):', roundTripBudgets.join(','))
    // (b) observe() must never run a full-page element query or a per-node /
    // per-match binding; these verbs are the QA-BL-037 regression fingerprints.
    assert.equal(countsByName.pageDollarDollar, 0, `page.$$ was called ${countsByName.pageDollarDollar} times from observe()`)
    assert.equal(countsByName.pageDollar, 0, `page.$ was called ${countsByName.pageDollar} times from observe()`)
    assert.equal(countsByName.locatorEvaluateAll, 0, `locator.evaluateAll was called ${countsByName.locatorEvaluateAll} times from observe()`)
    assert.equal(countsByName.locatorElementHandles, 0, `locator.elementHandles was called ${countsByName.locatorElementHandles} times from observe()`)
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('observe stays sound under 20ms DOM churn: full node counts, no vanish-reappear flapping', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip(`installed Chrome/Edge/Chromium unavailable: ${error.message}`)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/churn') return res.end(churnPage)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-churn-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/churn' })
    const counts = []
    const nameSets = []
    for (let poll = 0; poll < 30; poll += 1) {
      const observed = await manager.observe('owner', { maxNodes: 60 })
      counts.push(observed.nodes.length)
      nameSets.push(new Set(observed.nodes.map((node) => node.name)))
    }
    console.log('churn per-poll node counts:', counts.join(','))
    // Visible matches are always >= 320 (200 churn + 120 stable), so
    // min(maxNodes, visible matches) = 60; tolerance 2.
    for (const [poll, count] of counts.entries()) {
      assert.ok(count >= 58, `poll ${poll} returned only ${count} nodes; expected ~60`)
    }
    let worstReappearRatio = 0
    for (let poll = 1; poll < counts.length; poll += 1) {
      const vanished = [...nameSets[poll - 1]].filter((name) => !nameSets[poll].has(name))
      const next = nameSets[poll + 1]
      const reappeared = next === undefined ? 0 : vanished.filter((name) => next.has(name)).length
      const ratio = vanished.length === 0 ? 0 : reappeared / vanished.length
      worstReappearRatio = Math.max(worstReappearRatio, ratio)
      assert.ok(
        reappeared * 2 <= vanished.length,
        `poll ${poll}: ${reappeared}/${vanished.length} nodes vanished then reappeared on the next poll`,
      )
    }
    console.log(`churn worst vanish->reappear ratio: ${worstReappearRatio.toFixed(2)}`)
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('open shadow-root nodes are collected, bindable, and actable', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip(`installed Chrome/Edge/Chromium unavailable: ${error.message}`)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/shadow') return res.end(shadowPage)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-shadow-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin] })
  try {
    await manager.start('owner', { url: origin + '/shadow' })
    const observed = await manager.observe('owner', { maxNodes: 60 })
    const shadow = observed.nodes.find((node) => node.name === 'Shadow act')
    assert.ok(shadow, 'shadow button must be collected: ' + JSON.stringify(observed.nodes.map((node) => node.name)))
    assert.equal(shadow.bindable, true, 'shadow button must carry a live binding')
    const receipt = await manager.act('owner', { kind: 'click', ref: shadow.ref })
    assert.equal(receipt.status, 'confirmed', JSON.stringify(receipt))
    const after = await manager.observe('owner')
    assert.ok(
      after.nodes.some((node) => node.name === 'shadow-clicked'),
      'shadow click side effect must be visible: ' + JSON.stringify(after.nodes.map((node) => node.name)),
    )
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})
