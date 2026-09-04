import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager, discoverInstalledBrowser } from '../lib/index.js'

// Pins the assumption a sibling project (dsh-qa, 70d8559) builds on: on an
// UNCHANGED page, observe(N) is a strict field-level prefix of observe(M>N).
// Nodes are emitted in composed-tree DOM order (open shadow roots pierced at
// their host's position), display:none/visibility:hidden/zero-box candidates
// are skipped before they can consume the budget, truncation keeps the first
// N, and every per-node field other than `ref` — inViewport included — is
// identical between the two observations over the shared prefix. `ref` is the
// one field that MUST differ: refs are re-minted per observation.
// The fixture is static, so any prefix violation here is a deterministic
// driver counterexample, not a churn artifact.

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

const fixtureHtml = await readFile(
  fileURLToPath(new URL('./fixtures/observe-prefix.html', import.meta.url)),
  'utf8',
)

// Every public node field except the observation-specific `ref`.
const nodeFields = (node) => {
  const { ref, ...fields } = node
  return fields
}

// ...except `ref` AND `inViewport` (the only field a scroll may change).
const nodeFieldsStable = (node) => {
  const { ref, inViewport, ...fields } = node
  return fields
}

const differingFields = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const diffs = []
  for (const key of keys) {
    const presentA = key in a
    const presentB = key in b
    if (!presentA || !presentB || typeof a[key] !== typeof b[key] || JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      diffs.push(key)
    }
  }
  return diffs
}

