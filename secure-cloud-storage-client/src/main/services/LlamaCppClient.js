/**
 * Local LLM inference via node-llama-cpp (main process only).
 *
 * node-llama-cpp is an ESM module with top-level await; it cannot be
 * require()-d from a CommonJS bundle.  All imports are therefore deferred to
 * runtime via dynamic import() which is compatible with ESM from any context.
 *
 * Model path resolution (highest priority first; see classifierModelLocator.js):
 *   1. LLAMA_MODEL_PATH environment variable
 *   2. <projectRoot>/resources/models/<filename>  (dev)
 *   3. <resourcesPath>/models/<filename>           (production)
 * The Windows installer ships without the model and instead looks in the
 * folder the Windows model manager downloads / imports into (between 1 and 3).
 *
 * Windows installer only (windowsClassifierModel.js; null on macOS):
 * the model is checked before loading, the load can be cancelled and has a
 * timeout, progress is reported, a GPU load failure is retried once on the
 * CPU backend, and inference gets a longer timeout. macOS is unchanged.
 *
 * Only one model tier remains: 'fast' = Gemma 4 E4B-it (Q4_K_M GGUF, Apache 2.0).
 * The former 'medium' (9B) and 'high' (27B) tiers were removed in 2026-10 and the
 * Qwen3.5-4B model was replaced by Gemma 4 E4B-it later the same month; the
 * smart-classify UI is a plain on/off switch and any legacy mode value is mapped
 * to 'fast' upstream.
 *
 * Context window is chosen dynamically from the REAL token count of the
 * system + user prompt (measured with the loaded model's own tokenizer),
 * with explicit room reserved for the generated response and the chat
 * template. If the prompt still doesn't fit the largest allowed context, the
 * user prompt is trimmed by tokens so generation never overflows. See the
 * "Token-budget model" block below for the rationale.
 *
 * Gemma 4 thinking mode is opt-in: it only activates when the system prompt
 * STARTS with the `<|think|>` token. We never emit that token, so the model
 * answers directly without a thought channel. The JSON-schema grammar
 * constraint provides a second safety net.
 */
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { existsSync, statSync } from 'node:fs'
import { logger } from '../Logger'
import { resolveModelPath } from './classifierModelLocator.js'
import { getWindowsClassifierSupport } from './windowsClassifierModel.js'
import { ClassifierModelError, MODEL_ERROR, isModelLevelError } from './classifierModelErrors.js'

// ── Mode → model filename mapping ────────────────────────────────────────────
// 2026-10：只保留一個模型（fast）= Gemma 4 E4B-it Q4_K_M。9B（medium）與 27B（high）
// 已移除，原本的 Qwen3.5-4B 也已換成 Gemma 4；前端只剩「開 / 關」，
// 舊的 mode 值在 classifierRuntime / ClassifyService 會落到 fast。
const MODEL_MAP = {
  fast: 'gemma-4-E4B-it-Q4_K_M.gguf'
}

// ── Token-budget model (token-accurate, since 2026-05) ──────────────────────
//
// Earlier versions sized the context window from the document's *character*
// count using a fixed OVERHEAD_TOKENS = 1024 fudge. That was wrong on three
// counts and caused "Failed to compress chat history" throws:
//   V1) The real system prompt is ~700–1100 tokens, not the assumed ~450, and
//       the user-prompt preamble ("本輪門檻…") was never counted at all.
//   V2) "1 Chinese char ≈ 1 token" is model-specific; the 4B and 9B tokenizers
//       compress differently, so a single char budget cannot fit both.
//   V3) The 512-token response budget was not reserved inside the chosen
//       context, so a near-full prompt left no room to generate.
//
// The fix: once the model is loaded we tokenize the ACTUAL system + user text
// with the model's own tokenizer, reserve room for the response and the chat
// template, pick the smallest context tier that fits, and—if even the largest
// allowed context can't hold it—trim the user prompt by tokens so generation
// never overflows.

/** Tokens reserved for the model's generated reply (mirrors maxTokens below). */
const RESPONSE_TOKENS = 512

/**
 * Per-inference wall-clock timeout (ms), keyed by mode.
 *
 * V8 fix: generate() serializes all inferences on a single mutex chain. Without
 * a timeout, one wedged inference (huge prompt, pathological CPU stall) would
 * block EVERY subsequent classification for the whole session. On timeout we
 * abort the generation (via AbortSignal) and tear down the context so the next
 * call rebuilds a clean one.
 */
