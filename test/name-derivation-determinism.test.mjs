import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import {
  BrowserManager,
  collectSemanticTargets,
  discoverInstalledBrowser,
  inspectSemanticHandle,
  normalizeAccessibleName,
} from '../lib/index.js'

// QA-BL-074: the observation-time name derivation (collectSemanticTargets'
// page-side serializer) and the live re-derivation used by #resolveTarget
// (inspectSemanticHandle) must yield BYTE-IDENTICAL accessible names for the
// same element. The historical bug: the observation path normalized the name
// twice (page-side, then again when mapping the serialized record), so a
// truncation cut landing on whitespace was trimmed by the second pass, while
// the live path normalized once and kept a trailing space — a static page
// then refused observe({ within }) / act with TARGET_CHANGED changed:['name']
// (Wikipedia's "Part of a series on the History of China" sidebar, QA-BL-071).
// One shared, idempotent normalization function now drives BOTH paths, and
// this test pins that determinism for every derivation shape.

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

const ZWSP = '\u200b' // U+200B ZERO WIDTH SPACE: invisible to \s, must be stripped
const NBSP = '\u00a0' // U+00A0 NO-BREAK SPACE: collapsed by \s, must behave like a space

// Aggregated container: a role=navigation table whose collapsed textContent is
// A*100 + ' ' + A*78 + ' ' + B*12 — 192 characters with the space at index 179,
// so the 180-character truncation cut lands exactly ON that space (the
// trailing-space class of mismatch; nested newlines and NBSP provide the
// whitespace runs). The raw textContent is fully determined by the markup.
const aggregatedSegmentA = 'A'.repeat(100)
const aggregatedSegmentB = 'A'.repeat(78)
const aggregatedSegmentC = 'B'.repeat(12)
// NOTE the whitespace runs sit INSIDE the single cell: a non-ASCII-whitespace
// text node between table cells is foster-parented out of the table by the
// HTML parser, which would silently drop the NBSP from the aggregated text.
const aggregatedHtml = '<table role="navigation" id="agg" style="display:block;width:640px"><tbody>' +
  '<tr><td>' +
  '<span>' + aggregatedSegmentA + '</span>' +
  '\n' + NBSP +
  '<span>' + aggregatedSegmentB + '</span>' +
  '\n  ' +
  '<span>' + aggregatedSegmentC + '</span>' +
  '</td></tr></tbody></table>'

// aria-label with surrounding spaces, internal double spaces, NBSP, and a
// zero-width space: must normalize to exactly 'Save Draft'.
const ariaLabel = '  Save' + NBSP + ZWSP + '  ' + NBSP + 'Draft  '

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const pageHtml = '<!doctype html><html><head><meta charset="utf-8"><title>name determinism</title></head><body>' +
  aggregatedHtml +
  '<button id="labeled" aria-label="' + ariaLabel + '" style="display:block;width:160px;height:24px">inner</button>' +
  '<a id="titled" href="#q" title="  Qing ' + NBSP + ' dynasty  " style="display:block;width:160px;height:24px">Qing</a>' +
  '<img id="imaged" role="img" alt="  Qing   territory map  " src="' + TINY_PNG + '" style="display:block;width:40px;height:24px">' +
  '<button id="inline" style="display:block;width:200px;height:32px"><span>Save \n</span><span> the </span><span>\n' + NBSP + ' draft</span></button>' +
  '</body></html>'

