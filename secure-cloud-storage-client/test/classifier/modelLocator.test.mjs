// Run: npm run test:classifier
// Model search order with injected platform / env / file checks (fix plan §6.1).
// process.platform is never modified.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import {
  getManagedModelDir,
  isModelManagerEnabled,
  resolveModelPath
} from '../../src/main/services/classifierModelLocator.js'
import { CLASSIFY_MODEL } from '../../src/main/services/classifierModelManifest.js'
import {
  ClassifierModelError,
  MODEL_ERROR,
  buildUserHint,
  isModelLevelError,
  withUserHint
} from '../../src/main/services/classifierModelErrors.js'

const FILE = 'gemma-4-E4B-it-Q4_K_M.gguf'

/**
 * LlamaCppClient.getModelPath() exactly as it was before the Windows model
 * manager (git 5a63188), with its globals turned into parameters.
 */
function originalGetModelPath({ env, isDev, appPath, resourcesPath, join }) {
  if (env.LLAMA_MODEL_PATH) return env.LLAMA_MODEL_PATH
  const filename = FILE
  if (isDev) {
    return join(appPath, 'resources', 'models', filename)
  }
  return join(resourcesPath, 'models', filename)
}

test('macOS: unmanaged order is identical to the original getModelPath', () => {
  const appPath = '/Users/me/secure-cloud-storage-client'
  const resourcesPath = '/Applications/client-side.app/Contents/Resources'
  const envs = [{}, { LLAMA_MODEL_PATH: '' }, { LLAMA_MODEL_PATH: '/opt/models/custom.gguf' }]
  for (const env of envs) {
    for (const isDev of [true, false]) {
      const ctx = { env, isDev, appPath, resourcesPath }
      const got = resolveModelPath({ ...ctx, filename: FILE, managed: null, path: path.posix })
      assert.equal(
        got.path,
        originalGetModelPath({ ...ctx, join: path.posix.join }),
        JSON.stringify(ctx)
      )
    }
  }
  assert.deepEqual(
    resolveModelPath({
      filename: FILE,
      env: {},
      isDev: false,
      appPath,
      resourcesPath,
      path: path.posix
    }),
    {
      path: '/Applications/client-side.app/Contents/Resources/models/gemma-4-E4B-it-Q4_K_M.gguf',
      source: 'bundled'
    }
  )
})

test('the manager is off on macOS and Linux, and in Windows dev mode by default', () => {
  const off = [
    { platform: 'darwin', isPackaged: true, env: {} },
    { platform: 'darwin', isPackaged: true, env: { SCS_MODEL_MANAGER: '1' } },
    { platform: 'linux', isPackaged: true, env: {} },
    { platform: 'win32', isPackaged: false, env: {} },
    { platform: 'win32', isPackaged: true, env: { SCS_MODEL_MANAGER: '0' } }
  ]
  for (const ctx of off) assert.equal(isModelManagerEnabled(ctx), false, JSON.stringify(ctx))
  assert.equal(isModelManagerEnabled({ platform: 'win32', isPackaged: true, env: {} }), true)
  assert.equal(
    isModelManagerEnabled({
      platform: 'win32',
      isPackaged: false,
      env: { SCS_MODEL_MANAGER: '1' }
    }),
    true
  )
})

test('windows: managed folder is under LocalAppData and shared by every CLIENT_PROFILE', () => {
  const base = { homedir: 'C:\\Users\\王小明', appName: 'client-side', path: path.win32 }
  const local = 'C:\\Users\\王小明\\AppData\\Local'
  assert.equal(
    getManagedModelDir({ ...base, env: { LOCALAPPDATA: local } }),
    'C:\\Users\\王小明\\AppData\\Local\\client-side\\models'
  )
  assert.equal(
    getManagedModelDir({ ...base, env: { LOCALAPPDATA: local, CLIENT_PROFILE: 'test' } }),
    getManagedModelDir({ ...base, env: { LOCALAPPDATA: local } })
  )
  assert.equal(getManagedModelDir({ ...base, env: {} }), `${local}\\client-side\\models`)
})

