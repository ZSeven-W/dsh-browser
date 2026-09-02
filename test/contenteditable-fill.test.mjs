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

// D1: contenteditable is a value-bearing editable control. Its text must be
// observable (bounded, with the same secret rules) and a fill must confirm
// with a value-match proof instead of DISPATCH_OUTCOME_UNKNOWN.
const editablePage = `<div id="ce" contenteditable="true" aria-label="Rich editor" style="width:300px;height:60px;border:1px solid #000"></div>
  <div aria-hidden="true"><div id="ce-hidden" contenteditable="true" aria-label="Hidden editor">aria-hidden-ce-secret-9K2</div></div>
  <div role="status" id="s">idle</div>
  <script>
    document.getElementById('ce').addEventListener('input', (e) => {
      document.getElementById('s').textContent = 'ce-content:' + e.target.textContent
    })
  </script>`

test('contenteditable fills confirm with value-match and expose a bounded value', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(editablePage)
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-ce-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000, actionTimeoutMs: 5_000 })
  try {
    await manager.start('owner', { url: origin + '/' })
    const before = await manager.observe('owner')
    const ce = before.nodes.find((node) => node.name === 'Rich editor')
    assert.ok(ce, JSON.stringify(before.nodes))
    assert.equal(ce.editable, true)
    assert.equal(ce.value, '', 'an empty contenteditable reports an empty value, not a missing one')

    const receipt = await manager.act('owner', { kind: 'fill', ref: ce.ref, text: 'hello contenteditable' })
    assert.equal(receipt.status, 'confirmed', JSON.stringify(receipt))
    assert.equal(receipt.verification?.kind, 'value-match', JSON.stringify(receipt.verification))
    assert.equal(receipt.dispatched, true)

    const after = await manager.observe('owner')
    const ceAfter = after.nodes.find((node) => node.name === 'Rich editor')
    assert.equal(ceAfter.value, 'hello contenteditable', 'the contenteditable carries the proof of the fill')
    assert.ok(after.nodes.some((node) => node.name === 'ce-content:hello contenteditable'), 'the page mirror proves the fill landed')

    // Same secret rules as inputs: a contenteditable inside aria-hidden is withheld.
    const hidden = after.nodes.find((node) => node.name === 'Hidden editor')
    assert.ok(hidden, JSON.stringify(after.nodes.map((n) => n.name)))
    assert.equal(hidden.valueWithheld, true, 'aria-hidden contenteditable must be withheld')
    assert.equal('value' in hidden, false)
    assert.equal(JSON.stringify(after).includes('aria-hidden-ce-secret-9K2'), false, 'the withheld text must not be serialized')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true })
  }
})
