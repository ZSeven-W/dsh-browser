import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

// QA-BL-071: a TARGET_CHANGED refusal must say WHAT changed. The receipt (and
// the DriverIssue a within/anchor refusal throws) carries the field-level diff:
// 'changed' (stable order) plus 'before'/'after' for the safe subset (role,
// name, tag, disabled, visible). Detachment reports changed: ['detached'] and
// no snapshots. Value changes on secure/editable fields never appear.

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

const pages = {
  '/rename': '<!doctype html><html><head><title>Rename fixture</title></head><body>' +
    '<a id="t" href="#target">Alpha</a>' +
    '<script>setTimeout(() => { document.getElementById("t").textContent = "Beta" }, 1200)</script>' +
    '</body></html>',
  '/hide': '<!doctype html><html><head><title>Hide fixture</title></head><body>' +
    '<a id="t" href="#target">Gamma</a>' +
    '<script>setTimeout(() => { document.getElementById("t").style.display = "none" }, 1200)</script>' +
    '</body></html>',
  '/detach': '<!doctype html><html><head><title>Detach fixture</title></head><body>' +
    '<a id="t" href="#target">Delta</a>' +
    '<script>setTimeout(() => { document.getElementById("t").remove() }, 1200)</script>' +
    '</body></html>',
  '/secret': '<!doctype html><html><head><title>Secret fixture</title></head><body>' +
    '<input id="pw" type="password" aria-label="Secret field" value="before-secret">' +
    '<script>setTimeout(() => {' +
    '  const el = document.getElementById("pw");\n' +
    '  el.value = "after-secret";\n' +
    '  el.setAttribute("aria-label", "Renamed secret field");\n' +
    '}, 1200)</script>' +
    '</body></html>',
  '/value': '<!doctype html><html><head><title>Value drift fixture</title></head><body>' +
    '<input id="v" aria-label="Value drift field" value="one">' +
    '<script>setTimeout(() => { document.getElementById("v").value = "two" }, 1200)</script>' +
    '</body></html>',
  '/scope': '<!doctype html><html><head><title>Scope fixture</title></head><body>' +
    '<div id="region" role="region" aria-label="Scope root" style="height:40px"><button>Inside</button></div>' +
    '<script>setTimeout(() => { document.getElementById("region").setAttribute("aria-label", "Scope root renamed") }, 1200)</script>' +
    '</body></html>',
}

