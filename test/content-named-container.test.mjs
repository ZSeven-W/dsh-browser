import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

// QA-BL-072: the identity of a content-named CONTAINER must not depend on its
// aggregated descendant text. Wikipedia's "Part of a series on the History of
// China" sidebar — role navigation, tag table, accessible name a ~180-char
// concatenation of its descendants' text including the hide/show toggle labels
// — renames whenever any descendant's text changes, so observe({ within: <its
// ref> }) used to refuse TARGET_CHANGED although it is the same element.
//
// Fix contract:
// - every node carries nameSource ('label' for author-supplied names:
//   aria-label / aria-labelledby / title / alt / associated <label> / other
//   authored attributes; 'content' for descendant-text aggregation or empty).
// - a content-named node with a CONTENT_NAMED_CONTAINER_ROLES role has its
//   name excluded from the within / retained scope-root identity check: a
//   name-only change resolves and reports informationally (scope.nameChanged).
// - label-named nodes and act() keep the strict check (TARGET_CHANGED).

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Rejection detail of a promise that must REJECT with a DriverIssue-shaped error.
async function rejectedDetail(promise) {
  try {
    await promise
  } catch (error) {
    return {
      code: typeof error?.code === 'string' ? error.code : String(error),
      changed: Array.isArray(error?.changed) ? error.changed : undefined,
      before: error?.before,
      after: error?.after,
    }
  }
  return null
}

// A one-pixel transparent PNG so the alt image passes the visibility gate.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// The Wikipedia-shaped scenario: a role=navigation TABLE whose accessible name
// aggregates descendant text, containing a child region whose hide/show toggle
// label flips on a timer (the page script path). The same page carries the
// nameSource probes: an aria-label input, a title-attribute link (text "Qing"),
// an alt image, and a plain-text button.
const navPage = '<!doctype html><html><head><meta charset="utf-8"><title>History of China series</title></head><body>' +
  '<table role="navigation" id="series-nav" style="display:block;width:640px">' +
  '<tbody><tr><td>' +
  '<div id="toc-region" role="region" style="display:block;width:600px;height:60px">' +
  '<span>Part of a series on the History of China</span>' +
  '<button id="toggle" style="display:block;width:80px;height:24px">hide</button>' +
  '</div>' +
  '</td></tr><tr><td>Prehistory</td></tr><tr><td>Ancient</td></tr></tbody>' +
  '</table>' +
  '<input aria-label="Search by dynasty" value="Tang">' +
  '<a href="#qing" title="Qing dynasty" style="display:block;width:120px;height:24px">Qing</a>' +
  '<img id="map" role="img" alt="Qing territory map" src="' + TINY_PNG + '" style="display:block;width:40px;height:24px">' +
  '<button id="plain" style="display:block;width:120px;height:24px">Plain toggle</button>' +
  '<script>setTimeout(() => { document.getElementById("toggle").textContent = "show" }, 1500)</script>' +
  '</body></html>'

// A LABEL-named container (aria-label) whose authored label changes: identity
// really changed, so within must still refuse TARGET_CHANGED.
const labelPage = '<!doctype html><html><head><meta charset="utf-8"><title>Labeled series</title></head><body>' +
  '<table role="navigation" id="labeled" aria-label="Labeled series" style="display:block;width:640px">' +
  '<tbody><tr><td>Qin</td></tr><tr><td>Han</td></tr></tbody>' +
  '</table>' +
  '<script>setTimeout(() => { document.getElementById("labeled").setAttribute("aria-label", "Labeled series renamed") }, 1500)</script>' +
  '</body></html>'

const pages = { '/nav': navPage, '/label': labelPage }

