# Secure Cloud Storage（機敏雲端）

專案由三個子專案組成：

| 資料夾 | 元件 | Port |
|---|---|---|
| `trusted-authority/` | Trusted Authority（TA） | 2999 |
| `secure-cloud-storage-server/` | Cloud Server | 3001（HTTPS）、7001（SFTP） |
| `secure-cloud-storage-client/` | Electron Client | — |

需要 Node.js 22.12 以上（或 20.19 以上）與 PostgreSQL。第一次 clone 下來，請先照第 3 節補齊設定檔，再用第 1 或第 2 節的方式啟動。

## 1. 用 Makefile 啟動（macOS／Linux）

在 repo 根目錄執行。Makefile 不會啟動 PostgreSQL，請先自己啟動（例如 Homebrew：`brew services start postgresql@16`）；三個資料夾也要先各執行過一次 `npm install`（見第 2 節）。

| 指令 | 作用 |
|---|---|
| `make run` | 依序啟動 TA → Cloud Server → Client，前一個的 port 開好才啟動下一個 |
| `make stop` | 反序關閉全部（包含第二個 Client） |
| `make status` | 查看 TA、Server、Client、第二個 Client 是否在執行 |
| `make logs` | 持續顯示四份 log |
| `make run-test` | 再開一個 Client（見第 4 節） |
| `make stop-test` | 只關閉第二個 Client |
| `make reset-test` | 刪除第二個 Client 的本機資料（見第 4 節） |

- log 和 pid 檔都在 `.run/`（`ta.log`、`server.log`、`client.log`、`client-test.log`）。
- 已經在執行的服務會略過，不會重複啟動。
- 等 port 超過 30 秒就會停止，並提示要看哪一份 log。
- Windows 不能用 Makefile，請照第 2 節手動啟動。

## 2. 手動啟動

第一次先在三個資料夾安裝套件（從 repo 根目錄開始）：

```bash
cd trusted-authority
npm install
cd ../secure-cloud-storage-server
npm install
cd ../secure-cloud-storage-client
npm install
```

接著開三個終端機，**依照順序**啟動，前一個起來之後再開下一個（Server 啟動時會向 TA 取公開參數）：

```bash
# 終端機 1：Trusted Authority（port 2999）
cd trusted-authority
node index.js

# 終端機 2：Cloud Server（port 3001、7001）
cd secure-cloud-storage-server
npm start

# 終端機 3：Electron Client
cd secure-cloud-storage-client
npm run dev
```

PostgreSQL 要在 Server 之前啟動。Windows 用 PowerShell 執行相同的指令。按 `Ctrl+C` 結束。

## 3. 遠端少了哪些設定

下面這些檔案含有密碼、私鑰，或只適用於某一台電腦，所以被 `.gitignore` 排除，clone 下來不會有：

| 檔案 | 用途 | 怎麼補 |
|---|---|---|
| `secure-cloud-storage-server/config/local.yaml` | 資料庫、區塊鏈、SMTP、管理員 | 自己建立，範例見 3.1 |
| `secure-cloud-storage-server/certs/tls.crt`、`tls.key` | Server 的 HTTPS 憑證 | 自簽產生，見 3.2 |
| `secure-cloud-storage-server/ssh/id_ed25519`、`id_ed25519.pub` | SFTP 主機金鑰 | 自己產生，見 3.2 |
| `secure-cloud-storage-server/blockchain/wallet.key` | Server 的區塊鏈錢包私鑰 | 向維護者索取（見下方說明） |
| `trusted-authority/data/tls.crt`、`tls.key` | TA 的 HTTPS 憑證 | 自簽產生，見 3.2 |
| `secure-cloud-storage-client/config/local.yaml` | Client 本機開發的連線設定 | 自己建立，範例見 3.3 |
| `secure-cloud-storage-client/resources/models/gemma-4-E4B-it-Q4_K_M.gguf` | 智慧分類模型（約 5 GB） | 選用，下載方式見 3.4 |
| `secure-cloud-storage-client/src/main/config/agentApiKeys.json` | 智慧搜尋 Gemini 模式的 API key | 選用；複製同資料夾的 `agentApiKeys.example.json` 後填入 |

