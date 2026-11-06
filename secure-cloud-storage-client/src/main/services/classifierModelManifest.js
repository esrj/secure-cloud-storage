/**
 * Trusted version info for the smart-classify model, used only by the Windows
 * model manager (download / import / verification). macOS and Linux bundle the
 * model inside the installer and never read this file.
 *
 * Pinned to one Hugging Face commit and to the file's SHA-256 (the repo's LFS
 * object id). The hash ships with the client and is never fetched at runtime:
 * an integrity check must not trust the server whose data it is checking.
 *
 * To move to a new model revision, update every field together (revision, url,
 * size, sha256) from
 *   https://huggingface.co/api/models/unsloth/gemma-4-E4B-it-GGUF/paths-info/<commit>
 * and keep `filename` equal to MODEL_MAP.fast in LlamaCppClient.js.
 */
export const CLASSIFY_MODEL = Object.freeze({
  name: 'Gemma 4 E4B-it (Q4_K_M)',
  filename: 'gemma-4-E4B-it-Q4_K_M.gguf',
  size: 4_977_171_584,
  sha256: '85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87',
  repo: 'unsloth/gemma-4-E4B-it-GGUF',
  // 2026-07-17 "Added Gemma official chat template update" — the last commit
  // that changed gemma-4-E4B-it-Q4_K_M.gguf.
  revision: 'bfc15c382204943c3a8fff0c750b94ae2364d7a3',
  url: 'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q4_K_M.gguf',
  license: 'Apache-2.0'
})
