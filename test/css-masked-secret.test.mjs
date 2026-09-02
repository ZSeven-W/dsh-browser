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

const SECRET_CSS = 'css-masked-secret-ZQ9'

// B1: a CSS-masked field (-webkit-text-security) shows bullets to the user,
// so its value must never be serialized. B2 stays covered here as the
// type-switched-password control.
const maskedPage = `<label for="masked">Card</label>
  <input id="masked" type="text" style="-webkit-text-security: disc" value="${SECRET_CSS}">
  <label for="switcher">Token</label>
  <input id="switcher" type="text" value="js-switched-secret-KW7">
  <script>document.getElementById('switcher').type = 'password'</script>`

test('CSS-masked and property-switched password fields never expose their value', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(maskedPage)
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-masked-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000 })
  try {
    await manager.start('owner', { url: origin + '/' })
    const observation = await manager.observe('owner')
    const masked = observation.nodes.find((node) => node.name === 'Card' && node.tag === 'input')
    assert.ok(masked, JSON.stringify(observation.nodes))
    assert.equal(masked.valueWithheld, true, 'the CSS-masked field must be marked withheld')
    assert.equal('value' in masked, false, 'the CSS-masked value must not be serialized')
    const switched = observation.nodes.find((node) => node.name === 'Token' && node.tag === 'input')
    assert.equal(switched.valueWithheld, true, 'a property-switched password field stays withheld')
    assert.equal(JSON.stringify(observation).includes(SECRET_CSS), false, 'the masked secret appeared in the serialized observation')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true })
  }
})