test('windows installer: env → verified managed model → bundled copy', () => {
  const dir = 'C:\\Users\\me\\AppData\\Local\\client-side\\models'
  const resourcesPath = 'C:\\Program Files\\client-side\\resources'
  const managedFile = `${dir}\\${FILE}`
  const bundledFile = `${resourcesPath}\\models\\${FILE}`
  const ctx = (env, ready, bundled) => ({
    filename: FILE,
    env,
    isDev: false,
    appPath: `${resourcesPath}\\app.asar`,
    resourcesPath,
    path: path.win32,
    managed: {
      dir,
      isReady: (p) => ready && p === managedFile,
      exists: (p) => bundled && p === bundledFile
    }
  })

  assert.deepEqual(resolveModelPath(ctx({}, true, true)), { path: managedFile, source: 'managed' })
  assert.deepEqual(resolveModelPath(ctx({}, false, true)), { path: bundledFile, source: 'bundled' })
  assert.deepEqual(resolveModelPath(ctx({}, false, false)), {
    path: managedFile,
    source: 'managed'
  })
  // An explicit LLAMA_MODEL_PATH wins and is never silently replaced, even
  // when it points nowhere and a valid model exists.
  assert.deepEqual(resolveModelPath(ctx({ LLAMA_MODEL_PATH: 'D:\\missing.gguf' }, true, true)), {
    path: 'D:\\missing.gguf',
    source: 'env'
  })
})

test('windows dev mode keeps the original order', () => {
  const got = resolveModelPath({
    filename: FILE,
    env: {},
    isDev: true,
    appPath: 'C:\\src\\secure-cloud-storage-client',
    resourcesPath: 'C:\\src\\node_modules\\electron\\dist\\resources',
    managed: null,
    path: path.win32
  })
  assert.equal(got.path, `C:\\src\\secure-cloud-storage-client\\resources\\models\\${FILE}`)
})

test('the pinned manifest matches the model LlamaCppClient loads', () => {
  const src = readFileSync(
    new URL('../../src/main/services/LlamaCppClient.js', import.meta.url),
    'utf8'
  )
  assert.match(src, new RegExp(`fast:\\s*'${CLASSIFY_MODEL.filename.replaceAll('.', '\\.')}'`))
  assert.equal(CLASSIFY_MODEL.filename, FILE)
  assert.match(CLASSIFY_MODEL.sha256, /^[0-9a-f]{64}$/)
  assert.match(CLASSIFY_MODEL.revision, /^[0-9a-f]{40}$/)
  assert.ok(
    CLASSIFY_MODEL.url.includes(`/resolve/${CLASSIFY_MODEL.revision}/${CLASSIFY_MODEL.filename}`)
  )
  assert.ok(CLASSIFY_MODEL.size > 4e9 && CLASSIFY_MODEL.size < 5e9)
})

test('user hints: model-level codes win, raw details never reach the message', () => {
  const err = new ClassifierModelError(
    MODEL_ERROR.NOT_INSTALLED,
    'Model not installed: "C:\\x\\y.gguf"'
  )
  assert.ok(isModelLevelError(err))
  assert.equal(isModelLevelError(new Error('plain')), false)
  assert.deepEqual(buildUserHint('LLM_GENERATE_FAILED', err).code, MODEL_ERROR.NOT_INSTALLED)
  assert.equal(buildUserHint('LLM_GENERATE_FAILED', new Error('x')).code, 'GENERATE_FAILED')
  assert.equal(buildUserHint('JSON_PARSE_FAILED', null).code, 'JSON_PARSE_FAILED')
  assert.equal(buildUserHint('SOMETHING_NEW', null).code, 'GENERATE_FAILED')
  for (const code of [
    ...Object.values(MODEL_ERROR),
    'JSON_PARSE_FAILED',
    'EMPTY_CONTENT',
    'CLASSIFY_EXCEPTION'
  ]) {
    const hint = buildUserHint('LLM_GENERATE_FAILED', { code })
    assert.ok(hint.message.length > 0, code)
    assert.doesNotMatch(hint.message, /LLAMA_MODEL_PATH|[A-Z]:\\|LLM_GENERATE_FAILED/, code)
  }
})

test('withUserHint leaves results untouched without the Windows manager (macOS)', () => {
  const failed = { supported: false, reason: 'LLM_GENERATE_FAILED', labels: [], final_labels: [] }
  assert.equal(withUserHint(failed, new Error('x'), null), failed)
  const ok = { supported: true, labels: [], final_labels: [] }
  assert.equal(withUserHint(ok, null, {}), ok)
  assert.equal(withUserHint(failed, null, {}).userHint.code, 'GENERATE_FAILED')
})
