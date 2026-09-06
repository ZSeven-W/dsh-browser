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
// N, and every per-node field other than `ref` and `parentRef` — inViewport
// included — is identical between the two observations over the shared
// prefix. `ref` and `parentRef` are the fields that MUST differ as raw
// strings: both are re-minted per observation. v9 compares `parentRef` as a
// RELATIONSHIP instead — the parent's index within the same view, or null —
// which must be identical across budgets for the shared prefix.
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

const scopedFixtureHtml = await readFile(
  fileURLToPath(new URL('./fixtures/observe-scoped.html', import.meta.url)),
  'utf8',
)

// Every public node field except the observation-specific `ref` and
// `parentRef` (both re-minted per observation; parentRef is pinned as a
// relationship below).
const nodeFields = (node) => {
  const { ref, parentRef, ...fields } = node
  return fields
}

// ...except `ref`, `parentRef`, AND `inViewport` (the only field a scroll
// may change).
const nodeFieldsStable = (node) => {
  const { ref, parentRef, inViewport, ...fields } = node
  return fields
}

// v9: parentRef is pinned as a RELATIONSHIP — the parent's INDEX within the
// same view, or null — never as a raw ref string, because refs are re-minted
// per observation.
const parentIndexOf = (view, node) => {
  if (!('parentRef' in node)) return 'missing'
  if (node.parentRef === null) return null
  return view.nodes.findIndex((candidate) => candidate.ref === node.parentRef)
}

const assertParentRelationship = (small, large, label) => {
  for (let i = 0; i < small.nodes.length; i += 1) {
    const smallParent = parentIndexOf(small, small.nodes[i])
    const largeParent = parentIndexOf(large, large.nodes[i])
    assert.notEqual(smallParent, 'missing', label + ': index ' + i + ' must carry parentRef')
    assert.notEqual(largeParent, 'missing', label + ': index ' + i + ' must carry parentRef')
    assert.notEqual(smallParent, -1, label + ': index ' + i + ' parentRef must resolve inside the small view')
    assert.notEqual(largeParent, -1, label + ': index ' + i + ' parentRef must resolve inside the large view')
    assert.equal(
      smallParent,
      largeParent,
      label + ': index ' + i + ' parentRef relationship must be identical across the two views: small-parent=' + smallParent + ' large-parent=' + largeParent,
    )
  }
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
        if (a.parentRef !== null || b.parentRef !== null) {
          assert.notEqual(a.parentRef, b.parentRef, label + ': index ' + i + ' parentRef raw strings must be re-minted per observation')
        }
      }
      assertParentRelationship(small, large, label)
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
    // v9+ nameSource: an authored label vs descendant-text aggregation,
    // pinned per node and compared field-wise by the prefix equality above.
    assert.equal(byName.get('Search box')?.nameSource, 'label', 'an aria-label named input must carry nameSource label')
    assert.equal(byName.get('Secret field')?.nameSource, 'label', 'an aria-label named password must carry nameSource label')
    assert.equal(byName.get('Docs link')?.nameSource, 'label', 'an aria-label named link must carry nameSource label')
    assert.equal(byName.get('Pick one')?.nameSource, 'label', 'an aria-label named select must carry nameSource label')
    assert.equal(byName.get('Disabled act')?.nameSource, 'label', 'an aria-label named button must carry nameSource label')
    assert.equal(byName.get('Notes')?.nameSource, 'label', 'an aria-label named textarea must carry nameSource label')
    assert.equal(byName.get('shadow-act-0')?.nameSource, 'content', 'a plain-text button must carry nameSource content')
    assert.equal(byName.get('header-0')?.nameSource, 'content', 'a plain-text header button must carry nameSource content')
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
    assertParentRelationship(pre100, pre500, 'clamped 500 vs explicit 100')

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
      assertParentRelationship(pre, post, label + '-node scroll pair')
    }
    assert.ok(viewportFlips > 0, 'the scroll must flip inViewport for at least one node')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('a 500-node request stays clamped to the 100-node ceiling while the benchmark escape hatch is unset', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  // DSH_BROWSER_BENCH_MAX_NODES is the benchmark-only escape hatch
  // (scripts/bench-observe.mjs). With the variable unset — every production
  // and QA run — a 500-node request must clamp to the documented 100-node
  // ceiling exactly as the shipped default.
  const savedBenchMax = process.env.DSH_BROWSER_BENCH_MAX_NODES
  delete process.env.DSH_BROWSER_BENCH_MAX_NODES
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/prefix') return res.end(fixtureHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-ceiling-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  try {
    await manager.start('owner', { url: origin + '/prefix' })
    const observed = await manager.observe('owner', { maxNodes: 500 })
    assert.equal(observed.limits.maxNodes, 100, 'a 500-node request must clamp to the 100-node ceiling when DSH_BROWSER_BENCH_MAX_NODES is unset')
    assert.equal(observed.nodes.length, 100, 'the clamped request must emit exactly 100 nodes')
    assert.equal(observed.truncated, true, 'the clamped request must still flag truncation')
    assert.ok(observed.truncationReasons?.includes('node-budget-exceeded'), JSON.stringify(observed.truncationReasons))
  } finally {
    if (savedBenchMax === undefined) delete process.env.DSH_BROWSER_BENCH_MAX_NODES
    else process.env.DSH_BROWSER_BENCH_MAX_NODES = savedBenchMax
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})



