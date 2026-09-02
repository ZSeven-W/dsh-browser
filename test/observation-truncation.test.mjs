import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
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

// A1: 1 visible h1 + 499 display:none buttons + 60 visible buttons = 560 selector
// matches. The 500-match scan window covers only the h1 and the hidden buttons;
// the 60 visible buttons sit beyond it. Dropping them must set truncated.
const hiddenBulkPage = '<h1>Hidden bulk fixture</h1>' +
  Array.from({ length: 499 }, (_, i) => `<button style="display:none">ghost-${i}</button>`).join('') +
  Array.from({ length: 60 }, (_, i) => `<button>visible-${i}</button>`).join('')

// Control: 601 visible selector matches beyond the scan window.
const visibleBulkPage = '<h1>Visible bulk fixture</h1>' +
  Array.from({ length: 600 }, (_, i) => `<button>visible-${i}</button>`).join('')

// Negative: exactly 500 selector matches, all scanned; 499 are hidden. Hidden
// elements would never have been emitted, so a fully scanned page is NOT flagged.
const fullScanPage = '<h1>Full scan fixture</h1>' +
  Array.from({ length: 499 }, (_, i) => `<button style="display:none">ghost-${i}</button>`).join('')

test('truncated flags visible matches dropped by the scan window, not scanned hidden matches', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/hidden-bulk') return res.end(hiddenBulkPage)
    if (requestUrl.pathname === '/visible-bulk') return res.end(visibleBulkPage)
    if (requestUrl.pathname === '/full-scan') return res.end(fullScanPage)
    res.end('<h1>Index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-truncation-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000 })
  try {
    await manager.start('owner', { url: origin + '/hidden-bulk' })
    const hiddenBulk = await manager.observe('owner', { maxNodes: 100 })
    assert.equal(hiddenBulk.truncated, true, 'visible buttons beyond the scan window must set truncated: ' + JSON.stringify({
      truncated: hiddenBulk.truncated,
      nodeCount: hiddenBulk.nodes.length,
      visibleReturned: hiddenBulk.nodes.filter((n) => n.name.startsWith('visible-')).length,
    }))
    assert.ok(hiddenBulk.truncationReasons?.includes('scan-window-exceeded'), 'reason must name the scan window: ' + JSON.stringify(hiddenBulk.truncationReasons))

    await manager.act('owner', { kind: 'navigate', url: origin + '/visible-bulk' })
    const visibleBulk = await manager.observe('owner', { maxNodes: 100 })
    assert.equal(visibleBulk.truncated, true, '601 visible matches exceed the scan window and must be flagged')
    assert.ok(visibleBulk.truncationReasons?.includes('scan-window-exceeded'), JSON.stringify(visibleBulk.truncationReasons))

    await manager.act('owner', { kind: 'navigate', url: origin + '/full-scan' })
    const fullScan = await manager.observe('owner', { maxNodes: 100 })
    assert.equal(fullScan.truncated, false, 'a fully scanned page with hidden elements must not be flagged: ' + JSON.stringify({
      truncated: fullScan.truncated,
      nodeCount: fullScan.nodes.length,
      reasons: fullScan.truncationReasons,
    }))
    assert.equal(fullScan.nodes.length, 1, 'only the visible h1 is emitted')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true })
  }
})
