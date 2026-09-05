import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

// Contract v9 identity anchor (B3): the driver retains the handle of the
// element it last dispatched an action on (per session), and
// observe({ anchorLastAction: true }) reports, IN-PAGE against the ORIGINAL
// handle, whether that element is still connected and whether it lies inside
// the within subtree (composed containment), plus its fresh ref in THIS
// observation when it was emitted. No retained target -> the call REJECTS
// with ANCHOR_UNAVAILABLE, never a silent null.

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

// Page whose anchor button removes itself 1200ms after load, for the
// disconnected-anchor path.
const removalHtml = '<!doctype html><html><head><title>Anchor removal fixture</title>' +
  '<style>body{margin:0}.box{display:block;width:240px;height:24px;margin:0;padding:0;box-sizing:border-box}</style></head><body>' +
  '<h1>Anchor removal fixture</h1>' +
  // The region keeps its own box (40px) after the button removal, so the
  // visibility gate still emits it while the poll waits for the removal.
  '<div id="doomed-region" role="region" aria-label="Doomed region" style="height:40px">' +
  '<button class="box" id="doomed-button">doomed-button</button>' +
  '</div>' +
  '<script>setTimeout(() => document.getElementById("doomed-button").remove(), 1200)</script>' +
  '</body></html>'

async function rejectedCode(promise) {
  try {
    await promise
  } catch (error) {
    return error && typeof error.code === 'string' ? error.code : String(error)
  }
  return null
}

test('anchorLastAction: identity of the last acted element, connected/contained in-page, ANCHOR_UNAVAILABLE without one', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/phaseb') return res.end(fixtureHtml)
    if (requestUrl.pathname === '/removal') return res.end(removalHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-phaseb-anchor-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/phaseb' })

    // Without any dispatched element action there is nothing to anchor: the
    // request must REJECT with a distinct code, never return a null anchor.
    const noAnchorCode = await rejectedCode(manager.observe('owner', { anchorLastAction: true }))
    assert.equal(noAnchorCode, 'ANCHOR_UNAVAILABLE', 'anchorLastAction without a retained action target must reject')

    // Chain to the anchor button and scroll it into view by ref.
    const whole = await manager.observe('owner', { maxNodes: 100 })
    const anchorRegion = whole.nodes.find((node) => node.name === 'Phase B anchor region')
    assert.ok(anchorRegion)
    const scoped = await manager.observe('owner', { within: anchorRegion.ref, maxNodes: 100 })
    const button = scoped.nodes.find((node) => node.name === 'anchor-button')
    assert.ok(button)
    const receipt = await manager.act('owner', { kind: 'scroll', ref: button.ref })
    assert.equal(receipt.status, 'confirmed', JSON.stringify(receipt))

    // Re-chain after the action and anchor within the region: the ORIGINAL
    // acted element is connected, contained in the within subtree, and its
    // fresh ref in THIS observation is the emitted button's ref.
    const whole2 = await manager.observe('owner', { maxNodes: 100 })
    const region2 = whole2.nodes.find((node) => node.name === 'Phase B anchor region')
    assert.ok(region2)
    const anchored = await manager.observe('owner', { within: region2.ref, anchorLastAction: true, maxNodes: 100 })
    const button2 = anchored.nodes.find((node) => node.name === 'anchor-button')
    assert.ok(button2, 'the acted button must be emitted in the anchored scoped view')
    assert.deepEqual(anchored.anchor, { ref: button2.ref, connected: true, contained: true }, 'the anchor must bind the acted element in the within subtree')

    // Anchor against a DIFFERENT container: the acted element is still
    // connected but not contained there, and it was not emitted in that
    // view, so its ref is null while connected/contained stay truthful.
    const whole3 = await manager.observe('owner', { maxNodes: 100 })
    const slotRegion = whole3.nodes.find((node) => node.name === 'Phase B slot region')
    assert.ok(slotRegion)
    const elsewhere = await manager.observe('owner', { within: slotRegion.ref, anchorLastAction: true, maxNodes: 100 })
    assert.ok(!elsewhere.nodes.some((node) => node.name === 'anchor-button'), 'the acted element must not be emitted inside the wrong subtree')
    assert.deepEqual(elsewhere.anchor, { ref: null, connected: true, contained: false }, 'a wrong container must report contained false with a null ref')

    // Whole-page anchor: contained is null (no within subtree), ref is the
    // fresh ref of the acted element in the whole-page view.
    const wholeAnchor = await manager.observe('owner', { anchorLastAction: true, maxNodes: 100 })
    const buttonWhole = wholeAnchor.nodes.find((node) => node.name === 'anchor-button')
    assert.ok(buttonWhole)
    assert.deepEqual(wholeAnchor.anchor, { ref: buttonWhole.ref, connected: true, contained: null }, 'whole-page anchor keeps contained null')

    // Navigate: the retained target is released and the next anchor request
    // rejects with the same distinct code.
    await manager.act('owner', { kind: 'navigate', url: origin + '/removal' })
    const doomedWhole = await manager.observe('owner', { maxNodes: 100 })
    const doomedRegion = doomedWhole.nodes.find((node) => node.name === 'Doomed region')
    assert.ok(doomedRegion)
    const doomedScoped = await manager.observe('owner', { within: doomedRegion.ref, maxNodes: 100 })
    const doomed = doomedScoped.nodes.find((node) => node.name === 'doomed-button')
    assert.ok(doomed)
    const doomedReceipt = await manager.act('owner', { kind: 'hover', ref: doomed.ref })
    assert.equal(doomedReceipt.status, 'confirmed', JSON.stringify(doomedReceipt))

    // The page removes the button 1200ms after load; poll anchored scoped
    // observes until the ORIGINAL handle reports disconnected.
    let anchor = null
    for (let i = 0; i < 25; i += 1) {
      const currentWhole = await manager.observe('owner', { maxNodes: 100 })
      const regionNow = currentWhole.nodes.find((node) => node.name === 'Doomed region')
      assert.ok(regionNow)
      const current = await manager.observe('owner', { within: regionNow.ref, anchorLastAction: true, maxNodes: 100 })
      assert.ok(current.anchor, 'the anchored observe must carry an anchor object')
      if (current.anchor.connected === false) {
        anchor = current.anchor
        break
      }
      await delay(300)
    }
    assert.ok(anchor, 'the page must eventually remove the acted button')
    assert.deepEqual(anchor, { ref: null, connected: false, contained: false }, 'a removed acted element must report disconnected, uncontained, with a null ref')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})