test('accessible names derive byte-identically on the observe and live paths', { timeout: 180_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(pageHtml)
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port

  // Path-level pin: for every collected candidate, the live re-derivation of
  // the SAME handle must produce a byte-identical name, and both must equal
  // the canonical shared normalizer applied to the raw input.
  const { path: executablePath } = await discoverInstalledBrowser()
  const browser = await chromium.launch({ executablePath, headless: true })
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-name-derivation-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    const page = await browser.newPage()
    await page.goto(origin, { waitUntil: 'load' })
    const scan = await collectSemanticTargets(page, { scanLimit: 500, maxNodes: 100 })
    assert.ok(scan.candidates.length >= 5, 'fixture must emit all five probes: ' + JSON.stringify(scan.candidates.map((c) => [c.tag, c.role])))
    for (let index = 0; index < scan.candidates.length; index += 1) {
      const observed = scan.candidates[index]
      const handle = scan.handles[index]
      assert.ok(handle, 'every candidate must retain a handle')
      const live = await inspectSemanticHandle(handle, observed.selector)
      assert.ok(live, 'the live re-derivation must resolve the retained element')
      assert.equal(live.name, observed.name,
        'live and observation names must be byte-identical for ' + observed.tag + ': '
        + JSON.stringify(observed.name) + ' vs ' + JSON.stringify(live.name))
      assert.equal(live.nameSource, observed.nameSource, 'nameSource must agree between the two paths')
    }

    // Aggregated container: >180 chars after collapse, whitespace run at the
    // truncation boundary, nested newlines + NBSP. THE case that was RED: the
    // live path used to keep the trailing space the 180-char cut left behind.
    const rawAggregated = await page.$eval('#agg', (element) => element.textContent)
    assert.ok(rawAggregated.length > 180, 'the aggregated raw text must exceed the 180-character clamp: ' + rawAggregated.length)
    const expectedAggregated = normalizeAccessibleName(rawAggregated)
    assert.equal(expectedAggregated.length, 179, 'the canonical name must be trimmed back past the cut: ' + expectedAggregated.length)
    assert.ok(!expectedAggregated.endsWith(' '), 'the canonical name must never end with a space')
    const aggObserved = scan.candidates.find((c) => c.tag === 'table' && c.role === 'navigation')
    assert.ok(aggObserved, 'the aggregated navigation table must be collected')
    assert.equal(aggObserved.name, expectedAggregated, 'observation path must apply the canonical rule')
    assert.equal(aggObserved.nameSource, 'content', 'aggregated containers are content-named')

    // aria-label with surrounding spaces, double spaces, NBSP, zero-width char.
    const rawAria = await page.$eval('#labeled', (element) => element.getAttribute('aria-label'))
    const ariaObserved = scan.candidates.find((c) => c.tag === 'button' && c.nameSource === 'label')
    assert.ok(ariaObserved, 'the aria-label button must be collected')
    assert.equal(ariaObserved.name, normalizeAccessibleName(rawAria), 'aria-label name must apply the canonical rule')
    assert.equal(ariaObserved.name, 'Save Draft', 'zero-width chars must be stripped, runs collapsed, ends trimmed')

    // title-attribute link, alt image, multi-inline button (textContent
    // aggregation across inline elements with line breaks).
    const rawTitle = await page.$eval('#titled', (element) => element.getAttribute('title'))
    const titleObserved = scan.candidates.find((c) => c.tag === 'a')
    assert.ok(titleObserved, 'the title link must be collected')
    assert.equal(titleObserved.name, normalizeAccessibleName(rawTitle), 'title name must apply the canonical rule')
    assert.equal(titleObserved.name, 'Qing dynasty')

    const rawAlt = await page.$eval('#imaged', (element) => element.getAttribute('alt'))
    const altObserved = scan.candidates.find((c) => c.tag === 'img')
    assert.ok(altObserved, 'the alt image must be collected')
    assert.equal(altObserved.name, normalizeAccessibleName(rawAlt), 'alt name must apply the canonical rule')
    assert.equal(altObserved.name, 'Qing territory map')

    const rawInline = await page.$eval('#inline', (element) => element.textContent)
    const inlineObserved = scan.candidates.find((c) => c.tag === 'button' && c.nameSource === 'content')
    assert.ok(inlineObserved, 'the multi-inline button must be collected')
    assert.equal(inlineObserved.name, normalizeAccessibleName(rawInline), 'aggregated button text must apply the canonical rule')
    assert.equal(inlineObserved.name, 'Save the draft')
    await browser.close()

    // Manager-level pin: on the same STATIC page, observe -> observe({ within })
    // must resolve with the scope name byte-identical to both the stored node
    // name and the freshly collected root name, and must NOT report nameChanged.
    // Today's RED shape was exactly this flow refusing TARGET_CHANGED.
    await manager.start('owner', { url: origin })
    const whole = await manager.observe('owner', { maxNodes: 100 })
    const table = whole.nodes.find((node) => node.role === 'navigation' && node.tag === 'table')
    assert.ok(table, 'the whole-page view must carry the aggregated table: ' + JSON.stringify(whole.nodes.map((n) => n.name)))
    const scoped = await manager.observe('owner', { within: table.ref })
    assert.ok(scoped.scope, 'the within observe must produce a scoped view')
    assert.equal(scoped.scope.nameChanged, undefined, 'a static page must not report a name change: ' + JSON.stringify(scoped.scope))
    assert.equal(scoped.scope.name, table.name, 'scope.name (live re-derivation) must be byte-identical to the stored node name')
    assert.equal(scoped.nodes[0].name, table.name, 'the freshly collected root must keep the identical name')
  } finally {
    await browser.close().catch(() => {})
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})
