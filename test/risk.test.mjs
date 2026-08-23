import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyActionRisk, normalizeNavigationUrl, publicPageUrl, redactEvidenceText } from '../lib/index.js'

const target = (name, extra = {}) => ({
  role: 'button', name, tag: 'button', inputType: '', download: false, ...extra,
})

test('risk policy is derived from live target semantics', () => {
  assert.equal(classifyActionRisk({ kind: 'click', ref: 'opaque' }, target('Run checks')).allowed, true)
  assert.equal(classifyActionRisk({ kind: 'click', ref: 'opaque' }, target('Delete account')).code, 'DESTRUCTIVE_TARGET')
  assert.equal(classifyActionRisk({ kind: 'click', ref: 'opaque' }, target('Pay now')).code, 'FINANCIAL_TARGET')
  assert.equal(classifyActionRisk({ kind: 'click', ref: 'opaque' }, target('Publish post')).code, 'EXTERNAL_COMMIT_TARGET')
  assert.equal(classifyActionRisk({ kind: 'fill', ref: 'opaque', text: 'secret' }, target('Password', { tag: 'input', inputType: 'password' })).code, 'CREDENTIAL_ENTRY_REJECTED')
  assert.equal(classifyActionRisk({ kind: 'press', ref: 'opaque', key: 'Meta+Enter' }, target('Editor')).code, 'DANGEROUS_KEY_REJECTED')
  assert.equal(classifyActionRisk({ kind: 'click', ref: 'opaque' }, target('Export', { download: true })).code, 'DOWNLOAD_REJECTED')
})

test('navigation accepts only credential-free absolute http(s) URLs', () => {
  assert.equal(normalizeNavigationUrl('about:blank'), 'about:blank')
  assert.equal(normalizeNavigationUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1')
  assert.throws(() => normalizeNavigationUrl('javascript:alert(1)'), /protocol/)
  assert.throws(() => normalizeNavigationUrl('file:///tmp/example'), /protocol/)
  assert.throws(() => normalizeNavigationUrl('https://user:pass@example.com/'), /credentials/)
  assert.throws(() => normalizeNavigationUrl('/relative'), /absolute/)
})

test('evidence surfaces redact common credentials and URL query data', () => {
  const redacted = redactEvidenceText('Authorization=Bearer topsecret https://x.test/a?token=abc')
  assert.doesNotMatch(redacted, /topsecret|token=abc/)
  assert.match(redacted, /REDACTED/)
  assert.equal(publicPageUrl('https://user:pass@example.com/a?token=abc#frag'), 'https://example.com/a')
})
