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

const longPage = `<!doctype html><html><head><title>Long page</title></head><body>
  <h1>Long page</h1>
  <div style="height:1260px"></div>
  <button id="deep-target" onclick="document.getElementById('deep-status').textContent='deep-clicked'">Deep target</button>
  <div role="status" id="deep-status">not-clicked</div>
  <div style="height:700px"></div>
</body></html>`

const selectPage = `<!doctype html><html><head><title>Select fixture</title></head><body>
  <label for="color">Color</label>
  <select id="color">
    <option value="">Pick a color</option>
    <option value="hex-f00" label="Bright red">Red</option>
    <option value="green" label="Green (safe)">Green</option>
    <option value="blue">Blue</option>
    <option value="dup1">Duplicate</option>
    <option value="dup2">Duplicate</option>
  </select>
  <button id="not-a-select">I am not a select</button>
  <div role="status" id="color-status">none</div>
  <script>
    document.getElementById('color').addEventListener('change', function () {
      document.getElementById('color-status').textContent = 'selected:' + this.value
    })
  </script>
</body></html>`

const hoverPage = `<!doctype html><html><head><title>Hover fixture</title>
  <style>.menu-wrap{display:inline-block}.submenu{display:none}.menu-wrap:hover .submenu{display:block}</style>
</head><body>
  <div class="menu-wrap">
    <button id="menu-trigger">Account</button>
    <div class="submenu">
      <a id="settings-link" href="#settings" onclick="document.getElementById('hover-status').textContent='settings-opened'; return false">Settings</a>
    </div>
  </div>
  <div role="status" id="hover-status">closed</div>
</body></html>`

