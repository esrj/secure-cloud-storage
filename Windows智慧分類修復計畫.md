# Windows 智慧分類修復計畫

- 建立日期：2026-11-06。
- 來源：自 [Windows 相容性修復計畫](Windows相容性修復計畫.md) 的 W4 抽出，並合併該計畫中 W5 打包、測試、回退與追蹤裡和智慧分類有關的條目。
- 狀態：2026-11-06 已實作階段 0～3，並在一台 Windows 實機完成驗收（見第 11 節）；macOS 回歸（第 6.3 節）需在 Mac 上執行，其他硬體尚未量測。
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

| 事項 | 選項 | 需要的依據 | 決定（2026-11-06） |
|---|---|---|---|
| 模型下載來源 | Hugging Face 直接下載，或改放在專案自己的伺服器 | 校內／公司網路能否連線、頻寬、授權條款（Gemma 4 為 Apache 2.0） | Hugging Face，固定 commit `bfc15c38…` 與 SHA-256；網址只寫在 `classifierModelManifest.js`，日後改放自有伺服器只需改這個檔。被封鎖的網路改用匯入。 |
| 模型存放位置 | 目前 profile 的 `userData/models`，或不受 profile 影響的共用位置（建議） | 第 2 節 C6 | 共用位置 `%LOCALAPPDATA%\client-side\models`（Local，不放 Roaming）。 |
| 隨附的 GPU 後端 | 只帶 CPU、加 Vulkan、加 CUDA | 階段 0 的量測與安裝檔大小 | CPU＋Vulkan。CUDA（約 545 MB）在 RTX 2080 Ti 上被判定不相容、自動改用 Vulkan，且 Vulkan 第二次起單次推論 2～4 秒，不帶 CUDA。 |
| 最低硬體需求 | 待量測 | 階段 0 | 草案：建議 16 GB 記憶體（CPU 推論峰值 5.6 GB）、約 5 GB 可用磁碟；低於 16 GB 時在下載前提示，不阻擋。 |
| 打包排除做法 | 4.1 的甲案或乙案 | 合併後設定的比對結果 | 乙案：`electron-builder.win.cjs` 在打包時讀入 `electron-builder.yml`，只移除模型並排除 CUDA。甲案會改動 macOS 讀的設定檔、`builder-effective-config.yaml` 也會不同；乙案下 `electron-builder.yml` 一字未改。 |

## 9. 執行追蹤

- [x] 在 Windows 上以 `LLAMA_MODEL_PATH` 跑通推論，完成 CPU／GPU 量測（一台機器，見 README「本機 Gemma 4 分類」）。
- [x] 確認中文與空白路徑下能開啟模型檔（CPU、Vulkan）。
- [x] 完成第 8 節的待決定事項（最低硬體需求仍是草案）。
- [x] Windows 安裝檔排除模型，並確認 macOS 合併後設定不變。
- [x] 完成模型管理服務（路徑、校驗、下載、續傳、匯入）與自動化測試。
- [x] 完成首次啟用、進度、載入狀態與錯誤提示介面。
- [ ] 完成 Windows 實機驗收：一台開發機已通過第 11.4 節各項；乾淨環境、標準帳號、以安裝檔升級、其他硬體尚未做。
- [ ] 完成 macOS 開發版與 DMG 安裝版回歸。
- [ ] 更新 [win_build.md](secure-cloud-storage-client/win_build.md) 的模型章節（該檔不在 repo，改寫在 README）；`classifierSettings.js` 的註解已更正。

## 10. 主要修改位置與參考資料

以下是撰寫計畫時預期的修改範圍；實際修改見第 11.1 節：

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

## 11. 實作紀錄（2026-11-06）

### 11.1 修改內容

