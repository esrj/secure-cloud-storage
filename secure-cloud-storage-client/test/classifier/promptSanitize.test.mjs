// Run: npm run test:classifier
// (node --test --experimental-test-module-mocks test/classifier/*.test.mjs)
//
// 2026-11-09: the control-character stripping in ClassifyService was rewritten
// from explicit \uXXXX character classes to \p{Cc} (SonarQube S6324). This test
// proves the output is byte-identical to the original regexes for every UTF-16
// code unit plus a set of multi-code-unit strings, so classification prompts
// are unchanged.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = (p) => new URL(`../../src/main/${p}`, import.meta.url).href
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

mock.module(src('services/LlamaCppClient.js'), {
  namedExports: { MAX_CHUNK_CHARS: 3000, generate: async () => '' }
})
mock.module(src('services/TextExtractService.js'), {
  namedExports: {
    extractTextFromFiles: async () => ({ supported: false, reason: 'X', texts: [] })
  }
})
mock.module(src('services/classifierSettings.js'), {
  namedExports: { getClassifierSettings: () => ({ classifierThreshold: 0.55 }) }
})
mock.module(src('Logger.js'), { namedExports: { logger: quiet } })
if (existsSync(fileURLToPath(src('services/windowsClassifierModel.js')))) {
  mock.module(src('services/windowsClassifierModel.js'), {
    namedExports: { getWindowsClassifierSupport: () => null }
  })
}

const { sanitizeBodyForPrompt, sanitizeFilenameForPrompt } = await import(
  src('services/ClassifyService.js')
)

// ── Reference: the functions exactly as they were before 2026-11-09 ─────────
const OLD_BODY_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g
const OLD_NAME_RE = /[\u0000-\u001F\u007F-\u009F]/g
const MAX_FILENAME_CHARS = 120

function oldSanitizeBody(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text
    .replace(OLD_BODY_RE, ' ')
    .replace(/^(\s*)#\s*檔案/gm, '$1＃ 檔案')
    .replace(/^(\s*)-{3,}(\s*)$/gm, '$1—（分隔）$2')
}

function oldSanitizeFilename(name) {
  const oneLine = String(name || '')
    .replace(OLD_NAME_RE, ' ')
    .replace(/[#`]/g, '＃')
    .replace(/-{3,}/g, '—')
    .replace(/\s+/g, ' ')
    .trim()
  return oneLine.length > MAX_FILENAME_CHARS ? oneLine.slice(0, MAX_FILENAME_CHARS) + '…' : oneLine
}

function same(input, label) {
  assert.equal(sanitizeBodyForPrompt(input), oldSanitizeBody(input), `body: ${label}`)
  assert.equal(sanitizeFilenameForPrompt(input), oldSanitizeFilename(input), `name: ${label}`)
}

test('every UTF-16 code unit is handled exactly as before', () => {
  for (let cu = 0; cu <= 0xffff; cu++) {
    const ch = String.fromCharCode(cu)
    const label = `U+${cu.toString(16).padStart(4, '0')}`
    same(ch, label)
    same(`a${ch}b`, `a ${label} b`)
    same(`${ch}\t${ch}\n${ch}`, `${label} with tab/newline`)
  }
})

test('multi-code-unit strings, surrogates and every control character together', () => {
  const controls = []
  for (let c = 0x00; c <= 0x1f; c++) controls.push(String.fromCharCode(c))
  for (let c = 0x7f; c <= 0x9f; c++) controls.push(String.fromCharCode(c))
  const samples = [
    '',
    ' ',
    '\t\n',
    controls.join(''),
    `x${controls.join('y')}z`,
    '😀 海軍\u0000任務\u009F日誌.txt',
    '𝒜\u0085𝒷',
    'a\u2028b\u2029c',
    '\uFEFFbom',
    '# 檔案 1：abc\n---\n  ----  \n# 檔案 2',
    '  #檔案 3\r\n-----\r\n',
    'name#with`ticks`---and   spaces',
    'x'.repeat(300),
    '\uD83D',
    '\uDE00',
    '\uD83D\uDE00\u0007',
    '\u0009\u000A\u000B\u000C\u000D'
  ]
  for (const s of samples) same(s, JSON.stringify(s))
})

test('non-string input is handled exactly as before', () => {
  for (const v of [undefined, null, 0, 42, false, {}, []]) {
    assert.equal(sanitizeBodyForPrompt(v), oldSanitizeBody(v))
    assert.equal(sanitizeFilenameForPrompt(v), oldSanitizeFilename(v))
  }
})