test('scroll, select, and hover actions reach and mutate real page state', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/long') return res.end(longPage)
    if (requestUrl.pathname === '/select') return res.end(selectPage)
    if (requestUrl.pathname === '/hover') return res.end(hoverPage)
    res.end('<!doctype html><html><head><title>Index</title></head><body><h1>Index</h1></body></html>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-actions-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000 })
  try {
    await manager.start('owner', { url: origin + '/long' })

    // --- scroll by ref: the primary reachability verb ---
    const initial = await manager.observe('owner')
    const deep = initial.nodes.find((node) => node.name === 'Deep target')
    assert.ok(deep)
    assert.equal(deep.inViewport, false, 'deep target starts below the fold')

    const beforeScroll = await manager.act('owner', { kind: 'click', ref: deep.ref })
    assert.equal(beforeScroll.status, 'rejected', JSON.stringify(beforeScroll))
    assert.equal(beforeScroll.code, 'TARGET_OCCLUDED')

    const scrolled = await manager.act('owner', { kind: 'scroll', ref: deep.ref })
    assert.equal(scrolled.status, 'confirmed', JSON.stringify(scrolled))
    assert.equal(scrolled.verification.kind, 'browser-dispatch')

    // A dispatched scroll invalidates the observation: stale refs are refused.
    const staleReuse = await manager.act('owner', { kind: 'click', ref: deep.ref })
    assert.equal(staleReuse.status, 'rejected')
    assert.equal(staleReuse.code, 'OBSERVATION_REQUIRED')

    const afterScroll = await manager.observe('owner')
    const deepInView = afterScroll.nodes.find((node) => node.name === 'Deep target')
    assert.ok(deepInView)
    assert.equal(deepInView.inViewport, true, 'deep target enters the viewport after scroll')

    const capture = await manager.visualObserve('owner')
    assert.ok(capture.marks.some((mark) => mark.ref === deepInView.ref), 'visual capture marks the newly-visible target')
    assert.equal(capture.omitted.some((entry) => entry.ref === deepInView.ref), false, 'target is no longer omitted as off-viewport')

    const clicked = await manager.act('owner', { kind: 'click', ref: deepInView.ref })
    assert.equal(clicked.status, 'confirmed', JSON.stringify(clicked))
    const afterClick = await manager.observe('owner')
    assert.ok(afterClick.nodes.some((node) => node.name === 'deep-clicked'), 'click effect is visible by re-observation')

    // --- scroll by direction: exploratory paging without a ref ---
    await manager.act('owner', { kind: 'navigate', url: origin + '/long' })
    const topObserve = await manager.observe('owner')
    assert.equal(topObserve.nodes.find((node) => node.name === 'Deep target').inViewport, false)

    const pageDown = await manager.act('owner', { kind: 'scroll', direction: 'down', amount: 'page' })
    assert.equal(pageDown.status, 'confirmed', JSON.stringify(pageDown))
    assert.match(pageDown.verification.detail, /scrollY 0 -> [1-9]/, 'a full page-down actually moved the viewport')
    const afterDown = await manager.observe('owner')
    assert.equal(afterDown.nodes.find((node) => node.name === 'Deep target').inViewport, true, 'one page-down reveals the target')

    const pageUp = await manager.act('owner', { kind: 'scroll', direction: 'up', amount: 'page' })
    assert.equal(pageUp.status, 'confirmed', JSON.stringify(pageUp))
    const afterUp = await manager.observe('owner')
    assert.equal(afterUp.nodes.find((node) => node.name === 'Deep target').inViewport, false, 'page-up hides the target again')

    // --- failed receipt: scroll to an unreachable ref ---
    await manager.act('owner', { kind: 'navigate', url: origin + '/long' })
    await manager.observe('owner')
    const badScroll = await manager.act('owner', { kind: 'scroll', ref: 'br_bogus_ref' })
    assert.equal(badScroll.status, 'failed', JSON.stringify(badScroll))
    assert.equal(badScroll.code, 'REF_UNKNOWN')
    assert.ok(badScroll.reason)

    // --- select: label-first, value-second, and honest failures ---
    await manager.act('owner', { kind: 'navigate', url: origin + '/select' })
    let obs = await manager.observe('owner')
    let sel = obs.nodes.find((node) => node.tag === 'select')
    assert.ok(sel)

    const labelSelect = await manager.act('owner', { kind: 'select', ref: sel.ref, option: 'Bright red' })
    assert.equal(labelSelect.status, 'confirmed', JSON.stringify(labelSelect))
    assert.equal(labelSelect.verification.kind, 'option-match')
    obs = await manager.observe('owner')
    assert.ok(obs.nodes.some((node) => node.name === 'selected:hex-f00'), 'label match selected the right value')

    sel = obs.nodes.find((node) => node.tag === 'select')
    const valueSelect = await manager.act('owner', { kind: 'select', ref: sel.ref, option: 'blue' })
    assert.equal(valueSelect.status, 'confirmed', JSON.stringify(valueSelect))
    obs = await manager.observe('owner')
    assert.ok(obs.nodes.some((node) => node.name === 'selected:blue'), 'exact value match selected the right value')

    sel = obs.nodes.find((node) => node.tag === 'select')
    const missing = await manager.act('owner', { kind: 'select', ref: sel.ref, option: 'purple' })
    assert.equal(missing.status, 'failed', JSON.stringify(missing))
    assert.equal(missing.code, 'SELECT_OPTION_MISSING')
    assert.ok(missing.reason)

    const ambiguous = await manager.act('owner', { kind: 'select', ref: sel.ref, option: 'Duplicate' })
    assert.equal(ambiguous.status, 'failed', JSON.stringify(ambiguous))
    assert.equal(ambiguous.code, 'SELECT_OPTION_AMBIGUOUS')
    assert.ok(ambiguous.reason)

    const buttonNode = obs.nodes.find((node) => node.name === 'I am not a select')
    assert.ok(buttonNode)
    const notSelect = await manager.act('owner', { kind: 'select', ref: buttonNode.ref, option: 'anything' })
    assert.equal(notSelect.status, 'failed', JSON.stringify(notSelect))
    assert.equal(notSelect.code, 'SELECT_NOT_SELECT')
    assert.ok(notSelect.reason)

    // --- hover: reveal a submenu link, then click it ---
    await manager.act('owner', { kind: 'navigate', url: origin + '/hover' })
    const preHover = await manager.observe('owner')
    const trigger = preHover.nodes.find((node) => node.name === 'Account')
    assert.ok(trigger)
    assert.equal(preHover.nodes.some((node) => node.name === 'Settings'), false, 'submenu link is hidden before hover')

    const hovered = await manager.act('owner', { kind: 'hover', ref: trigger.ref })
    assert.equal(hovered.status, 'confirmed', JSON.stringify(hovered))
    assert.equal(hovered.verification.kind, 'browser-dispatch')

    const postHover = await manager.observe('owner')
    const settings = postHover.nodes.find((node) => node.name === 'Settings')
    assert.ok(settings, 'submenu link is observable after hover')
    assert.equal(settings.inViewport, true)

    const settingsClick = await manager.act('owner', { kind: 'click', ref: settings.ref })
    assert.equal(settingsClick.status, 'confirmed', JSON.stringify(settingsClick))
    const postClick = await manager.observe('owner')
    assert.ok(postClick.nodes.some((node) => node.name === 'settings-opened'), 'submenu link click effect is visible by re-observation')
  } finally {
    await manager.dispose()
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    const leftovers = await readdir(rootDir)
    assert.deepEqual(leftovers, [])
    await rm(rootDir, { recursive: true, force: true })
  }
})
