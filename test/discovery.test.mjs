import test from 'node:test'
import assert from 'node:assert/strict'
import { browserCandidates } from '../lib/index.js'

test('browser discovery covers Chrome, Edge, Chromium and operator override on macOS', () => {
  const rows = browserCandidates({ platform: 'darwin', home: '/Users/tester', env: { DSHPLUGIN_BROWSER_EXECUTABLE_PATH: '/opt/browser' } })
  assert.deepEqual(rows[0], { path: '/opt/browser', channel: 'custom' })
  assert.ok(rows.some((row) => row.channel === 'chrome'))
  assert.ok(rows.some((row) => row.channel === 'edge'))
  assert.ok(rows.some((row) => row.channel === 'chromium'))
  assert.equal(new Set(rows.map((row) => row.path)).size, rows.length)
})

test('browser discovery constructs Windows candidates without host-path leakage', () => {
  const rows = browserCandidates({
    platform: 'win32',
    home: 'C:\\Users\\tester',
    env: { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
  })
  assert.ok(rows.some((row) => row.path === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'))
  assert.ok(rows.some((row) => row.path.endsWith('Microsoft\\Edge\\Application\\msedge.exe')))
})
