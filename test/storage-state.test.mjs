import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
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

// The page reports the server-visible session cookie and the browser-visible
// localStorage entry as semantic nodes, so injection is proven through the
// driver's own observation surface.
function loginPage(cookieHeader) {
  const hasSession = /(^|;\s*)session=injected-session-token(;|$)/.test(cookieHeader ?? '')
  return `<!doctype html><html><head><title>Login fixture</title></head><body>
  <div role="status" id="cookie-status">${hasSession ? 'cookie:logged-in' : 'cookie:logged-out'}</div>
  <div role="status" id="storage-status">storage:pending</div>
  <script>
    document.getElementById('storage-status').textContent =
      'storage:' + (localStorage.getItem('qa-flag') ?? 'absent')
  </script>
</body></html>`
}

test('storage state injects cookies and localStorage into the fresh ephemeral profile', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(loginPage(req.headers.cookie))
  })
  const port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-storage-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000 })
  try {
    await manager.start('owner', {
      url: origin + '/',
      storageState: {
        cookies: [{
          name: 'session',
          value: 'injected-session-token',
          domain: '127.0.0.1',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 3600,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        }],
        origins: [{ origin, localStorage: [{ name: 'qa-flag', value: 'injected' }] }],
      },
    })
    const observation = await manager.observe('owner')
    const names = observation.nodes.map((node) => node.name)
    assert.ok(names.includes('cookie:logged-in'), 'server saw the injected session cookie: ' + JSON.stringify(names))
    assert.ok(names.includes('storage:injected'), 'page saw the injected localStorage entry: ' + JSON.stringify(names))
  } finally {
    await manager.dispose().catch(() => {})
    server.close()
  }
})

test('storage state origins outside the allowlist fail the session start closed', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-storage-deny-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: ['http://127.0.0.1:1'], observationTtlMs: 60_000 })
  try {
    await assert.rejects(
      manager.start('owner', {
        storageState: {
          cookies: [],
          origins: [{ origin: 'http://127.0.0.1:2', localStorage: [{ name: 'x', value: 'y' }] }],
        },
      }),
      /origin|allow/i,
      'storage origins must clear the same allowlist as navigation',
    )
    assert.equal(manager.activeOwners().length, 0, 'no session survives a rejected storage-state start')
  } finally {
    await manager.dispose().catch(() => {})
  }
})