test('observe on an unchanged page: smaller maxNodes lists are field-level prefixes of larger ones', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/prefix') return res.end(fixtureHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-prefix-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/prefix' })

    const assertBudget = (observed, budget) => {
      assert.equal(
        observed.nodes.length,
        budget,
        'maxNodes ' + budget + ' must emit exactly ' + budget + ' nodes (fixture exposes 144 visible semantic matches)',
      )
      assert.equal(observed.truncated, true, 'maxNodes ' + budget + ' must flag truncation')
      assert.ok(
        observed.truncationReasons?.includes('node-budget-exceeded'),
        'maxNodes ' + budget + ' reasons must name node-budget-exceeded: ' + JSON.stringify(observed.truncationReasons),
      )
      assert.ok(
        !observed.truncationReasons?.includes('scan-window-exceeded'),
        'maxNodes ' + budget + ': fixture fits the 500-match scan window: ' + JSON.stringify(observed.truncationReasons),
      )
      assert.ok(
        !observed.truncationReasons?.includes('byte-budget-exceeded'),
        'maxNodes ' + budget + ': fixture fits the byte budget: ' + JSON.stringify(observed.truncationReasons),
      )
      assert.equal(observed.limits.maxNodes, budget, 'limits.maxNodes must report the applied budget')
    }

    const assertPrefix = (small, large, smallBudget, largeBudget, label) => {
      assert.equal(small.nodes.length, smallBudget, label + ': smaller observation length')
      assert.equal(large.nodes.length, largeBudget, label + ': larger observation length')
      for (let i = 0; i < small.nodes.length; i += 1) {
        const a = small.nodes[i]
        const b = large.nodes[i]
        const diffs = differingFields(nodeFields(a), nodeFields(b))
        assert.equal(
          diffs.length,
          0,
          label + ': index ' + i + ' differs in fields [' + diffs.join(', ') + ']: small=' + JSON.stringify(a) + ' large=' + JSON.stringify(b),
        )
        assert.notEqual(a.ref, b.ref, label + ': index ' + i + ' refs must be re-minted per observation')
      }
    }

    // Same page state, three budgets: each smaller list must be a strict
    // field-level prefix of each larger list.
    const pre20 = await manager.observe('owner', { maxNodes: 20 })
    const pre60 = await manager.observe('owner', { maxNodes: 60 })
    const pre100 = await manager.observe('owner', { maxNodes: 100 })
    for (const [observed, budget] of [[pre20, 20], [pre60, 60], [pre100, 100]]) assertBudget(observed, budget)
    assertPrefix(pre20, pre60, 20, 60, 'pre-scroll 20 < 60')
    assertPrefix(pre60, pre100, 60, 100, 'pre-scroll 60 < 100')
    assertPrefix(pre20, pre100, 20, 100, 'pre-scroll 20 < 100')
    assert.equal(pre20.page.url, pre100.page.url, 'the page must be unchanged across observations')

    // The fixture genuinely exercises the pinned properties: open shadow-root
    // piercing inside the smallest budget, hidden candidates skipped, and a
    // viewport split.
    assert.ok(
      pre20.nodes.some((node) => node.name === 'shadow-act-4'),
      'open shadow-root nodes must pierce into the 20-node prefix: ' + JSON.stringify(pre20.nodes.map((node) => node.name)),
    )
    for (const observed of [pre20, pre60, pre100]) {
      assert.ok(
        observed.nodes.every((node) => !node.name.startsWith('ghost-') && node.name !== 'invis-btn'),
        'display:none/visibility:hidden candidates must be skipped consistently',
      )
    }
    assert.ok(
      pre100.nodes.some((node) => node.inViewport) && pre100.nodes.some((node) => !node.inViewport),
      'the fixture must straddle the viewport so inViewport carries both values',
    )
    const byName = new Map(pre20.nodes.map((node) => [node.name, node]))
    assert.equal(byName.get('Search box')?.value, 'alpha beta', 'value-bearing input must carry its value')
    assert.equal(byName.get('Secret field')?.valueWithheld, true, 'password input must carry valueWithheld, not value')
    assert.equal(byName.get('Docs link')?.href, 'https://example.com/page', 'link must carry its scrubbed href')
    assert.equal(byName.get('Disabled act')?.disabled, true, 'disabled control must carry disabled')
    assert.equal(byName.get('Notes')?.value, 'leading and trailing', 'textarea value must be normalized')
    assert.equal(byName.get('Pick one')?.value, 'First', 'select must carry the selected option value')
    assert.equal(byName.get('shadow-act-0')?.inViewport, true, 'shadow-act-0 must start in the viewport')
    assert.equal(pre100.nodes.find((node) => node.name === 'row-0')?.inViewport, false, 'row-0 must start outside the viewport')

    // A request of 500 is clamped to the 100-node ceiling and reported as 100.
    const pre500 = await manager.observe('owner', { maxNodes: 500 })
    assert.equal(pre500.limits.maxNodes, 100, 'a 500-node request must be clamped to the 100-node ceiling')
    assert.equal(pre500.nodes.length, 100, 'the clamped request must emit 100 nodes')
    assert.equal(pre500.truncated, true, 'the clamped request must still flag truncation')
    assert.ok(pre500.truncationReasons?.includes('node-budget-exceeded'), JSON.stringify(pre500.truncationReasons))
    for (let i = 0; i < pre100.nodes.length; i += 1) {
      const diffs = differingFields(nodeFields(pre500.nodes[i]), nodeFields(pre100.nodes[i]))
      assert.equal(diffs.length, 0, 'clamped 500 vs explicit 100: index ' + i + ' differs in fields [' + diffs.join(', ') + ']')
      assert.notEqual(pre500.nodes[i].ref, pre100.nodes[i].ref, 'clamped 500 vs explicit 100: refs must be re-minted per observation')
    }

    // Scroll the viewport one page down. The DOM is untouched; only which
    // nodes intersect the viewport changes.
    const receipt = await manager.act('owner', { kind: 'scroll', direction: 'down', amount: 'page' })
    assert.equal(receipt.status, 'confirmed', JSON.stringify(receipt))

    const post20 = await manager.observe('owner', { maxNodes: 20 })
    const post100 = await manager.observe('owner', { maxNodes: 100 })
    assertBudget(post20, 20)
    assertBudget(post100, 100)
    assertPrefix(post20, post100, 20, 100, 'post-scroll 20 < 100')

    // The scroll must actually flip viewport membership, and the flipped
    // values must agree across budgets in the post-scroll pair.
    assert.equal(pre100.nodes.find((node) => node.name === 'row-0')?.inViewport, false, 'row-0 must start outside the viewport')
    assert.equal(post100.nodes.find((node) => node.name === 'row-0')?.inViewport, true, 'row-0 must be inside the viewport after the scroll')
    assert.equal(post20.nodes.find((node) => node.name === 'shadow-act-0')?.inViewport, false, 'shadow-act-0 must leave the viewport after the scroll')

    // Relative to the pre-scroll observations, only inViewport may differ.
    let viewportFlips = 0
    for (const [pre, post, label] of [[pre20, post20, '20'], [pre100, post100, '100']]) {
      assert.equal(pre.nodes.length, post.nodes.length, label + '-node observation must stay ' + label + ' nodes across the scroll')
      for (let i = 0; i < pre.nodes.length; i += 1) {
        const diffs = differingFields(nodeFieldsStable(pre.nodes[i]), nodeFieldsStable(post.nodes[i]))
        assert.equal(
          diffs.length,
          0,
          label + ': index ' + i + ' changed fields other than inViewport across the scroll: [' + diffs.join(', ') + ']: pre=' + JSON.stringify(pre.nodes[i]) + ' post=' + JSON.stringify(post.nodes[i]),
        )
        assert.notEqual(pre.nodes[i].ref, post.nodes[i].ref, label + ': index ' + i + ' refs must be re-minted per observation')
        if (pre.nodes[i].inViewport !== post.nodes[i].inViewport) viewportFlips += 1
      }
    }
    assert.ok(viewportFlips > 0, 'the scroll must flip inViewport for at least one node')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