const GENERATE_TIMEOUT_MS = {
  fast: 90_000
}
const DEFAULT_GENERATE_TIMEOUT_MS = 90_000

/**
 * Slack for chat-template wrapping (Gemma 4 turn markers around the system,
 * user and model turns), BOS/EOS and tier rounding. The template adds only a
 * few dozen tokens; 320 is deliberately generous so we never clip.
 */
const TEMPLATE_MARGIN_TOKENS = 320

/**
 * Candidate context sizes. We allocate the smallest one that fits
 * system + user + RESPONSE_TOKENS + TEMPLATE_MARGIN_TOKENS. The minimum is
 * 2048 because the system prompt alone (~900t) + response (512t) + margin
 * (320t) already needs ~1700t — a 1024 context could never hold it.
 */
const CONTEXT_TIERS_SIZES = [2048, 4096, 8192]
const MIN_CONTEXT_SIZE = CONTEXT_TIERS_SIZES[0]

/**
 * Hard upper bound on the context we will allocate regardless of the model's
 * trained capacity, to keep KV-cache memory and CPU prompt-ingestion time
 * bounded on desktop hardware. Gemma 4 E4B natively supports far more (128k),
 * but head+tail classification snippets never need it.
 */
const HARD_CONTEXT_CAP = CONTEXT_TIERS_SIZES[CONTEXT_TIERS_SIZES.length - 1]

/** Back-compat export: the largest context we will ever allocate. */
export const MAX_CONTEXT_SIZE = HARD_CONTEXT_CAP

/**
 * Coarse CONTENT budget (in characters) for the composite document text built
 * by ClassifyService. This is only a cheap pre-trim so we don't tokenize a
 * huge string; the authoritative, token-accurate fit happens in _doGenerate.
 */
export const MAX_CHUNK_CHARS = 3000

/**
 * @deprecated Context sizing is now token-accurate inside generate() (it uses
 * the model's real tokenizer). This char-based heuristic is retained only for
 * backward compatibility and is no longer used internally.
 * @param {number} charLen
 * @returns {number}
 */
export function pickContextSize(charLen) {
  if (charLen <= 1024) return 2048
  if (charLen <= 3072) return 4096
  return HARD_CONTEXT_CAP
}

const CLASSIFY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          score: { type: 'number' },
          evidence: { type: 'array', items: { type: 'string' } }
        },
        required: ['name', 'score', 'evidence']
      }
    },
    final_labels: { type: 'array', items: { type: 'string' } }
  },
  required: ['labels', 'final_labels']
}

// ── Singletons ────────────────────────────────────────────────────────────────
/** @type {any} cached dynamic-import of node-llama-cpp */
let _nlc = null
let _llama = null
let _model = null
let _context = null
let _grammar = null
/** Currently loaded mode, so we know when to reload */
let _loadedMode = null
/** Context size of the currently allocated _context */
let _loadedCtxSize = 0

// ── Async mutex (serialize generate() calls so the single sequence slot is
//    never double-acquired before the previous one is disposed) ──────────────
let _inferenceChain = Promise.resolve()

/**
 * Lazily import node-llama-cpp using dynamic import().
 */
async function getNLC() {
  if (!_nlc) {
    _nlc = await import('node-llama-cpp')
  }
  return _nlc
}

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * @param {'fast'} mode
 * @returns {string} Absolute path to the GGUF model file.
 */
export function getModelPath(mode = 'fast') {
  return resolveModelPath({
    filename: MODEL_MAP[mode] || MODEL_MAP.fast,
    env: process.env,
    isDev: is.dev,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    // null except in the Windows installer → the original order above.
    managed: getWindowsClassifierSupport()?.managedLocation ?? null
  }).path
}

// ── Initialisation ────────────────────────────────────────────────────────────

/**
 * Dispose current model/context if loaded.
 */
async function teardown() {
  if (_context) { try { await _context.dispose() } catch {} _context = null }
  if (_model) { try { await _model.dispose() } catch {} _model = null }
  _loadedMode = null
  _loadedCtxSize = 0
}

/**
 * Ensure the model for `mode` is loaded. Loading a model does NOT require a
 * context, so afterwards the tokenizer is available for token budgeting.
 * @param {'fast'} mode
 */