test('a content-named container keeps its identity when its aggregated name changes', { timeout: 180_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(pages[requestUrl.pathname] ?? '<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-content-named-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/nav' })
    const whole = await manager.observe('owner')

    // The aggregated navigation table: role navigation, tag table, name a
    // concatenation of descendant text including the hide toggle label.
    const table = whole.nodes.find((node) => node.role === 'navigation' && node.tag === 'table')
    assert.ok(table, 'the whole-page view must carry the navigation table: ' + JSON.stringify(whole.nodes.map((n) => n.name)))
    assert.match(table.name, /hide/, 'the aggregated name must include the hide toggle label: ' + table.name)

    // Let the fixture flip the toggle label hide -> show: the table's
    // aggregated name changes while the element itself stays put.
    await delay(2500)

    // act() keeps the strict check: the same ref refuses TARGET_CHANGED with
    // the name diff attached.
    const receipt = await manager.act('owner', { kind: 'click', ref: table.ref })
    assert.equal(receipt.status, 'rejected', JSON.stringify(receipt))
    assert.equal(receipt.code, 'TARGET_CHANGED')
    assert.deepEqual(receipt.changed, ['name'], 'act must keep the strict name check: ' + JSON.stringify(receipt))
    assert.ok(receipt.before?.name?.includes('hide'), 'the before snapshot must carry the observed name: ' + JSON.stringify(receipt.before))
    assert.ok(receipt.after?.name?.includes('show'), 'the after snapshot must carry the live name: ' + JSON.stringify(receipt.after))

    // within on the same ref must now resolve: the name-only change is
    // informational (scope.nameChanged), never an identity break.
    const scoped = await manager.observe('owner', { within: table.ref })
    assert.ok(scoped.scope, 'the within observe must produce a scoped view')
    assert.equal(scoped.scope.role, 'navigation', JSON.stringify(scoped.scope))
    assert.equal(scoped.scope.tag, 'table', JSON.stringify(scoped.scope))
    assert.match(scoped.scope.name, /show/, 'scope.name must carry the new aggregated name: ' + scoped.scope.name)
    assert.equal(scoped.scope.nameChanged, true, 'the scoped observation must report the changed name informationally')
    const root = scoped.nodes[0]
    assert.equal(root.role, 'navigation', 'the scoped root must be the navigation table: ' + JSON.stringify(scoped.nodes.map((n) => n.name)))
    assert.match(root.name, /show/, 'the scoped root name must reflect the flipped toggle: ' + root.name)
    const toggle = scoped.nodes.find((node) => node.name === 'show')
    assert.ok(toggle, 'the flipped toggle button must be inside the scoped view')

    // nameSource pins: authored labels vs descendant-text aggregation.
    assert.equal(table.nameSource, 'content', 'a descendant-text-aggregated container must report nameSource content')
    const byName = new Map(whole.nodes.map((node) => [node.name, node]))
    assert.equal(byName.get('Search by dynasty')?.nameSource, 'label', 'an aria-label name must report nameSource label')
    assert.equal(byName.get('Qing dynasty')?.nameSource, 'label', 'a title-attribute name must report nameSource label')
    assert.equal(byName.get('Qing territory map')?.nameSource, 'label', 'an alt-attribute name must report nameSource label')
    assert.equal(byName.get('Plain toggle')?.nameSource, 'content', 'a plain-text button name must report nameSource content')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('a label-named container whose authored label changed still refuses within with TARGET_CHANGED', { timeout: 180_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(pages[requestUrl.pathname] ?? '<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-label-named-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/label' })
    const whole = await manager.observe('owner')
    const labeled = whole.nodes.find((node) => node.name === 'Labeled series')
    assert.ok(labeled, 'the whole-page view must carry the labeled container')
    assert.equal(labeled.nameSource, 'label', 'an aria-label named container must report nameSource label')
    await delay(2500)
    const refusal = await rejectedDetail(manager.observe('owner', { within: labeled.ref }))
    assert.ok(refusal, 'the within observe must reject after the authored label changed')
    assert.equal(refusal.code, 'TARGET_CHANGED')
    assert.deepEqual(refusal.changed, ['name'], JSON.stringify(refusal))
    assert.deepEqual(refusal.before, { name: 'Labeled series' })
    assert.deepEqual(refusal.after, { name: 'Labeled series renamed' })
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})
