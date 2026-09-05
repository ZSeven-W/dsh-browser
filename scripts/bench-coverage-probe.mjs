#!/usr/bin/env node
/**
 * bench-coverage-probe.mjs — measure observe({ verifyCoverage: true }) cost.
 *
 * Purpose: report the Phase C coverage probe's real wall time and outcome on
 * the sizes that matter: a scoped subtree on the Phase C fixture (both a
 * clean region and a region holding closed roots), the whole fixture
 * document, and a whole real-page document
 * (https://en.wikipedia.org/wiki/History_of_China). The probe carries a hard
 * node cap (5,000 DOM nodes) and a hard time cap (250 ms); a whole real-page
 * document is EXPECTED to stop over budget, and this script reports that
 * honestly instead of hiding it. The probe is opt-in (verifyCoverage) and is
 * meant for the terminal absence-proof path only — never for settle polls.
 *
 * Usage: node scripts/bench-coverage-probe.mjs [wikipediaUrl]
 */

import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

const { BrowserManager, discoverInstalledBrowser } = await import('../lib/index.js')

const WIKIPEDIA_URL = process.argv[2] ?? 'https://en.wikipedia.org/wiki/History_of_China'
const FIXTURE_CALLS = 20
const WIKIPEDIA_CALLS = 5

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

const fixtureHtml = await readFile(
  fileURLToPath(new URL('../test/fixtures/observe-phasec.html', import.meta.url)),
  'utf8',
)

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

const summarize = (label, samples) => {
  const ms = samples.map((sample) => sample.ms)
  const last = samples.at(-1)
  console.log(
    label + ':',
    JSON.stringify({
      calls: samples.length,
      medianMs: Number(median(ms).toFixed(1)),
      p95Ms: Number(p95(ms).toFixed(1)),
      minMs: Number(Math.min(...ms).toFixed(1)),
      maxMs: Number(Math.max(...ms).toFixed(1)),
      lastCoverage: last?.coverage,
      lastTruncated: last?.truncated,
      lastReasons: last?.reasons,
      lastNodeCount: last?.nodeCount,
    }),
  )
}

let executable
try {
  executable = await discoverInstalledBrowser()
} catch (error) {
  console.error('installed Chrome/Edge/Chromium unavailable: ' + error.message)
  process.exit(1)
}

let port = 0
const server = createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://127.0.0.1:' + port)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (requestUrl.pathname === '/phasec') return res.end(fixtureHtml)
  res.end('<h1>index</h1>')
})
port = await listen(server)
const origin = 'http://127.0.0.1:' + port
const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-coverage-bench-'))
const manager = new BrowserManager({ rootDir, observationTtlMs: 300_000 })
console.log('browser:', executable.channel, executable.version)

try {
  await manager.start('bench', { url: origin + '/phasec' })
  await delay(300)

  const freshRegion = async (name) => {
    const view = await manager.observe('bench', { maxNodes: 100 })
    const node = view.nodes.find((candidate) => candidate.name === name)
    if (!node) throw new Error('region not found: ' + name)
    return node
  }

  // Scoped probe on the clean region (no closed roots): the terminal
  // absence-proof path at its cheapest.
  const cleanSamples = []
  for (let call = 0; call < FIXTURE_CALLS; call += 1) {
    const region = await freshRegion('Clean region')
    const start = performance.now()
    const view = await manager.observe('bench', { within: region.ref, verifyCoverage: true, maxNodes: 100 })
    cleanSamples.push({
      ms: performance.now() - start,
      coverage: view.coverage,
      truncated: view.truncated,
      reasons: view.truncationReasons,
      nodeCount: view.nodes.length,
    })
  }
  summarize('fixture scoped (clean region, no closed roots)', cleanSamples)

  // Scoped probe on a region holding an imperative closed root: the probe
  // completes and names the root.
  const closedSamples = []
  for (let call = 0; call < FIXTURE_CALLS; call += 1) {
    const region = await freshRegion('Imperative closed region')
    const start = performance.now()
    const view = await manager.observe('bench', { within: region.ref, verifyCoverage: true, maxNodes: 100 })
    closedSamples.push({
      ms: performance.now() - start,
      coverage: view.coverage,
      truncated: view.truncated,
      reasons: view.truncationReasons,
      nodeCount: view.nodes.length,
    })
  }
  summarize('fixture scoped (imperative closed-root region)', closedSamples)

  // Whole-page probe on the small fixture: completes and finds the three
  // closed roots of the page.
  const fixtureWholeSamples = []
  for (let call = 0; call < FIXTURE_CALLS; call += 1) {
    const start = performance.now()
    const view = await manager.observe('bench', { verifyCoverage: true, maxNodes: 100 })
    fixtureWholeSamples.push({
      ms: performance.now() - start,
      coverage: view.coverage,
      truncated: view.truncated,
      reasons: view.truncationReasons,
      nodeCount: view.nodes.length,
    })
  }
  summarize('fixture whole-page (three closed roots)', fixtureWholeSamples)

  // Whole-page probe on a real page: expected over-budget, reported honestly.
  console.log('navigating to', WIKIPEDIA_URL)
  const receipt = await manager.act('bench', { kind: 'navigate', url: WIKIPEDIA_URL })
  if (receipt.status !== 'confirmed') throw new Error('wikipedia navigation failed: ' + JSON.stringify(receipt))
  await delay(4000)
  const wikiSamples = []
  for (let call = 0; call < WIKIPEDIA_CALLS; call += 1) {
    const start = performance.now()
    const view = await manager.observe('bench', { verifyCoverage: true, maxNodes: 60 })
    wikiSamples.push({
      ms: performance.now() - start,
      coverage: view.coverage,
      truncated: view.truncated,
      reasons: view.truncationReasons,
      nodeCount: view.nodes.length,
    })
  }
  summarize('wikipedia whole-page (' + WIKIPEDIA_URL + ')', wikiSamples)
} finally {
  await manager.dispose().catch(() => {})
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  await rm(rootDir, { recursive: true, force: true }).catch(() => {})
}
