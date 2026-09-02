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

// D2: readonly and fieldset-disabled inputs must be advertised as non-editable
// and fill must fail FAST with a truthful code and dispatched:false instead of
// stalling for the action timeout and reporting unknown.
const nonEditablePage = `<label for="ro">Readonly field</label>
  <input id="ro" readonly value="fixed">
  <fieldset disabled>
    <label for="fd">Fieldset disabled</label>
    <input id="fd" value="in-disabled-fieldset">
  </fieldset>`

test('readonly and fieldset-disabled inputs are advertised non-editable and reject fill fast', { timeout: 120_000 }, async (t) => {
  try { await discoverInstalledBrowser() } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  let port = 0
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(nonEditablePage)
  })
  port = await listen(server)
  const origin = 'http://127.0.0.1:' + port
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-browser-noneditable-'))
  const manager = new BrowserManager({ rootDir, allowedOrigins: [origin], observationTtlMs: 60_000, actionTimeoutMs: 5_000 })
  try {
    await manager.start('owner', { url: origin + '/' })
    const observation = await manager.observe('owner')
    const readonly = observation.nodes.find((node) => node.name === 'Readonly field' && node.tag === 'input')
    assert.ok(readonly, JSON.stringify(observation.nodes))
    assert.equal(readonly.editable, false, 'a readonly input must be advertised non-editable')
    assert.equal(readonly.value, 'fixed')

    const t1 = Date.now()
    const fillReadonly = await manager.act('owner', { kind: 'fill', ref: readonly.ref, text: 'overwrite' })
    const readonlyMs = Date.now() - t1
    console.log(`D2: fill readonly rejected in ${readonlyMs}ms: ${fillReadonly.code}`)
    assert.equal(fillReadonly.status, 'rejected', JSON.stringify(fillReadonly))
    assert.equal(fillReadonly.code, 'TARGET_NOT_EDITABLE', JSON.stringify(fillReadonly))
    assert.equal(fillReadonly.dispatched, false)
    assert.ok(readonlyMs < 2_000, 'rejection must be fast, not an actionability stall: ' + readonlyMs + 'ms')

    const fieldsetDisabled = observation.nodes.find((node) => node.name === 'Fieldset disabled' && node.tag === 'input')
    assert.ok(fieldsetDisabled, JSON.stringify(observation.nodes))
    assert.equal(fieldsetDisabled.disabled, true, 'a fieldset-disabled input must be advertised disabled')
    assert.equal(fieldsetDisabled.editable, false, 'a fieldset-disabled input must be advertised non-editable')

    const t2 = Date.now()
    const fillDisabled = await manager.act('owner', { kind: 'fill', ref: fieldsetDisabled.ref, text: 'overwrite' })
    const disabledMs = Date.now() - t2
    console.log(`D2: fill fieldset-disabled rejected in ${disabledMs}ms: ${fillDisabled.code}`)
    assert.equal(fillDisabled.status, 'rejected', JSON.stringify(fillDisabled))
    assert.equal(fillDisabled.code, 'TARGET_DISABLED', JSON.stringify(fillDisabled))
    assert.equal(fillDisabled.dispatched, false)
    assert.ok(disabledMs < 2_000, 'rejection must be fast: ' + disabledMs + 'ms')

    const after = await manager.observe('owner')
    assert.equal(after.nodes.find((node) => node.name === 'Readonly field' && node.tag === 'input').value, 'fixed', 'the readonly value must be untouched')
    assert.equal(after.nodes.find((node) => node.name === 'Fieldset disabled' && node.tag === 'input').value, 'in-disabled-fieldset', 'the fieldset-disabled value must be untouched')
  } finally {
    await manager.dispose().catch(() => {})
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(rootDir, { recursive: true, force: true })
  }
})