async function ensureModel(mode) {
  if (_model && _loadedMode === mode) return

  // Mode changed (or first load): dispose any previous context + model.
  await teardown()

  // Windows installer: a missing / invalid model throws a ClassifierModelError
  // the UI can act on (download / import). null on macOS.
  const win = getWindowsClassifierSupport()
  const notReady = win ? win.checkModelReady() : null
  if (notReady) throw notReady

  const modelPath = getModelPath(mode)
  if (!existsSync(modelPath)) {
    throw new Error(
      `LLM model not found.\n` +
        `Expected: "${modelPath}"\n` +
        `Place ${MODEL_MAP[mode] || MODEL_MAP.fast} inside resources/models/ or set the ` +
        `LLAMA_MODEL_PATH environment variable.`
    )
  }

  const { getLlama } = await getNLC()
  if (!_llama) _llama = await getLlama()

  let sizeMB = 'unknown'
  try { sizeMB = (statSync(modelPath).size / (1024 * 1024)).toFixed(1) } catch {}
  logger.info(`[LLM] Loading model mode="${mode}", path="${modelPath}", size=${sizeMB} MB`)
  _model = win ? await loadModelOnWindows(win, modelPath) : await _llama.loadModel({ modelPath })
  _loadedMode = mode
  logger.info(`[LLM] Model loaded successfully (mode="${mode}", trainCtx=${_safeTrainCtx()})`)
}

/**
 * Windows installer only (fix plan §4.5): the load reports progress, can be
 * cancelled from the UI, times out instead of blocking the whole classify
 * queue, and is retried once on the CPU backend when the GPU backend fails
 * (e.g. an incompatible driver).
 * @param {NonNullable<ReturnType<typeof getWindowsClassifierSupport>>} win
 * @param {string} modelPath
 */
async function loadModelOnWindows(win, modelPath) {
  const abort = new AbortController()
  const release = win.trackRun(abort)
  // On timeout also drop everything queued behind this load.
  const timer = setTimeout(
    () =>
      win.cancelRuns(MODEL_ERROR.LOAD_TIMEOUT, `Model load timed out after ${win.loadTimeoutMs}ms`),
    win.loadTimeoutMs
  )
  let lastPercent = -1
  const onLoadProgress = (p) => {
    const percent = Math.floor(p * 100)
    if (percent >= lastPercent + 2 || percent === 100) {
      lastPercent = percent
      win.emit({ phase: 'model-load', state: 'progress', percent })
    }
  }
  const load = () => _llama.loadModel({ modelPath, loadSignal: abort.signal, onLoadProgress })

  win.emit({ phase: 'model-load', state: 'start' })
  const t0 = Date.now()
  try {
    let model
    try {
      model = await load()
    } catch (e) {
      if (abort.signal.aborted || _llama.gpu === false) throw e
      logger.warn(
        `[LLM] Model load on the ${_llama.gpu} backend failed, retrying on CPU: ${e?.message ?? e}`
      )
      try { await _llama.dispose() } catch { /* ignore */ }
      _llama = null
      _grammar = null // grammars belong to the disposed Llama instance
      const { getLlama } = await getNLC()
      _llama = await getLlama({ gpu: false })
      model = await load()
    }
    logger.info(
      `[LLM] backend=${_llama.gpu || 'cpu'} gpuLayers=${model.gpuLayers} loadMs=${Date.now() - t0}`
    )
    win.emit({ phase: 'model-load', state: 'done' })
    return model
  } catch (e) {
    const reason = abort.signal.aborted ? abort.signal.reason : null
    const err = isModelLevelError(reason)
      ? reason
      : new ClassifierModelError(
          win.modelSource() === 'env' ? MODEL_ERROR.ENV_PATH_INVALID : MODEL_ERROR.LOAD_FAILED,
          `Model load failed: ${e?.message ?? e}`,
          { cause: e }
        )
    logger.warn(`[LLM] Model load stopped (${err.code}): ${err.message}`)
    win.emit({
      phase: 'model-load',
      state: err.code === MODEL_ERROR.CANCELLED ? 'cancelled' : 'failed'
    })
    throw err
  } finally {
    clearTimeout(timer)
    release()
  }
}

/**
 * Ensure a context that fits `ctxSize` exists.
 *
 * V13: previously the context only ever GREW — once a 8192 window was allocated
 * for one large batch it stayed allocated, wasting KV-cache memory on all the
 * small batches that followed. Now we reuse the current context only when it
 * fits AND isn't wildly over-provisioned (≤2× the requested size); otherwise we
 * recreate at the requested size, so memory tracks recent demand within a 2×
 * band (bounded waste, no per-call churn between adjacent tiers).
 * @param {number} ctxSize
 */
