// Run: npm run test:classifier
// (node --test --experimental-test-module-mocks test/classifier/*.test.mjs)
//
// ClassifyService with its LLM / text extraction / settings / logger mocked.
// The macOS cases compare against classify-mac.snapshot.json, which was
// recorded from the ClassifyService *before* the Windows model manager was
// added (UPDATE_SNAPSHOT=1 rewrites it). They must keep passing unchanged:
// without the Windows manager the result format may not change at all.
import { test, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = (p) => new URL(`../../src/main/${p}`, import.meta.url).href
const snapshotPath = fileURLToPath(new URL('./classify-mac.snapshot.json', import.meta.url))

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const state = {
  /** @type {(prompt: string, opts: object) => Promise<string>} */
  generate: async () => '',
  generateCalls: 0,
  extractCalls: 0,
  /** @type {Record<string, string>} */
  texts: {},
  /** null = macOS / manager off; object = Windows manager active */
  support: null
}

mock.module(src('services/LlamaCppClient.js'), {
  namedExports: {
    MAX_CHUNK_CHARS: 3000,
    generate: (prompt, opts) => {
      state.generateCalls += 1
      return state.generate(prompt, opts)
    }
  }
})
mock.module(src('services/TextExtractService.js'), {
  namedExports: {
    extractTextFromFiles: async (paths) => {
      state.extractCalls += 1
      const texts = paths
        .filter((p) => state.texts[p])
        .map((p) => ({ path: p, text: state.texts[p] }))
      return texts.length
        ? { supported: true, texts }
        : { supported: false, reason: 'X', texts: [] }
    }
  }
})
mock.module(src('services/classifierSettings.js'), {
  namedExports: { getClassifierSettings: () => ({ classifierThreshold: 0.55 }) }
})
mock.module(src('Logger.js'), { namedExports: { logger: quiet } })
if (existsSync(fileURLToPath(src('services/windowsClassifierModel.js')))) {
  mock.module(src('services/windowsClassifierModel.js'), {
    namedExports: { getWindowsClassifierSupport: () => state.support }
  })
}

const { classifyDocuments } = await import(src('services/ClassifyService.js'))
const { ClassifierModelError, MODEL_ERROR } = await import(src('services/classifierModelErrors.js'))

const GOOD_JSON = JSON.stringify({
  labels: [
    { name: '海軍', score: 0.91, evidence: ['檔案 1：海軍艦隊'] },
    { name: '陸軍', score: 0.1, evidence: [] },
    { name: '空軍', score: 0.05, evidence: [] },
    { name: '聯合作戰', score: 0.2, evidence: [] },
    { name: '演訓戰備', score: 0.6, evidence: ['檔案 1：遠洋航行訓練'] },
    { name: '其他', score: 0.02, evidence: [] }
  ],
  final_labels: ['海軍', '演訓戰備']
})
const NOT_FOUND_MSG =
  'LLM model not found.\nExpected: "C:\\app\\resources\\models\\gemma-4-E4B-it-Q4_K_M.gguf"\n' +
  'Place gemma-4-E4B-it-Q4_K_M.gguf inside resources/models/ or set the LLAMA_MODEL_PATH environment variable.'

const one = ['C:/docs/海軍任務日誌.txt']
// 20 files → 2 inference groups (16 files per run at most).
const twenty = Array.from({ length: 20 }, (_, i) => `C:/docs/報告-${i + 1}.txt`)

beforeEach(() => {
  state.generate = async () => GOOD_JSON
  state.generateCalls = 0
  state.extractCalls = 0
  state.texts = { [one[0]]: '海軍艦隊於本月進行遠洋航行訓練，潛艦部隊同步執行反潛偵蒐任務。' }
  for (const p of twenty) state.texts[p] = '陸軍裝甲旅實施戰車射擊與步兵協同演練。'
  state.support = null
})

/** Each case returns what the macOS snapshot records. */
const macCases = {
  disabled: async () => classifyDocuments({ enable: false, paths: one }),
  modeOff: async () => classifyDocuments({ paths: one, mode: 'off' }),
  noFiles: async () => classifyDocuments({ paths: [], mode: 'fast' }),
  success: async () => classifyDocuments({ paths: one, mode: 'fast', threshold: 0.55 }),
  legacyModeSuccess: async () => classifyDocuments({ paths: one, mode: 'high', threshold: 0.55 }),
  modelMissing: async () => {
    state.generate = async () => {
      throw new Error(NOT_FOUND_MSG)
    }
    const result = await classifyDocuments({ paths: twenty, mode: 'fast', threshold: 0.55 })
    return { result, generateCalls: state.generateCalls }
  },
  timeout: async () => {
    state.generate = async () => {
      throw new Error('LLM generation timed out after 90000ms (mode="fast")')
    }
    return classifyDocuments({ paths: one, mode: 'fast', threshold: 0.55 })
  },
  jsonParseFailed: async () => {
    state.generate = async () => 'not json at all'
    return classifyDocuments({ paths: one, mode: 'fast', threshold: 0.55 })
  },
  firstGroupFailsSecondOk: async () => {
    state.generate = async () => {
      if (state.generateCalls === 1) throw new Error('Failed to compress chat history')
      return GOOD_JSON
    }
    const result = await classifyDocuments({ paths: twenty, mode: 'fast', threshold: 0.55 })
    return { result, generateCalls: state.generateCalls }
  },
  progressAndDebug: async () => {
    const progress = []
    const result = await classifyDocuments({
      paths: twenty,
      mode: 'fast',
      threshold: 0.4,
      debug: true,
      onProgress: (p) => progress.push(p)
    })
    return { result, progress }
  }
}

const normalize = (v) => JSON.parse(JSON.stringify(v))

test('macOS behaviour matches the snapshot recorded before the Windows changes', async (t) => {
  const actual = {}
  for (const [name, run] of Object.entries(macCases)) {
    beforeEachReset()
    actual[name] = normalize(await run())
  }
  if (process.env.UPDATE_SNAPSHOT === '1' || !existsSync(snapshotPath)) {
    writeFileSync(snapshotPath, JSON.stringify(actual, null, 2) + '\n')
    t.diagnostic(`snapshot written: ${snapshotPath}`)
    return
  }
  const expected = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  for (const name of Object.keys(macCases)) {
    assert.deepStrictEqual(actual[name], expected[name], `case "${name}" changed`)
  }
})

function beforeEachReset() {
  state.generate = async () => GOOD_JSON
  state.generateCalls = 0
  state.extractCalls = 0
  state.support = null
}

// ── Windows (model manager active) ─────────────────────────────────────────

function fakeSupport({ ready = null } = {}) {
  return { checkModelReady: () => ready }
}

test('windows: missing model fails before text extraction, with a setup hint', async () => {
  state.support = fakeSupport({
    ready: new ClassifierModelError(
      MODEL_ERROR.NOT_INSTALLED,
      'Model not installed: "C:\\x\\m.gguf"'
    )
  })
  const r = await classifyDocuments({ paths: one, mode: 'fast', threshold: 0.55 })
  assert.equal(state.extractCalls, 0)
  assert.equal(state.generateCalls, 0)
  assert.equal(r.supported, false)
  assert.equal(r.reason, 'LLM_GENERATE_FAILED')
  assert.deepEqual(r.labels, [])
  assert.deepEqual(r.final_labels, [])
  assert.equal(r.thresholdUsed, 0.55)
  assert.equal(r.userHint.code, MODEL_ERROR.NOT_INSTALLED)
  assert.equal(r.userHint.action, 'setup')
  assert.doesNotMatch(r.userHint.message, /[A-Z]:\\|LLAMA_MODEL_PATH|gguf/)
})

test('windows: a model-level error stops the remaining groups', async () => {
  state.support = fakeSupport()
  state.generate = async () => {
    throw new ClassifierModelError(MODEL_ERROR.LOAD_FAILED, 'loadModel failed: out of memory')
  }
  const r = await classifyDocuments({ paths: twenty, mode: 'fast', threshold: 0.55 })
  assert.equal(state.generateCalls, 1, 'second group must not trigger another load')
  assert.equal(r.reason, 'LLM_GENERATE_FAILED')
  assert.equal(r.userHint.code, MODEL_ERROR.LOAD_FAILED)
  assert.equal(r.userHint.action, 'retry')
})

test('windows: cancel and timeout map to retry hints', async () => {
  state.support = fakeSupport()
  for (const code of [
    MODEL_ERROR.CANCELLED,
    MODEL_ERROR.GENERATE_TIMEOUT,
    MODEL_ERROR.LOAD_TIMEOUT
  ]) {
    state.generateCalls = 0
    state.generate = async () => {
      throw new ClassifierModelError(code, code)
    }
    const r = await classifyDocuments({ paths: twenty, mode: 'fast', threshold: 0.55 })
    assert.equal(state.generateCalls, 1, code)
    assert.equal(r.userHint.code, code)
    assert.equal(r.userHint.action, 'retry')
  }
})

test('windows: ordinary generate errors still try every group, as before', async () => {
  state.support = fakeSupport()
  state.generate = async () => {
    throw new Error('Failed to compress chat history')
  }
  const r = await classifyDocuments({ paths: twenty, mode: 'fast', threshold: 0.55 })
  assert.equal(state.generateCalls, 2)
  assert.equal(r.reason, 'LLM_GENERATE_FAILED')
  assert.equal(r.llmError, 'Failed to compress chat history')
  assert.equal(r.userHint.code, 'GENERATE_FAILED')
})

test('windows: JSON parse failure gets a hint, success gets none', async () => {
  state.support = fakeSupport()
  state.generate = async () => 'not json'
  const bad = await classifyDocuments({ paths: one, mode: 'fast', threshold: 0.55 })
  assert.equal(bad.reason, 'JSON_PARSE_FAILED')
  assert.equal(bad.userHint.code, 'JSON_PARSE_FAILED')

  state.generate = async () => GOOD_JSON
  const ok = await classifyDocuments({ paths: one, mode: 'fast', threshold: 0.55 })
  state.support = null
  const mac = await classifyDocuments({ paths: one, mode: 'fast', threshold: 0.55 })
  assert.equal(ok.supported, true)
  assert.equal('userHint' in ok, false)
  assert.deepStrictEqual(
    normalize(ok),
    normalize(mac),
    'successful results are identical on both platforms'
  )
})
