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

// A2: any iframe (same-origin included) must set truncated plus the
// iframe-not-traversed marker. Open shadow roots remain covered.
test('iframe content is out of scope and the observation says so', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/embedded') {
      res.end(`<h1>Embedded fixture</h1>
  <button>main-frame-button</button>
  <iframe id="f" src="/frame" style="width:600px;height:300px"></iframe>
  <div id="host"></div>
  <script>
    const root = document.getElementById('host').attachShadow({ mode: 'open' })
    root.innerHTML = '<button style="display:inline-block;width:200px;height:40px">shadow-button</button>'
  </script>`)
      return
    }
    if (requestUrl.pathname === '/frame') return res.end('<button>iframe-button</button>')
    res.end('<h1>Index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-iframe-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000 })
  try {
    await manager.start('owner', { url: origin + '/embedded' })
    await new Promise((resolve) => setTimeout(resolve, 500)) // let iframe + shadow render
    const observation = await manager.observe('owner')
    const names = observation.nodes.map((node) => node.name)
    assert.equal(observation.truncated, true, 'an iframe on the page must set truncated')
    assert.ok(observation.truncationReasons?.includes('iframe-not-traversed'), 'reason must name iframe-not-traversed: ' + JSON.stringify(observation.truncationReasons))
    assert.ok(names.includes('main-frame-button'), 'main frame is still projected: ' + JSON.stringify(names))
    assert.ok(names.includes('shadow-button'), 'open shadow roots remain covered: ' + JSON.stringify(names))
    assert.equal(names.includes('iframe-button'), false, 'iframe content must not appear in the projection')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true })
  }
})
