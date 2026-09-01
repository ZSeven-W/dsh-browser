import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserManager, discoverInstalledBrowser, publicSemanticNode, semanticFingerprint } from '../lib/index.js'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

const fillPage = `<!doctype html><html><head><title>Fill fixture</title></head><body>
  <h1>Fill fixture</h1>
  <label for="q">Search</label>
  <input id="q">
  <label for="notes">Notes</label>
  <textarea id="notes"></textarea>
  <label for="agree">Agree</label>
  <input id="agree" type="checkbox">
  <button id="continue">Continue</button>
  <div role="slider" tabindex="0" aria-label="Volume" aria-valuenow="42" style="width:80px;height:12px;background:#ccc"></div>
  <div role="slider" tabindex="0" aria-label="Speed" aria-valuenow="3" aria-valuetext="Fast" style="width:80px;height:12px;background:#ccc"></div>
</body></html>`

const selectPage = `<!doctype html><html><head><title>Select fixture</title></head><body>
  <label for="color">Color</label>
  <select id="color">
    <option value="">Pick a color</option>
    <option value="hex-f00" label="Bright red">Red</option>
    <option>Sea green</option>
  </select>
</body></html>`

// Every secret below is a distinct literal so the payload scan cannot pass by accident.
const SECRETS = [
  'hunter2-super-secret-9f3a',
  'otp-441122-do-not-capture',
  'newpass-b7c1-never-observed',
  '4111111111111111-masked-pan',
]

const secretPage = `<!doctype html><html><head><title>Secret fixture</title></head><body>
  <label for="pw">Passphrase</label>
  <input id="pw" type="password" value="${SECRETS[0]}">
  <label for="otp">Verification code</label>
  <input id="otp" autocomplete="one-time-code" value="${SECRETS[1]}">
  <label for="np">New passphrase</label>
  <input id="np" type="text" autocomplete="new-password" value="${SECRETS[2]}">
  <div aria-hidden="true">
    <input id="masked" aria-label="Masked card number" value="${SECRETS[3]}">
  </div>
  <label for="nickname">Nickname</label>
  <input id="nickname" value="not-a-secret-nickname">
</body></html>`

const bulkPage = `<!doctype html><html><head><title>Bulk fixture</title></head><body>
  <h1>Bulk fixture</h1>
  ${Array.from({ length: 45 }, (_, index) => `<textarea aria-label="Bulk field ${index}" rows="1"></textarea>`).join('')}
  <script>
    for (const field of document.querySelectorAll('textarea')) field.value = 'y'.repeat(5000)
  </script>
</body></html>`

const driftPage = `<!doctype html><html><head><title>Drift fixture</title></head><body>
  <input id="drift" aria-label="Live counter field" value="tick-0">
  <script>
    var ticks = 0
    setInterval(function () {
      ticks += 1
      document.getElementById('drift').value = 'tick-' + ticks
    }, 60)
  </script>
</body></html>`