- **`wallet.key` 要用維護者給的那一份。** Server 找不到這個檔案時會自動產生新錢包，但新錢包沒有在合約上授權，註冊等需要上鏈的操作會失敗。
- **第一次啟動會自動建立、不用準備的：** Server 的 `certs/watermark.key` 和 `uploads/`、TA 的 `data/TA.db`、Client 的錢包與金鑰。`watermark.key` 建立後要備份，遺失後舊的浮水印就無法解碼。
- **TA 的 `data/.env` 是選用的。** 預設值（port 2999、Server 在 `localhost:3001`）就能在本機使用。
- **指紋帳號復原（選用）** 需要 Python 3.10 以上與 `fido2` 套件：`pip3 install "fido2>=2.2"`。
- **`deploy/`（Docker 單機部署）和 `sonarqube/`（程式碼掃描）整個不在 repo 裡。** 本機開發用不到，需要時向維護者索取。

### 3.1 Server 的 `config/local.yaml`

只要寫需要覆寫 [`config/default.yaml`](secure-cloud-storage-server/config/default.yaml) 的部分：

```yaml
database:
  host: localhost
  port: 5432
  user: secure_user          # 自己取名
  password: CHANGE_ME        # 自己設定
  database: secure_cloud
  ssl: false                 # 本機 PostgreSQL 沒有開 SSL

blockchain:
  jsonRpcUrl: CHANGE_ME      # 和 Client config/default.yaml 的 blockchain.jsonRpcUrl 相同
  contractAddr: CHANGE_ME    # 和 Client config/default.yaml 的 blockchain.contractAddr 相同

smtp:
  host: smtp.gmail.com
  user: CHANGE_ME            # 寄信用的 Gmail
  pass: CHANGE_ME            # Gmail 的「應用程式密碼」，不是登入密碼
  from: CHANGE_ME

admin:
  emails:
    - you@example.com        # 用這個 email 註冊的帳號會自動成為管理員
```

- **資料庫會自動建立。** Server 第一次啟動時，如果找不到上面的帳號或資料庫，會用 PostgreSQL 管理者身分建立帳號、主資料庫與 `secret_share1`～`secret_share3`，再建立資料表。它會依序嘗試設定裡的帳號、`postgres`／`postgres`，以及你的系統使用者（Homebrew 安裝的 PostgreSQL 屬於這種）。全部失敗時，log 會印出要手動執行的 SQL。
- **SMTP 一定要能寄信。** 註冊和帳號復原都要輸入寄到信箱的驗證碼，Server 不會把驗證碼印在 log 裡。

### 3.2 憑證與 SSH 金鑰

在 repo 根目錄執行（Windows 用 Git Bash）。憑證沿用 repo 裡的 `certs/ssl.conf`（CN 為 `localhost`）：

```bash
# Cloud Server 的 HTTPS 憑證
openssl req -x509 -new -nodes -days 825 -newkey rsa:2048 \
  -config secure-cloud-storage-server/certs/ssl.conf -extensions v3_req \
  -keyout secure-cloud-storage-server/certs/tls.key \
  -out secure-cloud-storage-server/certs/tls.crt

# TA 的 HTTPS 憑證
mkdir -p trusted-authority/data
openssl req -x509 -new -nodes -days 825 -newkey rsa:2048 \
  -config secure-cloud-storage-server/certs/ssl.conf -extensions v3_req \
  -keyout trusted-authority/data/tls.key \
  -out trusted-authority/data/tls.crt

# SFTP 主機金鑰
mkdir -p secure-cloud-storage-server/ssh
ssh-keygen -t ed25519 -N "" -f secure-cloud-storage-server/ssh/id_ed25519
```

### 3.3 Client 的 `config/local.yaml`

repo 裡的 [`config/default.yaml`](secure-cloud-storage-client/config/default.yaml) 指向雲端主機。本機開發要改成連到自己電腦上的 Server 和 TA：

```yaml
server:
  protocol: sftp
  host: localhost
trustedAuthority:
  url: localhost:2999
```

**要在第一次 `npm run dev` 之前建好。** Client 第一次啟動時，會把當下的連線目標（`server.protocol`、`server.host`）和區塊鏈設定另存一份到使用者資料夾的 `config/local.yaml`，之後這份會蓋過專案裡的 `config/local.yaml`。之後要改連線目標，就改這份檔案，或刪掉它讓 Client 重建：

