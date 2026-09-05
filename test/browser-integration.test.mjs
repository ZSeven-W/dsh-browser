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

test('real managed browser isolates agents, re-resolves refs, rejects risk, bounds evidence, and cleans up', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip(`installed Chrome/Edge/Chromium unavailable: ${error.message}`)
    return
  }

  let outsideHits = 0
  const outsideServer = createServer((_req, res) => {
    outsideHits += 1
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>outside</title>')
  })
  const outsidePort = await listen(outsideServer)
  const outsideOrigin = `http://127.0.0.1:${outsidePort}`
  const effects = { click: 0, fill: 0, press: 0 }
  const mutation = { fired: false, applied: 0 }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`)
    if (requestUrl.pathname === '/api') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"ok":false}')
      return
    }
    if (requestUrl.pathname === '/redirect') {
      res.writeHead(302, { location: `http://localhost:${port}/outside` })
      res.end()
      return
    }
    if (requestUrl.pathname === '/effect') {
      const kind = requestUrl.searchParams.get('kind')
      if (kind && Object.hasOwn(effects, kind)) effects[kind] += 1
      res.writeHead(204)
      res.end()
      return
    }
    if (requestUrl.pathname === '/mutate/fire') {
      mutation.fired = true
      res.writeHead(204)
      res.end()
      return
    }
    if (requestUrl.pathname === '/mutate-state') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(mutation.fired ? 'fire' : 'wait')
      return
    }
    if (requestUrl.pathname === '/mutate-applied') {
      mutation.applied += 1
      res.writeHead(204)
      res.end()
      return
    }
    const mutate = requestUrl.pathname === '/mutate'
    const swapKind = requestUrl.pathname.startsWith('/swap-') ? requestUrl.pathname.slice('/swap-'.length) : ''
    const swapMarkup = swapKind === 'click'
      ? '<button id="swap-target">Swap click</button>'
      : swapKind === 'fill'
        ? '<label for="swap-target">Swap fill</label><input id="swap-target" />'
        : swapKind === 'press'
          ? '<label for="swap-target">Swap press</label><input id="swap-target" />'
          : ''
    const popupMarkup = requestUrl.pathname === '/popup-link'
      ? `<a id="popup-target" target="_blank" href="${outsideOrigin}/outside">Open external window</a>`
      : requestUrl.pathname === '/popup-script'
        ? `<button id="popup-target" onclick="window.open('${outsideOrigin}/outside', '_blank')">Open external popup</button>`
        : ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html>
      <html><head><title>Browser QA fixture</title></head><body>
      <label for="name">Name</label><input id="name" />
      <button id="safe" onclick="document.querySelector('[role=status]').textContent='done'; console.log('Authorization=Bearer topsecret')">Run checks</button>
      <button id="danger">Delete account</button>
      <button id="mutable">${mutate ? 'Before mutation' : 'Stable target'}</button>
      ${swapMarkup}
      ${popupMarkup}
      <div role="status">idle</div>
      <script>
        fetch('/api?token=secret').catch(() => {});
        ${mutate ? `(() => {
          const poll = async () => {
            let fire = false
            try {
              const state = await fetch('/mutate-state')
              fire = (await state.text()) === 'fire'
            } catch { /* retry on the next tick */ }
            if (fire) {
              document.querySelector('#mutable').textContent = 'After mutation'
              fetch('/mutate-applied', { method: 'POST' }).catch(() => {})
            } else {
              setTimeout(poll, 10)
            }
          }
          poll()
        })()` : ''}
        ${swapKind ? `(() => {
          const original = document.elementFromPoint.bind(document);
          let swapped = false;
          document.elementFromPoint = (x, y) => {
            const hit = original(x, y);
            const target = document.querySelector('#swap-target');
            if (!swapped && target && (hit === target || target.contains(hit))) {
              swapped = true;
              queueMicrotask(() => {
                const replacement = target.cloneNode(true);
                replacement.addEventListener('${swapKind === 'click' ? 'click' : swapKind === 'fill' ? 'input' : 'keydown'}', () => {
                  fetch('/effect?kind=${swapKind}', { method: 'POST' }).catch(() => {});
                });
                target.replaceWith(replacement);
              });
            }
            return hit;
          };
        })();` : ''}
      </script></body></html>`)
  })
  port = await listen(server)
  const origin = `http://127.0.0.1:${port}`
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-integration-'))
  let now = Date.now()
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 1_000, now: () => now })
  try {
    const sameOwner = await Promise.allSettled([
      manager.start('race-owner', { url: origin }),
      manager.start('race-owner', { url: origin }),
    ])
    assert.equal(sameOwner.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(sameOwner.filter((result) => result.status === 'rejected').length, 1)
    await manager.stop('race-owner')

    const [alpha, beta] = await Promise.all([
      manager.start('alpha', { url: origin }),
      manager.start('beta', { url: origin }),
    ])
    assert.equal(alpha.isolation, 'ephemeral-user-data')
    assert.equal(alpha.navigationPolicy.mode, 'allowlist')
    assert.deepEqual(alpha.navigationPolicy.allowedOrigins, [origin])
    assert.equal(beta.ownerId, 'beta')
    assert.deepEqual(manager.activeOwners(), ['alpha', 'beta'])

    const observed = await manager.observe('alpha', { maxNodes: 30 })
    assert.ok(observed.fingerprint.length >= 20)
    assert.ok(observed.expiresAt)
    assert.ok(observed.nodes.every((node) => node.ref.startsWith('br_') && !node.ref.includes('html')))
    const input = observed.nodes.find((node) => node.role === 'textbox' && node.name === 'Name')
    const safe = observed.nodes.find((node) => node.name === 'Run checks')
    const danger = observed.nodes.find((node) => node.name === 'Delete account')
    assert.ok(input && safe && danger)

    const crossAgent = await manager.act('beta', { kind: 'click', ref: safe.ref })
    assert.equal(crossAgent.status, 'rejected')
    assert.equal(crossAgent.code, 'OBSERVATION_REQUIRED')

    const filled = await manager.act('alpha', { kind: 'fill', ref: input.ref, text: 'Alice' })
    assert.equal(filled.status, 'confirmed')
    assert.equal(filled.verification.kind, 'value-match')
    assert.doesNotMatch(JSON.stringify(filled), /Alice/)
    const reused = await manager.act('alpha', { kind: 'click', ref: safe.ref })
    assert.equal(reused.status, 'rejected')
    assert.equal(reused.code, 'OBSERVATION_REQUIRED')

    const observedAgain = await manager.observe('alpha')
    const safeAgain = observedAgain.nodes.find((node) => node.name === 'Run checks')
    const dangerAgain = observedAgain.nodes.find((node) => node.name === 'Delete account')
    assert.ok(safeAgain && dangerAgain)
    const denied = await manager.act('alpha', { kind: 'click', ref: dangerAgain.ref })
    assert.equal(denied.status, 'rejected')
    assert.equal(denied.code, 'DESTRUCTIVE_TARGET')
    assert.equal(denied.dispatched, false)
    const clicked = await manager.act('alpha', { kind: 'click', ref: safeAgain.ref })
    assert.equal(clicked.status, 'confirmed')

    await new Promise((resolve) => setTimeout(resolve, 100))
    const evidence = await manager.evidence('alpha', { maxConsole: 10, maxNetwork: 10 })
    const encodedEvidence = JSON.stringify(evidence)
    assert.doesNotMatch(encodedEvidence, /topsecret|token=secret/)
    assert.ok(evidence.console.some((item) => item.text.includes('REDACTED')))
    assert.ok(evidence.network.some((item) => item.status === 500 && item.url === `${origin}/api`))
    assert.equal(evidence.bounded, true)

    const directDenied = await manager.act('alpha', { kind: 'navigate', url: `http://localhost:${port}/outside` })
    assert.equal(directDenied.status, 'rejected')
    assert.equal(directDenied.code, 'ORIGIN_POLICY_VIOLATION')
    assert.equal(directDenied.dispatched, false)

    const toMutation = await manager.act('alpha', { kind: 'navigate', url: `${origin}/mutate` })
    assert.equal(toMutation.status, 'confirmed')
    const mutationObservation = await manager.observe('alpha')
    const mutable = mutationObservation.nodes.find((node) => node.name === 'Before mutation')
    assert.ok(mutable)
    await fetch(`${origin}/mutate/fire`)
    const mutationDeadline = Date.now() + 10_000
    while (mutation.applied === 0 && Date.now() < mutationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(mutation.applied > 0, 'fixture never applied the /mutate text change')
    const changed = await manager.act('alpha', { kind: 'click', ref: mutable.ref })
    assert.equal(changed.status, 'rejected')
    assert.equal(changed.code, 'TARGET_CHANGED')

    for (const scenario of [
      { kind: 'click', name: 'Swap click', action: (ref) => ({ kind: 'click', ref }) },
      { kind: 'fill', name: 'Swap fill', action: (ref) => ({ kind: 'fill', ref, text: 'must-not-land' }) },
      { kind: 'press', name: 'Swap press', action: (ref) => ({ kind: 'press', ref, key: 'A' }) },
    ]) {
      const navigation = await manager.act('alpha', { kind: 'navigate', url: `${origin}/swap-${scenario.kind}` })
      assert.equal(navigation.status, 'confirmed')
      const snapshot = await manager.observe('alpha')
      const node = snapshot.nodes.find((candidate) => candidate.name === scenario.name && candidate.interactive)
      assert.ok(node)
      const receipt = await manager.act('alpha', scenario.action(node.ref))
      assert.equal(receipt.status, 'rejected', `${scenario.kind}: ${JSON.stringify(receipt)}`)
      assert.equal(receipt.code, 'TARGET_DETACHED')
      assert.equal(receipt.dispatched, false)
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(effects[scenario.kind], 0, `${scenario.kind} replacement received an event`)
    }

    for (const popup of [
      { owner: 'popup-link', path: '/popup-link', name: 'Open external window' },
      { owner: 'popup-script', path: '/popup-script', name: 'Open external popup' },
    ]) {
      await manager.start(popup.owner, { url: `${origin}${popup.path}` })
      const snapshot = await manager.observe(popup.owner)
      const trigger = snapshot.nodes.find((node) => node.name === popup.name)
      assert.ok(trigger)
      const receipt = await manager.act(popup.owner, { kind: 'click', ref: trigger.ref })
      assert.notEqual(receipt.status, 'confirmed', JSON.stringify(receipt))
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(outsideHits, 0, `${popup.path} reached the disallowed origin`)
      await assert.rejects(manager.observe(popup.owner), /no running browser session/)
      assert.equal(manager.activeOwners().includes(popup.owner), false)
    }

    const fresh = await manager.observe('alpha')
    now += 1_001
    const expired = await manager.act('alpha', { kind: 'click', ref: fresh.nodes.find((node) => node.name === 'Run checks').ref })
    assert.equal(expired.status, 'rejected')
    assert.equal(expired.code, 'REF_EXPIRED')
    now = Date.now()

    const redirected = await manager.act('alpha', { kind: 'navigate', url: `${origin}/redirect` })
    assert.notEqual(redirected.status, 'confirmed')
    assert.notEqual(redirected.pageAfter.url, `http://localhost:${port}/outside`)
  } finally {
    await manager.dispose()
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    outsideServer.closeAllConnections?.()
    await new Promise((resolve) => outsideServer.close(resolve))
    const leftovers = await readdir(rootDir)
    assert.deepEqual(leftovers, [])
    await rm(rootDir, { recursive: true, force: true })
  }
})