async function ensureContext(ctxSize) {
  if (_context && _loadedCtxSize >= ctxSize && _loadedCtxSize <= ctxSize * 2) return
  if (_context) { try { await _context.dispose() } catch {} _context = null }

  logger.info(`[LLM] Creating context mode="${_loadedMode}" contextSize=${ctxSize}`)
  _context = await _model.createContext({ contextSize: ctxSize, sequences: 1 })
  _loadedCtxSize = ctxSize

  if (!_grammar) {
    _grammar = await _llama.createGrammarForJsonSchema(CLASSIFY_JSON_SCHEMA)
  }
}

/** Model's trained context size, clamped sane; safe to call before/after load. */
function _safeTrainCtx() {
  try {
    const t = _model?.trainContextSize
    if (typeof t === 'number' && t > 0) return t
  } catch { /* getter may throw if model disposed */ }
  return HARD_CONTEXT_CAP
}

/** Largest context we may allocate for the current model. */
function modelMaxContext() {
  return Math.min(HARD_CONTEXT_CAP, Math.max(MIN_CONTEXT_SIZE, _safeTrainCtx()))
}

/**
 * Count tokens with the loaded model's tokenizer.
 * Falls back to a char-count estimate only if the tokenizer is unavailable.
 * @param {string} text
 * @returns {number}
 */
function countTokens(text) {
  if (!_model || !text) return 0
  try {
    return _model.tokenize(text).length
  } catch (e) {
    logger.warn(`[LLM] tokenize failed, falling back to char estimate: ${e.message}`)
    return text.length
  }
}

/**
 * Token-accurate fit. Reserves room for the response + chat template, chooses
 * the smallest context tier that holds system + user, and trims the USER
 * prompt (never the system prompt) by tokens if it still doesn't fit the
 * largest allowed context — guaranteeing generation never overflows.
 *
 * Requires the model to already be loaded (call ensureModel first).
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {{ userPrompt: string, ctxSize: number, sysTokens: number, userTokens: number, trimmed: boolean }}
 */
