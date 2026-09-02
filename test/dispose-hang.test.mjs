import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

function fakePage() {
  return {
    url: () => 'about:blank',
    title: async () => '',
    viewportSize: () => ({ width: 1280, height: 800 }),
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    on() {},
    goto: async () => {},
  }
}

function hangingContext() {
  return {
    pages: () => [],
    newPage: async () => fakePage(),
    route: async () => {},
    on() {},
    browser: () => ({ version: () => 'fixture' }),
    newCDPSession: async () => ({
      send: async () => ({ processInfo: [{ type: 'browser', id: 4_242_424 }] }),
      detach: async () => {},
      on() {},
    }),
    // The hung close this test exists for: context.close() never resolves.
    close: () => new Promise(() => {}),
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

// H3: dispose()/stop() must settle within a bound even when an in-flight
// navigation targets an endpoint that never answers. The bound is enforced by
// racing context.close() and force-killing the browser process on timeout;
// the profile directory must still be deleted.
//
// Deterministic companion: a context whose close() never resolves exercises
// the FORCED path itself (bounded race -> force kill -> profile removal) and
// pins the reported forced flag on the stop result.
test('dispose settles within a bound against a never-answering navigation and deletes the profile', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    if (requestUrl.pathname === '/never') return // never responds; keep the socket open
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<h1>Home</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-hang-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin] })
  const t0 = Date.now()
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`
  console.log('H3: racing dispose against an in-flight never-answering navigation')
  try {
    await manager.start('h3', { url: origin + '/home' })
    await manager.observe('h3')
    const navPromise = manager.act('h3', { kind: 'navigate', url: origin + '/never' })
      .then((receipt) => ({ status: receipt.status, code: receipt.code, settledAt: stamp() }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const disposeStarted = stamp()
    console.log(`H3: dispose() called at ${disposeStarted}`)
    const disposeOutcome = await Promise.race([
      manager.dispose().then(() => 'settled'),
      delay(20_000).then(() => 'timeout'),
    ])
    console.log(`H3: dispose outcome "${disposeOutcome}" at ${stamp()} (called at ${disposeStarted})`)
    assert.equal(disposeOutcome, 'settled', 'dispose must settle within the 20s bound even with an in-flight never-answering navigation')
    const leftovers = await readdir(rootDir)
    assert.deepEqual(leftovers, [], 'the forced-close path must still delete the profile directory')
    const receipt = await Promise.race([navPromise, delay(10_000).then(() => 'nav still pending')])
    console.log(`H3: raced navigation receipt ${JSON.stringify(receipt)}`)
    assert.notEqual(receipt, 'nav still pending', 'the raced navigation must also settle once the browser is killed')
  } finally {
    server.closeAllConnections?.()
    // RED-mode safety: before the fix the stuck context.close() leaves the
    // browser process alive and the runner would never exit. Killing the
    // process by its profile path (as the audit's H1 probe does) unblocks the
    // memoized dispose promise so the failing test can terminate.
    const { execSync } = await import('node:child_process')
    try { execSync("pkill -f '" + rootDir + "'", { stdio: 'ignore' }) } catch { /* no matching process */ }
    await Promise.race([manager.dispose().catch(() => {}), delay(10_000)])
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('stop() bounds a never-resolving context.close(), reports the forced kill, and deletes the profile', { timeout: 30_000 }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-forced-close-'))
  const manager = new BrowserManager({
    rootDir,
    discoverBrowser: async () => ({ path: '/fixture/browser', channel: 'custom' }),
    launchPersistentContext: async () => hangingContext(),
  })
  const t0 = Date.now()
  try {
    await manager.start('owner')
    const result = await manager.stop('owner')
    const elapsedMs = Date.now() - t0
    console.log('H3-unit: stop() with a never-resolving close settled in ' + elapsedMs + 'ms: ' + JSON.stringify(result))
    assert.equal(result.stopped, true)
    assert.equal(result.reason, 'requested')
    assert.equal(result.forced, true, 'the forced path must be reported')
    assert.ok(elapsedMs >= 4_500, 'the bound (5s) must actually elapse before the kill: ' + elapsedMs + 'ms')
    assert.ok(elapsedMs < 15_000, 'stop must settle shortly after the bound: ' + elapsedMs + 'ms')
    assert.deepEqual(await readdir(rootDir), [], 'the profile directory must be deleted on the forced path')
  } finally {
    await Promise.race([manager.dispose().catch(() => {}), delay(10_000)])
    await rm(rootDir, { recursive: true, force: true })
  }
})