| 項目 | 位置 | 說明 |
|---|---|---|
| 可信版本資訊 | [classifierModelManifest.js](secure-cloud-storage-client/src/main/services/classifierModelManifest.js) | commit `bfc15c382204943c3a8fff0c750b94ae2364d7a3`（2026-07-17，最後一次修改 Q4_K_M 的 commit）、4,977,171,584 bytes、SHA-256 `85a896a0…cd1fab87`，取自 Hugging Face 的 LFS 資訊並以完整下載核對過。 |
| 搜尋順序 | [classifierModelLocator.js](secure-cloud-storage-client/src/main/services/classifierModelLocator.js) | 純函式，平台、環境變數與檔案檢查都由參數注入。macOS 與 Windows 開發模式維持原順序。 |
| 下載、續傳、匯入、校驗 | [classifierModelStore.js](secure-cloud-storage-client/src/main/services/classifierModelStore.js) | 只用 Node 內建模組；新資料只寫入暫存檔，SHA-256 相符才改名。通過校驗後寫入 `<模型>.verified.json`（雜湊、大小、修改時間），啟動時只比對大小與時間，不重算 5 GB 雜湊。 |
| Windows 模型管理 | [windowsClassifierModel.js](secure-cloud-storage-client/src/main/services/windowsClassifierModel.js)、[classifierModelIpc.js](secure-cloud-storage-client/src/main/ipc/classifierModelIpc.js) | 平台工廠：只有 Windows 安裝版建立實例，macOS、Linux、Windows 開發模式與 `SCS_MODEL_MANAGER=0` 都回傳 `null`；IPC 只在 Windows 註冊。 |
| 錯誤與提示 | [classifierModelErrors.js](secure-cloud-storage-client/src/main/services/classifierModelErrors.js) | 失敗結果在 Windows 才加上 `userHint`（白話說明與可採取的動作）；macOS 的回傳物件原樣不動。 |
| 共用檔 | [LlamaCppClient.js](secure-cloud-storage-client/src/main/services/LlamaCppClient.js)、[ClassifyService.js](secure-cloud-storage-client/src/main/services/ClassifyService.js)、[preUploadClassifyCache.js](secure-cloud-storage-client/src/main/services/preUploadClassifyCache.js) | 新增的分支都以 Windows 模型管理是否存在為條件；macOS 仍是 `getLlama()`、`loadModel({ modelPath })`、90 秒推論逾時與原本的錯誤訊息。 |
| 介面 | [ModelSetupPanel.jsx](secure-cloud-storage-client/src/renderer/src/components/ModelSetupPanel.jsx)、[ModelSetupDialog.jsx](secure-cloud-storage-client/src/renderer/src/components/ModelSetupDialog.jsx)、[FileViewButtonGroup.jsx](secure-cloud-storage-client/src/renderer/src/components/FileViewButtonGroup.jsx)、[PostUploadDialog.jsx](secure-cloud-storage-client/src/renderer/src/components/PostUploadDialog.jsx)、[MainView.jsx](secure-cloud-storage-client/src/renderer/src/components/MainView.jsx) | 只在 preload 提供 `electronAPI.classifierModel`（僅 Windows）時啟用。缺模型時改在上傳後對話框內嵌設定面板，避免兩個 modal 對話框搶焦點。進度沿用 `classifier-llm-progress`，移除已無人送出的 Ollama `serve`／`pull` 處理。 |
| 打包 | [electron-builder.win.cjs](secure-cloud-storage-client/electron-builder.win.cjs)、[verify-win-build.mjs](secure-cloud-storage-client/scripts/verify-win-build.mjs)、`package.json` 的 `build:win`、根目錄 [scripts/build-win.ps1](scripts/build-win.ps1) | 乙案。打包後自動用 7-Zip 打開安裝檔核對內容。`build-win.ps1` 對應 macOS 的 `build-dmg.sh`：先檢查環境並印出連線設定，再執行 `npm run build:win`。 |
| 測試 | [test/classifier/](secure-cloud-storage-client/test/classifier/) | `npm run test:classifier`，24 項。 |
| 說明 | [README.md](README.md)、[resources/models/README.txt](secure-cloud-storage-client/resources/models/README.txt)、[classifierSettings.js](secure-cloud-storage-client/src/main/services/classifierSettings.js) 註解 | `win_build.md` 不在 repo 中（git 歷史也沒有），模型章節改寫在 README。 |

### 11.2 macOS 不變的依據

- `electron-builder.yml` 與修改前逐位元組相同；以 electron-builder 的 `getConfig` 載入兩份設定比對，macOS 合併後的 `extraResources` 仍是「模型＋fido」，Windows 只少了模型、`files` 多三條排除，其餘設定完全相同。
- `ClassifyService` 的 macOS 情境（停用、無檔案、成功、舊 mode 值、缺模型兩組都呼叫、逾時、JSON 解析失敗、第一組失敗第二組成功、進度與 debug）在修改前錄下快照 `classify-mac.snapshot.json`，修改後逐項 `deepStrictEqual` 相同。
- 模型搜尋順序的 macOS 測試，以修改前 `getModelPath()` 的原始邏輯為參考實作逐一比對。
- 以上是程式層面的證據，不能取代第 6.3 節在 Mac 實機的回歸。

### 11.3 自動化測試

- `npm run test:classifier`：24 項全數通過。涵蓋第 6.1 節除打包外的項目：搜尋順序（macOS、Windows、開發模式、明確路徑無效不退回）、下載中斷後續傳、伺服器忽略 Range、校驗失敗、磁碟不足、取消（皆確認原有模型不變）、匯入的檔名／大小／雜湊檢查、`ClassifyService` 在缺模型、逾時、取消、JSON 解析失敗時的回傳，以及 macOS 快照比對。
- `scripts/verify-win-build.mjs`（`npm run build:win` 最後一步）：以 7-Zip 打開安裝檔確認不含 `.gguf`、含 CPU 與 Vulkan 推論元件、不含 CUDA、`app.asar` 含 `config/default.yaml`，安裝檔 167 MB。
- 既有的 `test/fido` 有 1 項在 Windows 上失敗（測試本身以 `c:` 路徑做 `import()`），未修改的 HEAD 也一樣失敗，與本計畫無關。

