# Windows 智慧分類修復計畫

- 建立日期：2026-11-06。
- 來源：自 [Windows 相容性修復計畫](Windows相容性修復計畫.md) 的 W4 抽出，並合併該計畫中 W5 打包、測試、回退與追蹤裡和智慧分類有關的條目。
- 狀態：待實作；尚未修改程式，也尚未在 Windows 實機驗證。
- 範圍：Windows Client 的本機智慧分類（上傳前為整批檔案建議標籤）。智慧搜尋走伺服器上的 Ollama 與 SSH 通道，屬於原計畫 W3，不在本文件範圍。
- 首要限制：**不得改變 macOS 已正常運作的模型位置、模型、提示詞與分類行為。**
- 依據：2026-11-06 的 Client 原始碼。第 1 節的現況都已逐項對照程式碼確認。

## 1. 功能現況

使用者在檔案列表打開「智慧分類」開關（[FileViewButtonGroup.jsx:84](secure-cloud-storage-client/src/renderer/src/components/FileViewButtonGroup.jsx#L84)）後，選檔上傳時，Client 在本機依序執行：

1. 擷取 txt、md、pdf、docx 的內文；擷取失敗的檔案只用檔名參與判斷。
2. 把每個檔案的檔名和頭尾摘要組成一段提示詞。
3. 用 node-llama-cpp 載入本機 Gemma 4 E4B-it 模型，推論出 JSON 格式的標籤與分數。
4. 以門檻（預設 0.55）篩出建議標籤，在上傳後的對話框讓使用者確認或修改。

整個流程在本機完成，不把文件內容送到外部服務。

| 項目 | 現況 | 位置 |
|---|---|---|
| 模型 | `gemma-4-E4B-it-Q4_K_M.gguf`，約 4.98 GB，來源 Hugging Face `unsloth/gemma-4-E4B-it-GGUF`；需要 node-llama-cpp 3.19 以上（目前 3.22.2） | [resources/models/README.txt](secure-cloud-storage-client/resources/models/README.txt) |
| 模型搜尋順序 | `LLAMA_MODEL_PATH` → 開發版 `<appPath>/resources/models` → 安裝版 `<resourcesPath>/models` | [LlamaCppClient.js:179-186](secure-cloud-storage-client/src/main/services/LlamaCppClient.js#L179-L186) |
| 打包 | `extraResources` 寫在共用區，所有平台都會複製模型；模型檔不在 git 裡 | [electron-builder.yml:43-47](secure-cloud-storage-client/electron-builder.yml#L43-L47) |
| 推論原生元件 | node-llama-cpp 依平台安裝預先編譯的執行檔。開發機目前只有 `mac-arm64-metal`；Windows 有 `win-x64`、`win-x64-cuda`、`win-x64-cuda-ext`、`win-x64-vulkan`、`win-arm64`。`getLlama()` 沒有指定參數，會自動選擇 GPU 後端 | [LlamaCppClient.js:222](secure-cloud-storage-client/src/main/services/LlamaCppClient.js#L222) |
| 逾時 | 每次推論 90 秒，逾時後中止並重建 context。**模型載入不在逾時範圍內**，也無法取消 | [LlamaCppClient.js:345-367](secure-cloud-storage-client/src/main/services/LlamaCppClient.js#L345-L367) |
| 缺模型時 | 拋出開發者用的訊息（要使用者把檔案放進 `resources/models/` 或設定 `LLAMA_MODEL_PATH`），分類回傳 `LLM_GENERATE_FAILED`；介面直接顯示錯誤代碼與原文 | [ClassifyService.js:318-354](secure-cloud-storage-client/src/main/services/ClassifyService.js#L318-L354)、[PostUploadDialog.jsx:250](secure-cloud-storage-client/src/renderer/src/components/PostUploadDialog.jsx#L250) |
| 進度通知 | 前端已訂閱 `classifier-llm-progress`，但主程序目前沒有任何地方送出這個事件（Ollama 時期留下的通道） | [classifierPreloadMerge.js:18](secure-cloud-storage-client/src/preload/classifierPreloadMerge.js#L18)、[PostUploadDialog.jsx:64-77](secure-cloud-storage-client/src/renderer/src/components/PostUploadDialog.jsx#L64-L77) |
| 自動化測試 | Client 的 `test/` 只有安全金鑰測試，智慧分類沒有測試 | [test/fido/](secure-cloud-storage-client/test/fido/) |

## 2. Windows 上的問題與原因

### C1. 安裝版沒有模型，功能等於無法使用

- **原因：** 模型檔不在 git 裡。在 Windows 建置機重新 clone 後，`resources/models` 只有 README，`extraResources` 篩不到模型，所以安裝檔不含模型。程式又只會到安裝資源目錄找，使用者唯一的辦法是自己設定環境變數 `LLAMA_MODEL_PATH`。
- **現況佐證：** [win_build.md](secure-cloud-storage-client/win_build.md) 把模型列為「不在這份指南範圍」。

### C2. 建置機有模型時，安裝檔會超過 NSIS 的大小上限

- **原因：** `extraResources` 寫在共用區，Windows 打包也會帶上 5 GB 的模型，超過 NSIS 單一安裝檔約 2 GB 的上限。

### C3. 錯誤訊息是給開發者看的

- **原因：** 缺模型時顯示的是檔案路徑和環境變數名稱，介面只會出現 `LLM_GENERATE_FAILED`。一般使用者看不出是「還沒下載模型」，也不知道下一步該怎麼做。

### C4. 原生推論元件與硬體差異

- **原因：** node-llama-cpp 依建置平台安裝原生執行檔（專案設定為 `npmRebuild: false`），Windows 安裝檔必須在 Windows 上建置。GPU 後端（CPU、Vulkan、CUDA）的選擇、顯示卡驅動不相容時能否退回 CPU，以及記憶體需求，都還沒在 Windows 上量測過。

### C5. 模型載入時間不受控制

- **原因：** 90 秒逾時計時器在模型與 context 建立「之後」才開始。如果電腦用的是傳統硬碟、記憶體不足，或防毒軟體正在掃描 5 GB 的檔案，第一次載入可能很久，而且使用者無法取消；所有分類請求都排在同一條佇列，會一起被卡住。

### C6. 每個 profile 各有一份 userData

- **原因：** [profile.js](secure-cloud-storage-client/src/main/profile.js) 會把 `userData` 改成 `<userData>-<profile>`。如果照原計畫把模型下載到「目前 profile 的 userData/models」，每多一個 profile 就要再下載一份 5 GB。

### C7. 文件與程式不一致（次要）

- [classifierSettings.js](secure-cloud-storage-client/src/main/services/classifierSettings.js) 開頭的註解寫模型位置是 `<userData>/models/model.gguf`，和實際的搜尋順序不符。修改模型搜尋順序時一併更正。

## 3. macOS 保護原則

- Windows 專用的模型管理、下載與匯入，以 `process.platform === 'win32'` 或平台工廠選用；macOS 不載入這些模組也能正常啟動。
- 維持不變：macOS 的 `LLAMA_MODEL_PATH` 優先序、開發版與安裝版模型位置、模型名稱、分類提示詞、JSON grammar、token 預算與 90 秒推論逾時。
- Windows 排除模型必須透過 Windows 專用規則達成：不可刪除或暫時搬走共用的 `resources/models` 模型，也不可在所有平台移除模型資源。
- 第一版的下載與匯入流程只在 Windows 啟用；macOS 預設不觸發。
- 修改共用檔案（例如 `LlamaCppClient.js`、`ClassifyService.js`）時，維持現有對外介面與回傳格式，並以回歸測試確認 macOS 有模型時的行為完全相同。

## 4. 修復方案

### 4.1 打包：Windows 安裝檔不含模型（處理 C2、C4）

1. 將模型的 `extraResources` 改成只對 macOS（與 Linux）生效，Windows 不複製 `.gguf`。可行做法有兩種：
   - 甲：把模型那一項從共用區移到 `mac:`（與 `linux:`）區塊。
   - 乙：保留共用區，另建 Windows 專用設定檔，打包 Windows 時以 `--config` 指定。

   兩種做法擇一，判定標準是 **macOS 實際合併後的設定與修改前完全相同**。以 electron-builder 輸出的 `dist/builder-effective-config.yaml` 比對兩個平台的結果；這個檔案只用來檢查，不可直接修改。
2. 在 Windows x64 建置機上執行 `npm ci`，確認安裝了 `@node-llama-cpp/win-x64`，並且依 `asarUnpack` 放在 asar 之外。
3. 決定要隨附哪些 GPU 後端：CPU（`win-x64`）一定要帶；Vulkan 與 CUDA 依第 4.5 節的量測結果與安裝檔大小決定。ARM64 另外驗證，不以 x64 的結果推定可用。

### 4.2 模型取得：首次啟用時下載、匯入或稍後設定（處理 C1）

1. 使用者第一次打開智慧分類開關、但還沒有可用的模型時，顯示「下載模型」「匯入模型」「稍後設定」三個選項。選擇稍後設定時，開關維持關閉，基本檔案功能不受影響。
2. **下載：**
   - 開始前顯示檔案大小與所需空間，空間不足時直接提示，不開始下載。
   - 提供進度、取消、重試與續傳（HTTP Range）。
   - 先寫入暫存檔（例如 `*.part`），以可信版本資訊中的 SHA-256 校驗，通過後才改名成正式檔。
   - 可信版本資訊需固定上游的版本（Hugging Face 的 commit）與 SHA-256，隨 Client 版本一起發佈，不在執行期向來源網站取得要比對的雜湊值。
   - 進度可沿用前端已訂閱、但目前沒有使用的 `classifier-llm-progress` 通道，或改用新的通道並移除舊訂閱；兩者擇一，避免同時存在兩套。
3. **離線匯入：** 公司或學校網路可能封鎖 Hugging Face，所以匯入是必要功能，不是附加功能。使用者選擇檔案後，檢查檔名、大小與 SHA-256，通過後複製到模型資料夾。
4. 取消、磁碟不足、校驗失敗與檔案毀損，都不能覆蓋或刪除原本可用的模型。
5. 下載只取得模型檔，不送出文件內容、分類片段或任何 metadata。

### 4.3 模型位置與搜尋順序（處理 C1、C6）

1. Windows 安裝版的搜尋順序：明確指定的 `LLAMA_MODEL_PATH` → 使用者下載或匯入的模型 → 舊的安裝資源目錄 `<resourcesPath>/models`（相容既有的手動部署）。Windows 開發模式與 macOS 的順序不變。
2. `LLAMA_MODEL_PATH` 指向的檔案不存在或無效時，顯示可修正的錯誤，不默默改用其他模型。
3. **模型存放位置（待決定）：** 原計畫寫「目前 profile 的 `userData/models`」，但會遇到 C6 的重複下載問題。建議改放在不受 `CLIENT_PROFILE` 影響的共用位置：模型不是使用者的秘密資料，profile 隔離保護的是金鑰、錢包與資料庫。不論選哪一個，都不能要求使用者寫入安裝目錄。
4. 升級時不刪除已下載的模型；一般移除時也保留，並在說明文件寫出模型位置與手動刪除方式。

### 4.4 錯誤處理與使用者提示（處理 C3）

1. 推論前先由 Windows 模型管理檢查模型狀態，區分「尚未安裝」「檔案無效」「載入失敗」「推論逾時」，對應到介面上可以採取行動的提示（例如尚未安裝時，直接開啟下載或匯入選項）。
2. 不在介面顯示原始錯誤代碼、檔案路徑或環境變數名稱；完整訊息保留在 log。
3. 模型不存在、逾時或分類失敗時，使用者仍可手動輸入標籤並完成上傳。
4. macOS 的錯誤訊息與回傳格式維持不變。

### 4.5 效能與資源（處理 C4、C5）

1. 先在 Windows 實機量測：模型載入時間、記憶體峰值，以及單組推論時間，分別在 CPU、Vulkan、CUDA 下記錄。
2. 依量測結果訂出最低硬體需求；低於需求的電腦在下載前就先提示，不要下載完 5 GB 才發現無法使用。
3. Windows 為模型載入加上「載入中」狀態與取消功能；必要時加上 Windows 專用的載入逾時，逾時後釋放資源，不讓整條分類佇列卡住。
4. 確認 GPU 初始化失敗（例如驅動不相容）時能退回 CPU，或顯示明確提示。
5. 確有需要時才新增 Windows 專用的推論逾時或資源設定；不拉長所有平台共用的 90 秒逾時，也不更換 macOS 已正常使用的模型與提示詞。

## 5. 實作順序

### 階段 0：在 Windows 上確認可行並量測

- 用 Windows 建置一份不含模型的安裝版，以手動設定 `LLAMA_MODEL_PATH` 的方式確認推論能跑，並完成第 4.5 節的量測。
- 測試使用者名稱或路徑含中文、空白時，原生元件能否正常開啟模型檔。
- 交付：量測紀錄、最低需求草案，以及第 8 節「待決定事項」的結論。

### 階段 1：打包排除與原生元件（4.1）

- 交付：不含模型的 Windows 安裝檔、兩個平台合併後設定的比對結果，以及 macOS DMG 仍包含模型的確認紀錄。

### 階段 2：模型管理服務（4.2、4.3）

- 完成路徑解析、校驗、下載、續傳與匯入的主程序服務，並補上自動化測試。
- 交付：可在沒有介面的情況下單獨測試的模型管理模組。

### 階段 3：介面與錯誤提示（4.4）

- 完成首次啟用對話框、下載進度、載入狀態與錯誤提示。

### 階段 4：效能調校與驗收（4.5、第 6 節）

- 依量測決定 Windows 專用設定，完成 Windows 實機驗收與 macOS 回歸。

各階段依驗證結果估時；在取得 Windows 實機量測之前，不承諾完成日期。

## 6. 測試與驗收

### 6.1 自動化測試

- 模型搜尋順序：以注入平台、環境變數與檔案系統的方式測試，不在全域竄改 `process.platform`；macOS 與 Windows 各一組。
- 明確指定的路徑無效時，不會退回其他模型。
- 下載中斷後續傳、校驗失敗、磁碟不足、取消；失敗時原有模型保持不變。
- `ClassifyService` 在缺模型、逾時、JSON 解析失敗時的回傳結果，以及 macOS 有模型時的既有行為。
- 打包後檢查實際的資源清單：Windows 安裝檔不含 `.gguf`、包含 `win-x64` 原生元件；macOS DMG 仍包含模型與推論原生函式庫。不能只以 `npm run build` 成功作為判定。

### 6.2 Windows 實機驗收

- 標準帳號、乾淨環境（沒有安裝 Python、Node.js 與開發工具）。
- 沒有模型時，上傳與手動標籤正常。
- 下載、取消、續傳、校驗失敗、磁碟不足；離線匯入正確檔與錯誤檔。
- 升級後模型仍在，不需重新下載。
- CPU 與可用 GPU 的單檔、批次分類；開關與取消。
- 使用者名稱或安裝路徑含中文、空白。
- 多個 profile 是否共用同一份模型（依第 4.3 節的決定）。

### 6.3 macOS 回歸

- 單檔與批次分類、開關、取消，結果與修改前相同。
- 既有模型位置與 `LLAMA_MODEL_PATH` 仍有效。
- DMG 內含模型、Electron Framework 與推論原生函式庫；不會出現下載或匯入的提示。

### 6.4 判定方式

實機結果需標明作業系統版本、架構、CPU、GPU 與驅動版本、記憶體、Client 版本與測試日期。Windows 流程與 macOS 回歸都通過，才可標示為可正式使用；未通過的項目要寫進發佈說明的限制。

## 7. 回退與資料保護

- Windows 模型管理可以單獨停用或回退；macOS 不依賴這個模組就能啟動。
- 模型校驗失敗時保留先前可用的版本。
- log 與診斷資料不包含文件內容或分類用的摘要片段。

## 8. 待決定事項

| 事項 | 選項 | 需要的依據 |
|---|---|---|
| 模型下載來源 | Hugging Face 直接下載，或改放在專案自己的伺服器 | 校內／公司網路能否連線、頻寬、授權條款（Gemma 4 為 Apache 2.0） |
| 模型存放位置 | 目前 profile 的 `userData/models`，或不受 profile 影響的共用位置（建議） | 第 2 節 C6 |
| 隨附的 GPU 後端 | 只帶 CPU、加 Vulkan、加 CUDA | 階段 0 的量測與安裝檔大小 |
| 最低硬體需求 | 待量測 | 階段 0 |
| 打包排除做法 | 4.1 的甲案或乙案 | 合併後設定的比對結果 |

## 9. 執行追蹤

- [ ] 在 Windows 上以 `LLAMA_MODEL_PATH` 跑通推論，完成 CPU／GPU 量測。
- [ ] 確認中文與空白路徑下能開啟模型檔。
- [ ] 完成第 8 節的待決定事項。
- [ ] Windows 安裝檔排除模型，並確認 macOS 合併後設定不變。
- [ ] 完成模型管理服務（路徑、校驗、下載、續傳、匯入）與自動化測試。
- [ ] 完成首次啟用、進度、載入狀態與錯誤提示介面。
- [ ] 完成 Windows 實機驗收。
- [ ] 完成 macOS 開發版與 DMG 安裝版回歸。
- [ ] 更新 [win_build.md](secure-cloud-storage-client/win_build.md) 的模型章節，更正 `classifierSettings.js` 的註解。

## 10. 主要修改位置與參考資料

以下是預期的修改範圍，不表示已經修改：

- 模型載入與搜尋順序：[LlamaCppClient.js](secure-cloud-storage-client/src/main/services/LlamaCppClient.js)、[classifierSettings.js](secure-cloud-storage-client/src/main/services/classifierSettings.js)。
- 分類流程與錯誤回傳：[ClassifyService.js](secure-cloud-storage-client/src/main/services/ClassifyService.js)、[uploadPostProcessIpc.js](secure-cloud-storage-client/src/main/ipc/uploadPostProcessIpc.js)、[classifierPreloadMerge.js](secure-cloud-storage-client/src/preload/classifierPreloadMerge.js)。
- 新增：Windows 模型管理服務與首次啟用、下載畫面。
- 既有介面：[FileViewButtonGroup.jsx](secure-cloud-storage-client/src/renderer/src/components/FileViewButtonGroup.jsx)、[PostUploadDialog.jsx](secure-cloud-storage-client/src/renderer/src/components/PostUploadDialog.jsx)、[smartClassifyPrefs.js](secure-cloud-storage-client/src/renderer/src/lib/smartClassifyPrefs.js)。
- 打包：[electron-builder.yml](secure-cloud-storage-client/electron-builder.yml)，必要時新增 Windows 專用設定檔；不直接編輯 `out/`、`dist/` 等產物。
- 說明：[win_build.md](secure-cloud-storage-client/win_build.md)、[README.md](README.md)。

參考資料：

- [node-llama-cpp：Electron 指南](https://node-llama-cpp.withcat.ai/guide/electron)：原生元件打包與跨平台建置限制。
- [NSIS：大型安裝檔限制](https://nsis.sourceforge.io/I_get_an_error_when_compiling_large_installers)：大型資料應與安裝執行檔分開。
- [electron-builder v26：NSIS](https://www.electron.build/v26/docs/nsis/)：與專案目前主要版本對應的打包文件。
- [Hugging Face：unsloth/gemma-4-E4B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF)：目前使用的模型來源。
