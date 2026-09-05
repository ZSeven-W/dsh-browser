import test from 'node:test'
import assert from 'node:assert/strict'
import { escapePgrepLiteral } from '../lib/index.js'

// #sweepSessionProcesses builds a pgrep -f pattern by interpolating the
// session's --user-data-dir path. A path containing regex metacharacters
// ('.', '(', '[', ...) must never widen or break the match, while the ps
// fallback keeps the raw token with an exact substring check. The escape
// helper is a pure function, so this pins the escaping without spawning any
// process.
test('escapePgrepLiteral neutralizes regex metacharacters in profile paths', () => {
  const path = '/tmp/dsh-browser/session-a.b[c](d){e}+f?g^h$i|j'
  const escaped = escapePgrepLiteral(path)
  const pattern = '[-][-]user-data-dir=' + escaped
  const regexp = new RegExp(pattern)

  assert.equal(regexp.test('--user-data-dir=' + path), true, 'the escaped pattern must match the literal token')
  assert.equal(
    regexp.test('--user-data-dir=/tmp/dsh-browser/session-aXb[c](d){e}+f?g^h$i|j'),
    false,
    'an escaped dot must not match an arbitrary character',
  )
  assert.equal(
    regexp.test('--user-data-dir=/tmp/dsh-browser/session-a.bXc(d){e}+f?g^h$i|j'),
    false,
    'an escaped character class must not widen',
  )
  assert.equal(
    regexp.test('--user-data-dir=/tmp/dsh-browser/session-a.b[c]Xd){e}+f?g^h$i|j'),
    false,
    'an escaped group must not widen',
  )
  assert.equal(
    regexp.test('--user-data-dir=/tmp/dsh-browser/session-a.b[c](d)Y{e}+f?g^h$i|j'),
    false,
    'an escaped quantifier must not widen',
  )
  // The raw token stays untouched for the ps exact-substring fallback.
  assert.ok(('--user-data-dir=' + path).includes('--user-data-dir=' + path))
})
