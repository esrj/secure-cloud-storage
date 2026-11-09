// Run: npm run test:classifier
// (node --test --experimental-test-module-mocks test/classifier/*.test.mjs)
//
// 2026-11-09: makeUploadBatchClassifyKey used Array.prototype.sort() without a
// compare function (SonarQube S2871). compareCodeUnits must reproduce the
// default order exactly so the cache key for a given set of paths is unchanged.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

const { compareCodeUnits, makeUploadBatchClassifyKey } = await import(
  src('services/preUploadClassifyCache.js')
)

// Reference: the key exactly as it was computed before 2026-11-09.
function oldKey(paths) {
  const sorted = [...paths].filter((p) => typeof p === 'string' && p.trim()).sort()
  return createHash('sha256').update(sorted.join('\0'), 'utf8').digest('hex').slice(0, 32)
}

const SAMPLES = [
  ['C:/docs/海軍任務日誌.txt', 'C:/docs/a.txt', 'C:/docs/B.txt', 'c:/docs/b.txt'],
  [
    '/Users/sam/檔案 (2).pdf',
    '/Users/sam/檔案.pdf',
    '/Users/sam/檔案 (10).pdf',
    '/Users/sam/檔案 (1).pdf'
  ],
  [
    '😀.txt',
    'Z.txt',
    'z.txt',
    '_.txt',
    '~.txt',
    '1.txt',
    '１.txt',
    'ä.txt',
    'a\u0308.txt',
    'Å.txt'
  ],
  ['', '  ', 'x', 42, null, undefined, 'x/y', 'x y', 'x\u0000y', 'x\uFFFFy'],
  ['same', 'same', 'Same', 'SAME', 'samé'],
  ['dir/sub/file.txt', 'dir/sub-file.txt', 'dir/sub.file.txt', 'dir/sub file.txt', 'dir/sub'],
  ['\uD83D\uDE00', '\uE000', '\uFB01', 'ｆｉ', 'fi']
]

test('compareCodeUnits orders strings exactly like the default sort', () => {
  for (const sample of SAMPLES) {
    const strings = sample.filter((p) => typeof p === 'string')
    assert.deepEqual([...strings].sort(compareCodeUnits), [...strings].sort())
  }
})

test('compareCodeUnits matches the default order on random strings', () => {
  let seed = 20261109
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  for (let round = 0; round < 2000; round++) {
    const arr = []
    const len = 1 + rnd(12)
    for (let i = 0; i < len; i++) {
      let s = ''
      const slen = rnd(6)
      for (let j = 0; j < slen; j++) {
        // Mix ASCII, CJK, surrogates and a few control characters.
        const pick = rnd(5)
        const cu =
          pick === 0
            ? 0x20 + rnd(0x5f)
            : pick === 1
              ? 0x4e00 + rnd(0x100)
              : pick === 2
                ? 0xd800 + rnd(0x800)
                : pick === 3
                  ? rnd(0x20)
                  : rnd(0x10000)
        s += String.fromCharCode(cu)
      }
      arr.push(s)
    }
    assert.deepEqual([...arr].sort(compareCodeUnits), [...arr].sort(), JSON.stringify(arr))
  }
})

test('makeUploadBatchClassifyKey is unchanged for every sample', () => {
  for (const sample of SAMPLES) {
    assert.equal(makeUploadBatchClassifyKey(sample), oldKey(sample), JSON.stringify(sample))
  }
})