- macOS：`~/Library/Application Support/client-side/config/local.yaml`
- Windows：`%APPDATA%\client-side\config\local.yaml`
- 第二個 Client（第 4 節）：資料夾名稱後面會多一段，例如 `client-side-test`

### 3.4 智慧分類模型（選用）

沒有模型時，其他功能照常，只是不能用智慧分類。要在本機開發或打包 macOS 安裝檔時使用，請下載到 `resources/models/`：

```bash
cd secure-cloud-storage-client/resources/models
curl -L -o gemma-4-E4B-it-Q4_K_M.gguf \
  https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q4_K_M.gguf
shasum -a 256 gemma-4-E4B-it-Q4_K_M.gguf
# 應為 85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87
```

- Windows 安裝版不需要這一步：第一次開啟智慧分類時，程式會自己下載模型或讓你匯入。
- Windows 開發模式一樣要手動放（PowerShell 可用 `Get-FileHash` 檢查雜湊值），或設定環境變數 `SCS_MODEL_MANAGER=1`，改用程式內的下載流程。

## 4. 在同一台電腦開兩個 Client

用環境變數 `CLIENT_PROFILE` 讓第二個 Client 使用另一個使用者資料夾。金鑰、錢包、設定、本機資料庫和 log 全部分開，就像另一台電腦。

兩個 Client 必須登入不同帳號，因為 Server 不允許同一個帳號同時登入兩次。所以第二個 Client 要用另一個 email 註冊。

**用 Makefile（macOS）：**

```bash
make run          # 先啟動 TA、Server 和第一個 Client
make run-test     # 第二個 Client（profile 名稱是 test）
make stop-test    # 只關閉第二個 Client
make reset-test   # 刪除第二個 Client 的本機資料（金鑰、錢包、設定），下次啟動可重新註冊
```

`reset-test` 不會刪除 Server 上的帳號，同一個 email 也不能再註冊一次，要換一個 email。

**手動：** 確認 TA 和 Server 都已啟動，再另開一個終端機：

```bash
# macOS／Linux
cd secure-cloud-storage-client
CLIENT_PROFILE=test npm run dev
```

```powershell
# Windows PowerShell（只對這個視窗有效）
cd secure-cloud-storage-client
$env:CLIENT_PROFILE = "test"
npm run dev
```

profile 名稱可以自訂；要開第三個 Client，就換一個名稱，例如 `CLIENT_PROFILE=user2`。使用者資料夾是原本的名稱加上 `-<profile 名稱>`：

- macOS：`~/Library/Application Support/client-side-test`
- Windows：`%APPDATA%\client-side-test`

## 5. 打包安裝檔

安裝檔的連線目標是 Client 的 [`config/default.yaml`](secure-cloud-storage-client/config/default.yaml)，`config/local*.yaml` 不會打包進去；打包腳本開始前會先印出連線設定讓你確認。兩種安裝檔都沒有正式的程式碼簽章，第一次開啟時系統會跳出警告。

### macOS（DMG）

在 Apple Silicon（M 系列晶片）的 Mac 上，於 repo 根目錄執行：

```bash
./scripts/build-dmg.sh
```

- 產物：`secure-cloud-storage-client/dist/client-side-<版本>.dmg`，約 3 GB，含智慧分類模型。
- 打包前要先把模型放進 `resources/models/`（見 3.4），否則 DMG 裡不會有模型。
- 只支援 Apple Silicon，Intel Mac 不適用。
- 不要用 `npm run build:mac`：electron-builder 做 DMG 時曾漏掉 Electron Framework，裝好的 App 一打開就當掉。腳本改成先產生 .app 並驗證，再自己製作 DMG，掛載後再驗證一次。

### Windows（setup.exe）

在 Windows x64 電腦上，於 repo 根目錄執行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
```

- 產物：`secure-cloud-storage-client\dist\client-side-<版本>-setup.exe`。安裝檔不含模型，使用者第一次開啟智慧分類時再下載或匯入。
- 一定要在 Windows 上打包，不能在 Mac 上產生 Windows 版：推論與資料庫的原生元件只能在目標平台安裝。
- 腳本會自動檢查打包結果：不含模型、含 CPU／Vulkan 推論元件、小於 NSIS 的 2 GB 上限。