test('scoped observe on an unchanged page: the prefix property holds within a fixed scope', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/scoped') return res.end(scopedFixtureHtml)
    res.end('<h1>index</h1>')
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-scoped-prefix-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 120_000 })
  // Reach the deep container the way a caller must: the whole-page window
  // never contains it, the main-region scope emits it as its 100th node.
  const chain = async () => {
    const whole = await manager.observe('owner', { maxNodes: 100 })
    const anchor = whole.nodes.find((node) => node.name === 'Scope anchor region')
    assert.ok(anchor)
    const narrow = await manager.observe('owner', { within: anchor.ref, maxNodes: 100 })
    const container = narrow.nodes.find((node) => node.name === 'Deep container')
    assert.ok(container, 'narrow scope must include the container')
    return container
  }
  try {
    await manager.start('owner', { url: origin + '/scoped' })

    const smallContainer = await chain()
    const scopedSmall = await manager.observe('owner', { within: smallContainer.ref, maxNodes: 5 })
    const largeContainer = await chain()
    const scopedLarge = await manager.observe('owner', { within: largeContainer.ref, maxNodes: 40 })

    assert.equal(scopedSmall.nodes.length, 5, 'scoped observe(5) emits 5 subtree nodes')
    assert.equal(scopedLarge.nodes.length, 32, 'scoped observe(40) emits the whole 32-node subtree')
    assert.equal(scopedSmall.truncated, true, 'scoped observe(5) is partial')
    assert.ok(scopedSmall.truncationReasons?.includes('node-budget-exceeded'), JSON.stringify(scopedSmall.truncationReasons))
    assert.equal(scopedLarge.truncated, false, 'scoped observe(40) fits the subtree with no reasons')
    assert.equal(scopedLarge.truncationReasons, undefined)
    assert.equal(scopedSmall.limits.maxNodes, 5)
    assert.equal(scopedLarge.limits.maxNodes, 40)
    assert.notEqual(smallContainer.ref, largeContainer.ref, 'scope refs are re-minted per observation')

    // Both scope echoes describe the same container, with their own ref.
    assert.deepEqual(
      { ...scopedSmall.scope, ref: undefined, rootRef: undefined },
      { ref: undefined, rootRef: undefined, role: 'region', name: 'Deep container', tag: 'div' },
      'scoped observe(5) scope echo',
    )
    assert.equal(typeof scopedSmall.scope.rootRef, 'string', 'scoped observe(5) must mint a fresh rootRef')
    assert.equal(scopedSmall.scope.rootRef, scopedSmall.nodes[0].ref, 'rootRef is the root node fresh ref in a scoped view')
    assert.deepEqual(scopedLarge.scope, { ref: largeContainer.ref, rootRef: scopedLarge.nodes[0].ref, role: 'region', name: 'Deep container', tag: 'div' })

    // The deep target sits at subtree index 3, inside the 5-node prefix.
    assert.equal(scopedSmall.nodes[3].name, 'Deep scoped target', 'deep target in the small prefix')
    assert.equal(scopedLarge.nodes[3].name, 'Deep scoped target', 'deep target at the same index in the large view')

    // Field-level prefix within the fixed scope: every field except ref must be
    // identical over the shared prefix (inViewport included — the page is
    // unchanged and un-scrolled between the two observations).
    for (let i = 0; i < scopedSmall.nodes.length; i += 1) {
      const diffs = differingFields(nodeFields(scopedSmall.nodes[i]), nodeFields(scopedLarge.nodes[i]))
      assert.equal(
        diffs.length,
        0,
        'scoped prefix index ' + i + ' differs in fields [' + diffs.join(', ') + ']: small=' + JSON.stringify(scopedSmall.nodes[i]) + ' large=' + JSON.stringify(scopedLarge.nodes[i]),
      )
      assert.notEqual(scopedSmall.nodes[i].ref, scopedLarge.nodes[i].ref, 'scoped prefix index ' + i + ' refs must be re-minted per observation')
    }
    assertParentRelationship(scopedSmall, scopedLarge, 'scoped prefix')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
})
