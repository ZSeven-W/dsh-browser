import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function rejectedCode(promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error && typeof error.code === 'string' ? error.code : String(error)
  }
}

const fixture = [
  '<!doctype html>',
  '<html><head><title>Visual QA fixture</title></head><body>',
  '<div id="banner" style="background:#1a2b3c;color:#fff;padding:40px 24px;font-size:24px">Visual QA banner</div>',
  '<h1 id="title">Visual QA fixture</h1>',
  '<label for="name">Name</label><input id="name" />',
  '<button id="save" style="background:#3366ff;color:#fff">Save</button>',
  '<a id="link" href="/other">Next page</a>',
  '<div style="margin-top:2000px"><button id="off">Off viewport</button></div>',
  '</body></html>',
].join('')

test('visual capture labels semantic nodes, omits off-viewport nodes, and cleans up', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/other') {
      res.end('<!doctype html><html><head><title>Other</title></head><body><h1>Other page</h1></body></html>')
      return
    }
    if (requestUrl.pathname === '/auto') {
      res.end('<!doctype html><html><head><title>Auto</title></head><body><h1>Auto page</h1><script>setTimeout(function(){ location.replace("/other") }, 500)</script></body></html>')
      return
    }
    if (requestUrl.pathname === '/tall') {
      res.end('<!doctype html><html><head><title>Tall</title></head><body><div style="height:14000px">tall</div></body></html>')
      return
    }
    res.end(fixture)
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-visual-'))
  let now = Date.now()
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000, now: () => now })
  try {
    assert.equal(await rejectedCode(manager.visualObserve('ghost')), 'SESSION_NOT_RUNNING')
    await manager.start('owner', { url: origin })
    assert.equal(await rejectedCode(manager.visualObserve('owner')), 'OBSERVATION_REQUIRED')

    const observation = await manager.observe('owner')
    const nodes = observation.nodes
    const viewport = observation.page.viewport
    assert.equal(nodes.length, 6)
    const nodeRefs = new Set(nodes.map((node) => node.ref))

    const capture = await manager.visualObserve('owner')
    assert.equal(capture.ownerId, 'owner')
    assert.equal(capture.epoch, observation.epoch)
    assert.equal(capture.observationFingerprint, observation.fingerprint)
    assert.equal(capture.capture.fullPage, false)
    assert.equal(capture.capture.pixelWidth, viewport.width)
    assert.equal(capture.capture.pixelHeight, viewport.height)
    assert.equal(capture.capture.scaleX, 1)
    assert.equal(capture.capture.scaleY, 1)
    assert.equal(capture.capture.artifact.format, 'png')
    assert.ok(capture.capture.artifact.byteLength > 0)
    assert.equal(capture.capture.artifact.sha256.length, 64)
    assert.equal(capture.png.length, capture.capture.artifact.byteLength)
    assert.equal(capture.capture.quality.usable, true)
    assert.equal(capture.capture.quality.classification, 'usable')
    assert.ok(capture.capture.quality.sampleCount > 0)

    const marked = capture.marks
    const omitted = capture.omitted
    assert.equal(marked.length + omitted.length, nodes.length)
    const covered = new Set([...marked, ...omitted].map((entry) => entry.ref))
    assert.deepEqual([...covered].sort(), [...nodeRefs].sort())

    for (const mark of marked) {
      const frame = mark.nativePixelFrame
      assert.ok(frame.x >= 0 && frame.y >= 0, 'mark box top-left inside viewport')
      assert.ok(frame.x + frame.width <= viewport.width + 0.001, 'mark box right edge inside viewport')
      assert.ok(frame.y + frame.height <= viewport.height + 0.001, 'mark box bottom edge inside viewport')
      assert.equal(mark.number, mark.sourceIndex + 1)
      assert.equal(nodes[mark.sourceIndex].ref, mark.ref)
    }

    const offNode = nodes.find((node) => node.name === 'Off viewport')
    assert.ok(offNode)
    const offOmission = omitted.find((entry) => entry.ref === offNode.ref)
    assert.ok(offOmission)
    assert.equal(offOmission.reason, 'off-viewport')
    assert.equal(offOmission.sourceIndex, nodes.indexOf(offNode))

    assert.equal(await rejectedCode(manager.visualObserve('owner', { fingerprint: 'stale' })), 'OBSERVATION_STALE')

    const scaled = await manager.visualObserve('owner', { scale: 2 })
    assert.equal(scaled.capture.pixelWidth, viewport.width * 2)
    assert.equal(scaled.capture.pixelHeight, viewport.height * 2)
    assert.equal(scaled.capture.scaleX, 2)
    assert.equal(scaled.capture.scaleY, 2)

    const budgeted = await manager.visualObserve('owner', { maxMarks: 1 })
    assert.equal(budgeted.marks.length, 1)
    assert.ok(budgeted.omitted.some((entry) => entry.reason === 'mark-budget-exceeded'))
    assert.equal(budgeted.marks.length + budgeted.omitted.length, nodes.length)

    const full = await manager.visualObserve('owner', { fullPage: true })
    assert.equal(full.capture.fullPage, true)
    assert.equal(full.omitted.filter((entry) => entry.reason === 'off-viewport').length, 0)
    const fullOffMark = full.marks.find((mark) => mark.ref === offNode.ref)
    assert.ok(fullOffMark)

    await access(capture.capture.artifact.path)

    // Freshness: the page navigated away since observation without a re-observe.
    await manager.act('owner', { kind: 'navigate', url: origin + '/auto' })
    await manager.observe('owner')
    await delay(700)
    assert.equal(await rejectedCode(manager.visualObserve('owner')), 'PAGE_CHANGED')

    // Freshness: the observation expired.
    await manager.act('owner', { kind: 'navigate', url: origin })
    await manager.observe('owner')
    now += 61_000
    assert.equal(await rejectedCode(manager.visualObserve('owner')), 'REF_EXPIRED')
    now = Date.now()

    // Oversized full-page capture fails cleanly before any capture happens.
    await manager.act('owner', { kind: 'navigate', url: origin + '/tall' })
    await manager.observe('owner')
    assert.equal(await rejectedCode(manager.visualObserve('owner', { fullPage: true })), 'CAPTURE_TOO_LARGE')

    // The capture file lives in the session temp area and is removed on stop.
    await manager.stop('owner')
    await assert.rejects(access(capture.capture.artifact.path), /ENOENT/)
    assert.deepEqual(await readdir(rootDir), [])
  } finally {
    await manager.dispose()
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true })
  }
})
