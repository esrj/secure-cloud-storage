/**
 * Windows 打包設定：npm run build:win（= electron-builder --win --config electron-builder.win.cjs）。
 *
 * 內容完全取自 electron-builder.yml，只差兩處（Windows 智慧分類修復計畫 §4.1）：
 *   1. 不複製智慧分類模型。模型約 4.98 GB，超過 NSIS 單一安裝檔約 2 GB 的上限；
 *      Windows 版改由使用者第一次開啟智慧分類時下載或匯入（windowsClassifierModel.js）。
 *   2. 不帶 node-llama-cpp 的 CUDA 後端（win-x64-cuda + win-x64-cuda-ext，約 545 MB）。
 *      2026-11-06 實測 RTX 2080 Ti（驅動 621.01）上 CUDA 預編譯版判定不相容，
 *      自動選擇的是 Vulkan；隨附 CPU（win-x64）與 Vulkan（win-x64-vulkan）兩種後端。
 *
 * macOS / Linux 仍直接讀 electron-builder.yml，這個檔案不會影響它們的打包結果。
 * 不要直接編輯 dist/builder-effective-config.yaml，那只是打包後的檢查用輸出。
 */
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const yaml = require('js-yaml')

const MODEL_RESOURCE_FROM = 'resources/models'

const base = yaml.load(readFileSync(join(__dirname, 'electron-builder.yml'), 'utf8'))

const baseExtra = Array.isArray(base.extraResources) ? base.extraResources : []
const extraResources = baseExtra.filter((r) => !(r && r.from === MODEL_RESOURCE_FROM))
if (extraResources.length === baseExtra.length) {
  // electron-builder.yml changed shape: fail loudly instead of shipping the model.
  throw new Error(
    `electron-builder.win.cjs: no extraResources entry with from: ${MODEL_RESOURCE_FROM} in electron-builder.yml`
  )
}

module.exports = {
  ...base,
  extraResources,
  files: [
    ...base.files,
    // This file is not covered by electron-builder's default exclude list (.yml / .ts are).
    '!electron-builder.win.cjs',
    '!node_modules/@node-llama-cpp/win-x64-cuda/**',
    '!node_modules/@node-llama-cpp/win-x64-cuda-ext/**'
  ]
}
