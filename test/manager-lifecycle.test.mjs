import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserManager } from '../lib/index.js'

test('dispose aborts and drains a late browser launch before returning', { timeout: 10_000 }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-late-start-'))
  let resolveLaunch
  let closeCalls = 0
  const launch = new Promise((resolve) => { resolveLaunch = resolve })
  const manager = new BrowserManager({
    rootDir,
    discoverBrowser: async () => ({ path: '/fixture/browser', channel: 'custom' }),
    launchPersistentContext: async () => launch,
  })
  try {
    const starting = manager.start('late-agent')
    await delay(25)
    let disposeSettled = false
    const disposing = manager.dispose().then(() => { disposeSettled = true })
    await delay(25)
    assert.equal(disposeSettled, false, 'dispose must wait for a launcher that ignored cancellation')

    resolveLaunch({
      async close() { closeCalls += 1 },
    })
    await disposing
    await assert.rejects(starting, /cancelled|disposed/iu)
    assert.equal(closeCalls >= 1, true)
    assert.deepEqual(manager.activeOwners(), [])
    assert.deepEqual(await readdir(rootDir), [])
  } finally {
    await manager.dispose()
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('disposeScope aborts and drains its in-flight start without session resurrection', { timeout: 10_000 }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-late-scope-'))
  let resolveLaunch
  let closeCalls = 0
  const launch = new Promise((resolve) => { resolveLaunch = resolve })
  const manager = new BrowserManager({
    rootDir,
    discoverBrowser: async () => ({ path: '/fixture/browser', channel: 'custom' }),
    launchPersistentContext: async () => launch,
  })
  try {
    assert.equal(manager.kind, 'browser')
    assert.equal(manager.contractVersion, 2)
    const starting = manager.start('scope-agent')
    const startOutcome = starting.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    )
    await delay(25)
    let scopeSettled = false
    const disposingScope = manager.disposeScope('scope-agent').then(() => { scopeSettled = true })
    await delay(25)
    assert.equal(scopeSettled, false, 'disposeScope must await the owner launch')

    resolveLaunch({ async close() { closeCalls += 1 } })
    await disposingScope
    const outcome = await startOutcome
    assert.equal(outcome.ok, false)
    assert.match(String(outcome.error), /cancelled|disposed/iu)
    assert.equal(closeCalls >= 1, true)
    assert.deepEqual(manager.activeOwners(), [])
    assert.deepEqual(await readdir(rootDir), [])
    await manager.disposeScope('scope-agent')
  } finally {
    await manager.dispose()
    await rm(rootDir, { recursive: true, force: true })
  }
})
