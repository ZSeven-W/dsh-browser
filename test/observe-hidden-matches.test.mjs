import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

// Contract v9 hiddenMatches (B5): every observation reports the count of
// semantic-selector matches the visibility gate skipped within the scanned
// range, plus hiddenMatchesPartial — true whenever collection stopped early
// (scan window, node budget, or byte budget), i.e. the count is a lower
// bound. It is a diagnostic, not a truncation reason.

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

test('hiddenMatches counts gate-skipped matches; hiddenMatchesPartial marks early stops', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/phaseb') return res.end(fixtureHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-phaseb-hidden-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/phaseb' })

    // Whole page: the fixture has exactly two display:none hm buttons among
    // the scanned matches (the unassigned light child is excluded from the
    // flattened walk entirely, so the gate never sees it).
    const whole = await manager.observe('owner', { maxNodes: 100 })
    assert.equal(typeof whole.hiddenMatches, 'number', 'the whole-page observation must carry hiddenMatches')
    assert.equal(typeof whole.hiddenMatchesPartial, 'boolean', 'the whole-page observation must carry hiddenMatchesPartial')
    assert.ok(whole.hiddenMatches >= 2, 'at least two gate-skipped matches: ' + whole.hiddenMatches)
    assert.equal(whole.hiddenMatchesPartial, false, 'the fixture fits every budget whole-page')

    // A complete scoped view: exact count, not a lower bound.
    const hmRegion = whole.nodes.find((node) => node.name === 'Phase B hidden matches region')
    assert.ok(hmRegion)
    const scoped = await manager.observe('owner', { within: hmRegion.ref, maxNodes: 100 })
    assert.deepEqual(
      scoped.nodes.map((node) => node.name),
      ['Phase B hidden matches region', 'hm-visible-0', 'hm-visible-1', 'hm-visible-2'],
      'the scoped view emits the region and its three visible buttons only',
    )
    assert.equal(scoped.hiddenMatches, 2, 'exactly the two display:none buttons were gate-skipped')
    assert.equal(scoped.hiddenMatchesPartial, false, 'a subtree that fits scans every match, so the count is exact')
    assert.equal(scoped.truncated, false, 'hiddenMatches is a diagnostic, never a truncation reason')
    assert.equal(scoped.truncationReasons, undefined)

    // Node budget stops collection early: the count becomes a lower bound.
    const trimmed = await manager.observe('owner', { within: scoped.nodes[0].ref, maxNodes: 2 })
    assert.deepEqual(
      trimmed.nodes.map((node) => node.name),
      ['Phase B hidden matches region', 'hm-visible-0'],
      'the node budget stops the scoped view after two nodes',
    )
    assert.equal(trimmed.hiddenMatches, 1, 'only the first hidden match was reached before the budget stop')
    assert.equal(trimmed.hiddenMatchesPartial, true, 'a node-budget stop makes the count a lower bound')
    assert.equal(trimmed.truncated, true)
    assert.ok(trimmed.truncationReasons?.includes('node-budget-exceeded'), JSON.stringify(trimmed.truncationReasons))
    assert.ok(!trimmed.truncationReasons?.includes('hidden-matches'), 'the hidden count must never be a truncation reason: ' + JSON.stringify(trimmed.truncationReasons))
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})