function fitPromptToContext(systemPrompt, userPrompt) {
  const maxCtx = modelMaxContext()
  const sysTokens = countTokens(systemPrompt)
  const promptBudget = maxCtx - RESPONSE_TOKENS - TEMPLATE_MARGIN_TOKENS
  const allowedUser = Math.max(0, promptBudget - sysTokens)

  let finalUser = userPrompt
  let userTokens = countTokens(userPrompt)
  let trimmed = false

  if (userTokens > allowedUser && _model) {
    try {
      const toks = _model.tokenize(userPrompt)
      const kept = toks.slice(0, allowedUser)
      finalUser = _model.detokenize(kept)
      userTokens = kept.length
      trimmed = true
      logger.warn(
        `[LLM] User prompt exceeds context budget; trimmed ${toks.length} → ${userTokens} tokens ` +
          `(sys=${sysTokens}, maxCtx=${maxCtx}, reserve=${RESPONSE_TOKENS}+${TEMPLATE_MARGIN_TOKENS}).`
      )
    } catch (e) {
      logger.warn(`[LLM] token trim failed: ${e.message}`)
    }
  }

  const required = sysTokens + userTokens + RESPONSE_TOKENS + TEMPLATE_MARGIN_TOKENS
  let ctxSize = CONTEXT_TIERS_SIZES.find((t) => t >= required) ?? maxCtx
  ctxSize = Math.max(MIN_CONTEXT_SIZE, Math.min(maxCtx, ctxSize))

  return { userPrompt: finalUser, ctxSize, sysTokens, userTokens, trimmed }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Internal single-inference implementation.
 * Must only be called while holding the mutex (_inferenceChain).
 * @param {string} prompt
 * @param {{ system?: string, temperature?: number, mode?: string, contextSize?: number }} opts
 *   `contextSize` is accepted for backward compatibility but ignored — the
 *   context window is now sized token-accurately from the actual prompt.
 * @param {number} [queuedEpoch] Windows only: cancel epoch when the request was queued
 */
async function _doGenerate(prompt, opts, queuedEpoch) {
  const mode = opts.mode || 'fast'
  const win = getWindowsClassifierSupport()
  // Windows: a request queued before "cancel" / a load timeout stops here.
  if (win) win.throwIfCancelledSince(queuedEpoch)

  // 1) Load the model first so its tokenizer is available for budgeting.
  await ensureModel(mode)

  // 2) Token-accurate fit: measure real tokens of system + user, reserve room
  //    for the response and chat template, trim the user prompt if needed, and
  //    pick the smallest context that fits.  (opts.contextSize is ignored —
  //    context sizing is now owned authoritatively by this function.)
  // No `<|think|>` prefix → Gemma 4 thinking stays off (see header comment).
  const systemPrompt = String(opts.system ?? '').trim()
  const fit = fitPromptToContext(systemPrompt, prompt)

  // 3) Allocate (or grow) the context to the chosen size.
  await ensureContext(fit.ctxSize)
  // Windows: a cancel that arrived after the load but before the inference starts.
  if (win) win.throwIfCancelledSince(queuedEpoch)

  const { LlamaChatSession } = await getNLC()

  // V8: bound the inference with a wall-clock timeout. The AbortSignal makes
  // node-llama-cpp stop generating and throw; the timer is always cleared.
  // Windows uses its own, longer limit (measured; see windowsClassifierModel.js).
  const timeoutMs = win
    ? win.generateTimeoutMs
    : (GENERATE_TIMEOUT_MS[mode] ?? DEFAULT_GENERATE_TIMEOUT_MS)
  const abort = new AbortController()
  const timer = setTimeout(
    () => abort.abort(new Error(`LLM generation timed out after ${timeoutMs}ms (mode="${mode}")`)),
    timeoutMs
  )
  // Windows: the UI's cancel button aborts this inference too.
  const releaseRun = win ? win.trackRun(abort) : null

  const sequence = _context.getSequence()
  try {
    const session = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt,
      autoDisposeSequence: false
    })

    const t0 = Date.now()
    const out = await session.prompt(fit.userPrompt, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.1,
      maxTokens: RESPONSE_TOKENS,
      grammar: _grammar,
      signal: abort.signal
    })
    const dur = Date.now() - t0
    const preview = String(out).replace(/\s+/g, ' ').slice(0, 240)
    logger.info(
      `[LLM] generate done mode="${mode}" ctx=${fit.ctxSize} ` +
        `sysTok=${fit.sysTokens} userTok=${fit.userTokens}${fit.trimmed ? ' (trimmed)' : ''} ` +
        `${dur}ms outLen=${out.length} preview="${preview}"`
    )
    return out
  } catch (e) {
    // On timeout/abort the context/sequence may be left mid-generation. Drop
    // the context so the NEXT call rebuilds a clean one rather than inheriting
    // a half-evaluated state. The serialized mutex guarantees no other call is
    // using it right now.
    if (abort.signal.aborted) {
      logger.warn(`[LLM] generation aborted (timeout ${timeoutMs}ms, mode="${mode}"); tearing down context`)
      try { await _context?.dispose() } catch { /* ignore */ }
      _context = null
      _loadedCtxSize = 0
    }
    if (win && abort.signal.aborted) throw windowsAbortError(abort.signal, e)
    throw e
  } finally {
    clearTimeout(timer)
    releaseRun?.()
    try { await sequence.dispose() } catch { /* ignore */ }
  }
}

/** Windows: turn an aborted inference into CLASSIFY_CANCELLED or GENERATE_TIMEOUT. */
function windowsAbortError(signal, cause) {
  const reason = signal.reason
  if (isModelLevelError(reason)) return reason
  return new ClassifierModelError(
    MODEL_ERROR.GENERATE_TIMEOUT,
    reason instanceof Error ? reason.message : 'LLM generation timed out',
    { cause }
  )
}

/**
 * Run a single classification inference.
 * Calls are serialized via an async mutex so the single context sequence
 * slot is never double-acquired (prevents "No sequences left" errors).
 *
 * @param {string} prompt
 * @param {{ system?: string, temperature?: number, mode?: string, contextSize?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function generate(prompt, opts = {}) {
  let resolveSlot, rejectSlot
  const slot = new Promise((res, rej) => { resolveSlot = res; rejectSlot = rej })
  // Windows only (undefined elsewhere): lets a later cancel drop this queued request.
  const queuedEpoch = getWindowsClassifierSupport()?.runEpoch()

  _inferenceChain = _inferenceChain
    .then(() => _doGenerate(prompt, opts, queuedEpoch))
    .then(resolveSlot, rejectSlot)

  return slot
}

/**
 * Release all resources (call on app quit if desired).
 */
export async function dispose() {
  await teardown()
  if (_llama) { await _llama.dispose(); _llama = null }
  _grammar = null
  _nlc = null
}
