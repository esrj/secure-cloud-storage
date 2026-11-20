// Run: node --test test/window/*.test.mjs
// Only ordinary web links may be handed to the operating system by the window-open handler.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSafeExternalUrl } from '../../src/main/externalUrl.js'

test('http and https links are allowed', () => {
  for (const url of [
    'https://example.com',
    'https://example.com/path?q=1#top',
    'http://localhost:5173/',
    'HTTPS://EXAMPLE.COM/Docs',
    'https://user@example.com:8443/a%20b'
  ]) {
    assert.equal(isSafeExternalUrl(url), true, url)
  }
})

test('every other scheme is refused', () => {
  for (const url of [
    'file:///etc/passwd',
    'file:///Applications/Calculator.app',
    'smb://attacker.example/share',
    'ftp://example.com/file',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ms-msdt:/id PCWDiagnostic',
    'search-ms:query=x',
    'mailto:someone@example.com',
    'tel:+886912345678',
    'x-apple.systempreferences:com.apple.preference.security',
    'about:blank',
    'blob:https://example.com/1f2e3d'
  ]) {
    assert.equal(isSafeExternalUrl(url), false, url)
  }
})

test('things that are not URLs are refused', () => {
  for (const value of [
    '',
    ' ',
    'example.com',
    '/relative/path',
    '//example.com',
    'https://',
    undefined,
    null,
    42,
    {},
    ['https://example.com'],
    new URL('https://example.com')
  ]) {
    assert.equal(isSafeExternalUrl(value), false, String(value))
  }
})

test('leading whitespace and embedded control characters do not hide the scheme', () => {
  // The URL parser strips leading whitespace and embedded tabs/newlines, as browsers do.
  assert.equal(isSafeExternalUrl('  https://example.com'), true)
  assert.equal(isSafeExternalUrl('java\tscript:alert(1)'), false)
  assert.equal(isSafeExternalUrl('\nfile:///etc/passwd'), false)
})
