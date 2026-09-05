#!/usr/bin/env node
/**
 * bench-observe.mjs — measure per-poll observe() wall time against the node budget.
 *
 * Purpose: decide whether raising the shipped 100-node observe() clamp is
 * affordable on real pages. The QA layer polls observe() every ~10-20 ms
 * during settle windows, so per-poll latency is the number that matters.
 *
 * Method: for each target page and each node budget, start one managed
 * browser session (navigate once), wait for the page to settle, then run 30
 * consecutive observe() calls and record per-call wall time, emitted node
 * count, truncation flags/reasons, limits.maxNodes, and serialized payload
 * bytes.
 *
 * BENCHMARK-ONLY ENVIRONMENT VARIABLE: this script sets
 * DSH_BROWSER_BENCH_MAX_NODES to the largest budget in the matrix so budgets
 * above the shipped 100-node clamp can be measured. That variable exists ONLY
 * for benchmarking: it is a private, undocumented escape hatch read in exactly
 * one place in src/manager.ts next to the observe() clamp, and when it is
 * unset the driver clamps every request to 100 exactly as documented (asserted
 * by the observe-prefix test). It is not part of the driver contract and must
 * never be relied on by production code.
 *
 * Usage: node scripts/bench-observe.mjs
 */

import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const BUDGETS = [60, 100, 200, 300, 500]
const CALLS = 30
const MAX_BUDGET = Math.max(...BUDGETS)

// Benchmark-only escape hatch (see the header above). Read before the driver
// is imported so every observe() call in this process sees the raised ceiling.
process.env.DSH_BROWSER_BENCH_MAX_NODES = String(MAX_BUDGET)

const { BrowserManager, discoverInstalledBrowser } = await import('../lib/index.js')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

const fixtureHtml = await readFile(
  fileURLToPath(new URL('../test/fixtures/observe-prefix.html', import.meta.url)),
  'utf8',
)

let port = 0
const fixtureServer = createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (requestUrl.pathname === '/prefix') return res.end(fixtureHtml)
  res.end('<h1>index</h1>')
})
port = await listen(fixtureServer)
const fixtureOrigin = 'http://127.0.0.1:' + port

const WIKI_SETTLE_MS = 3_000
const FIXTURE_SETTLE_MS = 300

const targets = [
  { label: 'wikipedia: History_of_China', url: 'https://en.wikipedia.org/wiki/History_of_China', settleMs: WIKI_SETTLE_MS },
  { label: 'wikipedia: DeepSeek', url: 'https://en.wikipedia.org/wiki/DeepSeek', settleMs: WIKI_SETTLE_MS },
  { label: 'fixture: observe-prefix.html', url: fixtureOrigin + '/prefix', settleMs: FIXTURE_SETTLE_MS },
]

const discovered = await discoverInstalledBrowser().catch((error) => ({ path: 'unavailable', channel: 'unavailable', error: error.message }))
console.log('=== machine / browser identification ===')
console.log('machine:', JSON.stringify({
  hostname: hostname(),
  platform: platform(),
  arch: arch(),
  release: release(),
  cpus: cpus().length,
  cpuModel: cpus()[0]?.model ?? 'unknown',
  totalmemMB: Math.round(totalmem() / 1024 / 1024),
  node: process.version,
}))
console.log('driver browser (discoverInstalledBrowser):', JSON.stringify(discovered))
console.log('')

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN
  if (p === 50 && sorted.length % 2 === 0) {
    return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  }
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index]
}

async function runCell(manager, target, budget) {
  const sessionInfo = await manager.start('bench', { url: target.url })
  // start() resolves after domcontentloaded; give the page a fixed settle so
  // the 30 timed polls see a loaded, quiescent page instead of load churn.
  await new Promise((resolve) => setTimeout(resolve, target.settleMs))
  const calls = []
  for (let i = 0; i < CALLS; i += 1) {
    const t0 = performance.now()
    const observation = await manager.observe('bench', { maxNodes: budget })
    const t1 = performance.now()
    calls.push({
      ms: t1 - t0,
      nodes: observation.nodes.length,
      truncated: observation.truncated,
      reasons: observation.truncationReasons ?? [],
      maxNodes: observation.limits.maxNodes,
      bytes: JSON.stringify(observation).length,
    })
  }
  await manager.stop('bench')
  return { sessionInfo, calls }
}