### 11.4 Windows 實機驗收（2026-11-06）

環境：Windows 11 教育版 x64（10.0.26300）、i7-8700K 6 核、32 GB、RTX 2080 Ti（驅動 621.01）、Client 2.0.0。執行 `dist\win-unpacked\client-side.exe`（與安裝檔內容逐檔相同、`app.isPackaged` 為 true），以 `CLIENT_PROFILE` 隔離測試資料，並用 Chrome DevTools Protocol 操作介面與截圖。這台機器已有使用者 2026-05 的安裝版與帳號資料，為避免覆蓋，沒有以 `setup.exe` 實際安裝。

| 項目 | 結果 |
|---|---|
| 沒有模型時分類 | 不做文字擷取，直接回傳「尚未安裝」提示，可手動輸入標籤 |
| 打開開關 | 出現「下載模型／匯入模型／稍後設定」，開關維持關閉；顯示所需與可用空間 |
| 下載 → 取消 → 繼續 | 15 秒下載 307 MB 後取消，保留 313 MB 的 `.part`；繼續下載先重算已下載部分的雜湊，再以 HTTP Range 從 313 MB 接著下載，219 秒完成並通過 SHA-256；對話框自動關閉、開關自動開啟 |
| 離線匯入 | 選錯檔名被擋下且原模型不變；選正確檔案 14 秒完成複製與校驗 |
| 校驗現有檔案 | 校驗紀錄遺失時可在介面重新校驗，5 GB 約 12 秒 |
| 分類（自動選後端＝Vulkan） | txt、docx 與 Edge 印出的中文 PDF 都擷取成功；冷啟動 62.9 秒（含載入與第一次著色器編譯）、之後 6.0 秒 |
| 分類（強制 CPU） | 85.9 秒，超過原本 90 秒逾時的九成，Windows 改用 180 秒的依據 |
| 載入中取消 | 立即停止，回傳「已取消」；之後再分類正常 |
| 推論中取消 | 有效，但 CPU 後端要等目前的提示詞處理完才停止（實測約 30 秒，node-llama-cpp 只在產生 token 時檢查取消）；介面按下後顯示「正在停止…」 |
| `LLAMA_MODEL_PATH` 指向不存在的檔案 | 狀態為 `env-missing`，提示修正設定，不改用其他模型 |
| `SCS_MODEL_MANAGER=0` | 回到修改前的行為與錯誤訊息，沒有 `userHint` |
| 第二個 `CLIENT_PROFILE` | 直接使用同一份模型，不需重新下載 |
| 上傳後對話框 | 載入進度與「取消分析」、白話提示（不顯示錯誤代碼與路徑）、內嵌的下載／匯入面板、沒有 `userHint` 時仍顯示原本的失敗區塊、重試後套用標籤，皆以截圖確認 |

觀察到但不在本計畫範圍的既有行為：

- App 底部的 Console 面板會顯示主程序所有 info 以上的 log（macOS 原本就會顯示模型路徑），因此詳細錯誤與模型資料夾路徑會出現在那裡；分類對話框本身只顯示白話提示。
- `TextExtractService` 的 pdfjs-dist 備援在所有平台都載入失敗（pdfjs-dist v5 只提供 ESM，程式以 `require` 載入），PDF 只靠 pdf-parse。一般 PDF 可以擷取；pdf-lib 產生的測試 PDF 會被 pdf-parse 內附的舊版 pdf.js 判定為結構錯誤。
- 正常關閉視窗時 App 會呼叫 `encryptToServer()` 上傳加密備份（即使未登入），驗收時改以強制結束避免送出資料。

### 11.5 尚未完成

- 第 6.3 節 macOS 回歸（需在 Mac 執行，含 DMG 內仍有模型）。另建議在 Mac 上執行 `shasum -a 256 resources/models/gemma-4-E4B-it-Q4_K_M.gguf`，確認與釘選的 SHA-256 相同。
- 乾淨環境、標準帳號、以 `setup.exe` 安裝與升級後模型仍在的實測。模型存放在安裝目錄之外，依設計不受升級與一般移除影響，但尚未實際以安裝檔驗證。
- 其他硬體：只有內顯（Vulkan 走 Intel／AMD 內顯）、AMD 獨顯、8 GB 記憶體、傳統硬碟的冷載入時間、ARM64。
- 公司或學校 proxy 環境下的下載（使用 Electron 網路堆疊，理論上套用系統 proxy，未實測）。
