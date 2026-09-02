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

const TOKEN = 'jsontoken-zzz-123'

// F2: JSON-shaped credentials ("authorization":"…") must be redacted exactly
// like the classic Authorization=Bearer form.
const evidencePage = `<h1>Evidence fixture</h1>
  <script>
    console.log('classic Authorization=Bearer topsecret-abc')
    console.log('json-style {"authorization":"${TOKEN}"}')
  </script>`

test('JSON-shaped authorization text is redacted from evidence', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(evidencePage)
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-redaction-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000 })
  try {
    await manager.start('owner', { url: origin + '/' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const evidence = await manager.evidence('owner', { maxConsole: 20 })
    const encoded = JSON.stringify(evidence)
    assert.equal(encoded.includes(TOKEN), false, 'the JSON-shaped token must be redacted: ' + encoded)
    assert.equal(encoded.includes('topsecret-abc'), false, 'the classic token must stay redacted')
    const jsonLine = evidence.console.find((item) => item.text.includes('json-style'))
    assert.ok(jsonLine, 'the json-style line is retained, redacted')
    assert.ok(jsonLine.text.includes('[REDACTED]'), 'the redaction marker must be present: ' + jsonLine.text)
    assert.match(jsonLine.text, /"authorization"\s*:\s*"\[REDACTED\]"/u, 'the JSON shape must survive redaction: ' + jsonLine.text)
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true })
  }
})