test('the observation carries bounded editable values and never a secret', { timeout: 180_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/fill') return res.end(fillPage)
    if (requestUrl.pathname === '/select') return res.end(selectPage)
    if (requestUrl.pathname === '/secret') return res.end(secretPage)
    if (requestUrl.pathname === '/bulk') return res.end(bulkPage)
    if (requestUrl.pathname === '/drift') return res.end(driftPage)
    res.end('<!doctype html><html><head><title>Index</title></head><body><h1>Index</h1></body></html>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-values-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000 })
  try {
    // --- a filled text input proves the fill through its own value ---
    await manager.start('owner', { url: origin + '/fill' })
    const before = await manager.observe('owner')
    const emptySearch = before.nodes.find((node) => node.name === 'Search' && node.tag === 'input')
    assert.ok(emptySearch, JSON.stringify(before.nodes))
    assert.equal(emptySearch.value, '', 'an empty editable field reports an empty value, not a missing one')
    assert.equal('value' in emptySearch, true)
    assert.equal(emptySearch.valueWithheld, undefined)
    assert.equal(emptySearch.valueTruncated, undefined)

    const filled = await manager.act('owner', { kind: 'fill', ref: emptySearch.ref, text: 'DeepSeek' })
    assert.equal(filled.status, 'confirmed', JSON.stringify(filled))
    const afterFill = await manager.observe('owner')
    const search = afterFill.nodes.find((node) => node.name === 'Search' && node.tag === 'input')
    assert.equal(search.value, 'DeepSeek', 'the target itself carries the proof of the fill')

    // A textarea value is whitespace-compacted exactly like an accessible name.
    const notes = afterFill.nodes.find((node) => node.name === 'Notes' && node.tag === 'textarea')
    assert.ok(notes)
    const multiline = await manager.act('owner', { kind: 'fill', ref: notes.ref, text: 'line one\nline two' })
    assert.equal(multiline.status, 'confirmed', JSON.stringify(multiline))
    const afterNotes = await manager.observe('owner')
    const filledNotes = afterNotes.nodes.find((node) => node.name === 'Notes' && node.tag === 'textarea')
    assert.equal(filledNotes.value, 'line one line two')

    // Value-less controls stay value-less: no value, and no withheld marker either.
    const button = afterNotes.nodes.find((node) => node.name === 'Continue')
    assert.ok(button)
    assert.equal('value' in button, false, 'a button label is already the name; it is not a value')
    assert.equal(button.valueWithheld, undefined)
    const checkbox = afterNotes.nodes.find((node) => node.name === 'Agree' && node.tag === 'input')
    assert.ok(checkbox)
    assert.equal('value' in checkbox, false, 'checkedness is not modelled as a value')

    // ARIA range widgets expose their announced value, valuetext winning over valuenow.
    const volume = afterNotes.nodes.find((node) => node.name === 'Volume')
    assert.equal(volume.value, '42')
    const speed = afterNotes.nodes.find((node) => node.name === 'Speed')
    assert.equal(speed.value, 'Fast')

    // --- a select reports the selected option ---
    await manager.act('owner', { kind: 'navigate', url: origin + '/select' })
    const selectStart = await manager.observe('owner')
    const emptySelect = selectStart.nodes.find((node) => node.tag === 'select')
    assert.ok(emptySelect)
    assert.equal(emptySelect.value, '', 'the placeholder option has an empty value')

    const chose = await manager.act('owner', { kind: 'select', ref: emptySelect.ref, option: 'Bright red' })
    assert.equal(chose.status, 'confirmed', JSON.stringify(chose))
    const afterChoice = await manager.observe('owner')
    const chosen = afterChoice.nodes.find((node) => node.tag === 'select')
    assert.equal(chosen.value, 'hex-f00', 'the select carries the chosen option value')

    // An option without a value attribute reports its text, exactly as HTML defines.
    const chosePlain = await manager.act('owner', { kind: 'select', ref: chosen.ref, option: 'Sea green' })
    assert.equal(chosePlain.status, 'confirmed', JSON.stringify(chosePlain))
    const afterPlain = await manager.observe('owner')
    assert.equal(afterPlain.nodes.find((node) => node.tag === 'select').value, 'Sea green')

    // --- secrets are withheld, explicitly, and never serialized anywhere ---
    await manager.act('owner', { kind: 'navigate', url: origin + '/secret' })
    const secrets = await manager.observe('owner')
    for (const name of ['Passphrase', 'Verification code', 'New passphrase', 'Masked card number']) {
      // A <label> carries the same accessible name as its control, so match the control itself.
      const node = secrets.nodes.find((entry) => entry.name === name && entry.tag === 'input')
      assert.ok(node, `missing secret-bearing node ${name}: ${JSON.stringify(secrets.nodes)}`)
      assert.equal(node.valueWithheld, true, `${name} must be marked as withheld`)
      assert.equal('value' in node, false, `${name} must not carry a value`)
    }
    const nickname = secrets.nodes.find((node) => node.name === 'Nickname' && node.tag === 'input')
    assert.equal(nickname.value, 'not-a-secret-nickname', 'withholding is targeted, not blanket')

    const payload = JSON.stringify(secrets)
    for (const secret of SECRETS) {
      assert.equal(payload.includes(secret), false, 'a secret value appeared in the serialized observation')
    }

    // --- long values are bounded and cannot blow up the observation ---
    await manager.act('owner', { kind: 'navigate', url: origin + '/bulk' })
    const bulk = await manager.observe('owner', { maxNodes: 100 })
    const bulkNodes = bulk.nodes.filter((node) => node.name.startsWith('Bulk field'))
    assert.equal(bulkNodes.length, 45, 'every bulk field survived the byte budget')
    for (const node of bulkNodes) {
      assert.equal(node.value.length, 180)
      assert.equal(node.valueTruncated, true, 'a clipped value announces that it is a prefix')
    }
    const bulkBytes = Buffer.byteLength(JSON.stringify(bulk), 'utf8')
    assert.equal(bulkBytes < bulk.limits.maxBytes, true, `observation grew to ${bulkBytes} bytes`)

    // --- a value that changes on its own does not invalidate the ref ---
    await manager.act('owner', { kind: 'navigate', url: origin + '/drift' })
    const drifting = await manager.observe('owner')
    const driftNode = drifting.nodes.find((node) => node.name === 'Live counter field' && node.tag === 'input')
    assert.ok(driftNode)
    assert.match(driftNode.value, /^tick-\d+$/u)

    await delay(600)
    const hovered = await manager.act('owner', { kind: 'hover', ref: driftNode.ref })
    assert.equal(hovered.status, 'confirmed', JSON.stringify(hovered))

    const drifted = await manager.observe('owner')
    const driftedNode = drifted.nodes.find((node) => node.name === 'Live counter field' && node.tag === 'input')
    assert.match(driftedNode.value, /^tick-\d+$/u)
    assert.equal(
      Number(driftedNode.value.slice(5)) > Number(driftNode.value.slice(5)),
      true,
      'the page really rewrote the value between the two observations',
    )
  } finally {
    await manager.dispose()
    await rm(rootDir, { recursive: true, force: true })
    await new Promise((resolve) => server.close(resolve))
  }
})

test('value fields stay out of the identity fingerprint and the public node', () => {
  const base = {
    selector: 'html > body:nth-of-type(1) > input:nth-of-type(1)',
    role: 'textbox',
    name: 'Search',
    tag: 'input',
    inputType: 'text',
    interactive: true,
    editable: true,
    disabled: false,
    inViewport: true,
    download: false,
  }
  const empty = semanticFingerprint({ ...base, value: '' })
  assert.equal(semanticFingerprint({ ...base, value: 'DeepSeek' }), empty)
  assert.equal(semanticFingerprint({ ...base, value: 'x'.repeat(180), valueTruncated: true }), empty)
  assert.equal(semanticFingerprint({ ...base, valueWithheld: true }), empty)
  assert.notEqual(semanticFingerprint({ ...base, name: 'Something else' }), empty)

  const stored = { ...base, ref: 'br_fixture', fingerprint: empty }
  assert.equal(publicSemanticNode({ ...stored, value: 'DeepSeek' }).value, 'DeepSeek')
  assert.equal('selector' in publicSemanticNode({ ...stored, value: 'DeepSeek' }), false)

  // A withheld value is never accompanied by the value itself, even if one leaked into the target.
  const withheld = publicSemanticNode({ ...stored, value: 'leaked', valueWithheld: true })
  assert.equal(withheld.valueWithheld, true)
  assert.equal('value' in withheld, false)

  const none = publicSemanticNode(stored)
  assert.equal('value' in none, false)
  assert.equal('valueWithheld' in none, false)
})
