import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

// C2: two structurally identical "Confirm" buttons; the page removes row 1
// shortly after load (same URL, so PAGE_CHANGED cannot fire). Acting on row 1's
// ref must reject — it must never silently click the surviving twin.
const twinsPage = `<div class="row"><button class="confirm" onclick="document.title='row1-acted';document.getElementById('s').textContent='row1-acted'">Confirm</button></div>
  <div class="row"><button class="confirm" onclick="document.title='row2-acted';document.getElementById('s').textContent='row2-acted'">Confirm</button></div>
  <div role="status" id="s">none</div>
  <script>
    setTimeout(() => { document.querySelector('.row').remove() }, 1500)
  </script>`

// G2: an identical-named decoy button is inserted BEFORE the target after
// observation (same URL). The ref must keep denoting the ORIGINAL node: the
// mark must be drawn on the original's live box, and the click must land on
// the original, never on the decoy.
const decoyPage = `<style>button{display:block;height:48px;margin:8px}</style>
  <button id="target" onclick="document.title='original-acted';document.getElementById('s').textContent='original-acted'">Ship it</button>
  <div role="status" id="s">none</div>
  <script>
    setTimeout(() => {
      const decoy = document.createElement('button')
      decoy.textContent = 'Ship it'
      decoy.id = 'decoy'
      decoy.onclick = () => { document.title = 'decoy-acted'; document.getElementById('s').textContent = 'decoy-acted' }
      document.body.insertBefore(decoy, document.getElementById('target'))
    }, 1500)
  </script>`

test('a ref keeps denoting the ORIGINAL node: removal rejects, a decoy is never substituted', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/twins') return res.end(twinsPage)
    if (requestUrl.pathname === '/decoy') return res.end(decoyPage)
    res.end('<h1>Index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-identity-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000 })
  try {
    // --- C2: identical twins, row 1 removed during the pause ---
    await manager.start('owner', { url: origin + '/twins' })
    const observed = await manager.observe('owner')
    const buttons = observed.nodes.filter((node) => node.name === 'Confirm')
    assert.equal(buttons.length, 2, 'both twins observed')
    const row1 = buttons[0]

    await new Promise((resolve) => setTimeout(resolve, 2500)) // SPA re-render removes row 1

    const receipt = await manager.act('owner', { kind: 'click', ref: row1.ref })
    assert.equal(receipt.status, 'rejected', JSON.stringify(receipt))
    assert.ok(['TARGET_CHANGED', 'TARGET_DETACHED', 'TARGET_AMBIGUOUS'].includes(receipt.code), 'wrong-element click must be rejected with an identity code: ' + receipt.code)
    assert.equal(receipt.dispatched, false, 'nothing may be dispatched')
    const after = await manager.observe('owner')
    const statusNode = after.nodes.find((node) => node.name === 'none' || node.name.endsWith('-acted'))
    assert.equal(statusNode?.name, 'none', 'the surviving twin must not receive a click: ' + statusNode?.name)

    // --- G2: decoy inserted before the original at the same URL ---
    await manager.act('owner', { kind: 'navigate', url: origin + '/decoy' })
    const decoyObs = await manager.observe('owner')
    const target = decoyObs.nodes.find((node) => node.name === 'Ship it')
    assert.ok(target)

    await new Promise((resolve) => setTimeout(resolve, 2000)) // decoy inserted before the original

    const capture = await manager.visualObserve('owner', { fingerprint: decoyObs.fingerprint })
    const mark = capture.marks.find((entry) => entry.ref === target.ref)
    const omission = capture.omitted.find((entry) => entry.ref === target.ref)
    if (!mark) {
      assert.ok(omission, 'if the original cannot be marked it must be reported omitted with a reason: ' + JSON.stringify(capture.omitted))
    } else {
      // The decoy sits at the top (y small); the ORIGINAL moved down (y > 40 in this layout).
      assert.ok(mark.nativePixelFrame.y > 40, 'mark must be drawn on the original node, not the decoy at the top: ' + JSON.stringify(mark))
    }
    const click = await manager.act('owner', { kind: 'click', ref: target.ref })
    assert.equal(click.status, 'confirmed', JSON.stringify(click))
    assert.equal(click.pageAfter.title, 'original-acted', 'the click must land on the ORIGINAL node, never the decoy')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true })
  }
})