function summarize(calls) {
  const ms = calls.map((call) => call.ms).sort((a, b) => a - b)
  const nodes = new Set(calls.map((call) => call.nodes))
  const bytes = calls.map((call) => call.bytes).sort((a, b) => a - b)
  const reasons = new Set()
  for (const call of calls) for (const reason of call.reasons) reasons.add(reason)
  return {
    'median ms': Number(percentile(ms, 50).toFixed(1)),
    'p95 ms': Number(percentile(ms, 95).toFixed(1)),
    'max ms': Number(ms[ms.length - 1].toFixed(1)),
    'min ms': Number(ms[0].toFixed(1)),
    nodes: nodes.size === 1 ? [...nodes][0] : [...nodes].join('/'),
    bytes: Number(percentile(bytes, 50).toFixed(0)),
    truncated: calls.filter((call) => call.truncated).length + '/' + CALLS,
    reasons: [...reasons].sort().join(','),
  }
}

console.log('=== per-page, per-budget observe() latency (' + CALLS + ' consecutive calls per cell) ===')
const rows = []
let identification = null
for (const target of targets) {
  const rootDir = await mkdtemp('/tmp/dsh-browser-bench-')
  const manager = new BrowserManager({
    rootDir,
    allowedOrigins: ['https://en.wikipedia.org', fixtureOrigin],
  })
  try {
    for (const budget of BUDGETS) {
      let row
      try {
        const { sessionInfo, calls } = await runCell(manager, target, budget)
        if (!identification) identification = sessionInfo
        row = summarize(calls)
        row.page = target.label
        row.budget = budget
      } catch (error) {
        row = {
          page: target.label,
          budget,
          'median ms': 'FAILED',
          'p95 ms': '',
          'max ms': '',
          'min ms': '',
          nodes: '',
          bytes: '',
          truncated: '',
          reasons: '',
          error: error instanceof Error ? error.message : String(error),
        }
      }
      rows.push(row)
    }
  } finally {
    await manager.dispose().catch(() => {})
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
}

// Table: page x budget -> median ms, p95 ms, max ms, nodes, bytes, truncated
const header = ['page', 'budget', 'median ms', 'p95 ms', 'max ms', 'min ms', 'nodes', 'bytes', 'truncated', 'reasons']
const widths = {}
for (const key of header) {
  widths[key] = Math.max(key.length, ...rows.map((row) => String(row[key] ?? '').length)) + 2
}
const pad = (value, key) => String(value ?? '').padEnd(widths[key])
console.log(header.map((key) => pad(key, key)).join(''))
for (const row of rows) {
  console.log(header.map((key) => pad(row[key], key)).join(''))
  if (row.error) console.log('    error: ' + row.error)
}
console.log('')
console.log('notes:')
console.log('- nodes: emitted semantic nodes (the only value when identical across all ' + CALLS + ' calls, otherwise min/max)')
console.log('- bytes: median JSON.stringify(observation).length over the ' + CALLS + ' calls')
console.log('- truncated: calls flagged truncated / total; reasons lists the union of truncationReasons')
console.log('- budgets > 100 measured via DSH_BROWSER_BENCH_MAX_NODES=' + MAX_BUDGET + ' (benchmark-only escape hatch)')
if (identification) {
  console.log('- session identification (first successful start):', JSON.stringify({
    browser: identification.browser,
    headless: identification.headless,
    isolation: identification.isolation,
    page: identification.page,
  }))
}

fixtureServer.closeAllConnections?.()
await new Promise((resolve) => fixtureServer.close(resolve))