test('TARGET_CHANGED refusals name every changed field with safe before/after snapshots', { timeout: 180_000 }, async (t) => {
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
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-changed-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })

  try {
    await manager.start('owner', { url: origin + '/rename' })

    // Renamed link: the fingerprint mismatch names 'name' with both values.
    {
      const observation = await manager.observe('owner')
      const target = observation.nodes.find((node) => node.name === 'Alpha')
      assert.ok(target)
      await delay(2000)
      const receipt = await manager.act('owner', { kind: 'click', ref: target.ref })
      assert.equal(receipt.status, 'rejected', JSON.stringify(receipt))
      assert.equal(receipt.code, 'TARGET_CHANGED')
      assert.deepEqual(receipt.changed, ['name'], 'changed must list exactly the renamed field: ' + JSON.stringify(receipt))
      assert.deepEqual(receipt.before, { name: 'Alpha' })
      assert.deepEqual(receipt.after, { name: 'Beta' })
    }

    // Hidden link: display:none flips the visibility field.
    {
      await manager.act('owner', { kind: 'navigate', url: origin + '/hide' })
      const observation = await manager.observe('owner')
      const target = observation.nodes.find((node) => node.name === 'Gamma')
      assert.ok(target)
      await delay(2000)
      const receipt = await manager.act('owner', { kind: 'click', ref: target.ref })
      assert.equal(receipt.status, 'rejected', JSON.stringify(receipt))
      assert.equal(receipt.code, 'TARGET_CHANGED')
      assert.ok(Array.isArray(receipt.changed) && receipt.changed.includes('visible'), 'changed must include the visibility field: ' + JSON.stringify(receipt))
      assert.equal(receipt.before?.visible, true)
      assert.equal(receipt.after?.visible, false)
    }

    // Detached link: the refusal reports detachment and carries no snapshots.
    {
      await manager.act('owner', { kind: 'navigate', url: origin + '/detach' })
      const observation = await manager.observe('owner')
      const target = observation.nodes.find((node) => node.name === 'Delta')
      assert.ok(target)
      await delay(2000)
      const receipt = await manager.act('owner', { kind: 'click', ref: target.ref })
      assert.equal(receipt.status, 'rejected', JSON.stringify(receipt))
      assert.equal(receipt.code, 'TARGET_CHANGED')
      assert.deepEqual(receipt.changed, ['detached'])
      assert.equal(receipt.before, undefined)
      assert.equal(receipt.after, undefined)
    }

    // Secure field: the renamed accessible name is reported, the VALUE change
    // never appears in the snapshots (redaction rules unchanged).
    {
      await manager.act('owner', { kind: 'navigate', url: origin + '/secret' })
      const observation = await manager.observe('owner')
      const target = observation.nodes.find((node) => node.name === 'Secret field')
      assert.ok(target)
      assert.equal(target.valueWithheld, true, 'password values must stay withheld')
      await delay(2000)
      const receipt = await manager.act('owner', { kind: 'click', ref: target.ref })
      assert.equal(receipt.status, 'rejected', JSON.stringify(receipt))
      assert.equal(receipt.code, 'TARGET_CHANGED')
      assert.deepEqual(receipt.changed, ['name'], 'only the renamed name may be reported: ' + JSON.stringify(receipt))
      assert.deepEqual(receipt.before, { name: 'Secret field' })
      assert.deepEqual(receipt.after, { name: 'Renamed secret field' })
      const serialized = JSON.stringify(receipt)
      assert.doesNotMatch(serialized, /before-secret|after-secret/, 'secret values must never reach the receipt')
      assert.equal('value' in (receipt.before ?? {}), false, 'a value snapshot must never appear')
      assert.equal('editable' in (receipt.before ?? {}), false, 'an editable snapshot must never appear')
    }

    // Value-only drift on an editable control: values stay out of the identity
    // check, so the act resolves normally (no TARGET_CHANGED at all).
    {
      await manager.act('owner', { kind: 'navigate', url: origin + '/value' })
      const observation = await manager.observe('owner')
      const target = observation.nodes.find((node) => node.name === 'Value drift field')
      assert.ok(target)
      assert.equal(target.value, 'one')
      await delay(2000)
      const receipt = await manager.act('owner', { kind: 'click', ref: target.ref })
      assert.equal(receipt.status, 'confirmed', JSON.stringify(receipt))
      assert.equal(receipt.changed, undefined)
    }

    // Within resolution: the same check on a scoped root's name change rejects
    // the observe with the DriverIssue carrying the same fields.
    {
      await manager.act('owner', { kind: 'navigate', url: origin + '/scope' })
      const observation = await manager.observe('owner')
      const region = observation.nodes.find((node) => node.name === 'Scope root')
      assert.ok(region)
      await delay(2000)
      const refusal = await rejectedDetail(manager.observe('owner', { within: region.ref }))
      assert.ok(refusal, 'the within observe must reject after the root was renamed')
      assert.equal(refusal.code, 'TARGET_CHANGED')
      assert.deepEqual(refusal.changed, ['name'], JSON.stringify(refusal))
      assert.deepEqual(refusal.before, { name: 'Scope root' })
      assert.deepEqual(refusal.after, { name: 'Scope root renamed' })
    }

    // The session stays healthy after every refusal.
    const finalObservation = await manager.observe('owner')
    assert.ok(finalObservation.nodes.some((node) => node.name === 'Scope root renamed'), 'a fresh whole-page observe still works')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true })
  }
})

