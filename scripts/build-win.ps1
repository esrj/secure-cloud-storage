# 產生 Windows 安裝檔（NSIS setup.exe），對應 macOS 的 scripts/build-dmg.sh。
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
#   （PowerShell 7 也可以直接執行 .\scripts\build-win.ps1）
#
# 必須在 Windows x64 上執行：node-llama-cpp 的原生推論元件只能在目標平台安裝，不能跨平台打包。
#   1. 檢查環境：Windows x64、Node 版本、依賴套件（沒有 node_modules 時自動 npm ci）
#   2. 印出 config/default.yaml 的連線設定（安裝檔只帶這份，config/local*.yaml 不會打包）
#   3. 結束從 dist\win-unpacked 執行中的 App（檔案被鎖住時打包會失敗）
#   4. npm run build:win：electron-vite build → electron-builder --win --config electron-builder.win.cjs
#      → scripts/verify-win-build.mjs 打開安裝檔核對內容（不含模型、含 CPU/Vulkan 推論元件、小於 2 GB）
#   5. 印出安裝檔路徑、大小與 SHA-256
#
# 這個檔案要維持「UTF-8 含 BOM」：Windows PowerShell 5.1 會用系統字碼頁讀沒有 BOM 的腳本，中文會變亂碼。

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Client = Join-Path $Root 'secure-cloud-storage-client'

function Step([string]$Message) {
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Cyan
}
function Info([string]$Message) { Write-Host "   $Message" }
function Fail([string]$Message) {
  Write-Host ''
  Write-Host "✗ $Message" -ForegroundColor Red
  exit 1
}

Step '檢查環境'
if ($env:OS -ne 'Windows_NT') { Fail '必須在 Windows 上執行（node-llama-cpp 不支援跨平台打包）' }
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { Fail "目前只驗證過 Windows x64，這台電腦是 $arch" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail '找不到 node，請先安裝 Node.js（20.19 以上或 22.12 以上）'
}
$nodeVersion = [version]((& node --version).Trim().TrimStart('v'))
$nodeOk = ($nodeVersion.Major -eq 20 -and $nodeVersion.Minor -ge 19) -or
  ($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 12) -or
  ($nodeVersion.Major -ge 23)
if (-not $nodeOk) { Fail "Node $nodeVersion 太舊：electron-vite 4 與 Vite 7 需要 20.19 以上或 22.12 以上" }
Info "Windows x64，Node $nodeVersion"

Push-Location $Client
try {
  if (-not (Test-Path 'node_modules')) {
    Step '安裝依賴套件（npm ci，約 1～2 分鐘）'
    # 呼叫 npm.cmd：Windows PowerShell 的預設執行原則會擋下 npm.ps1
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci 失敗（訊息見上方）' }
  }
  if (-not (Test-Path 'node_modules\@node-llama-cpp\win-x64')) {
    Fail 'node_modules 缺少 @node-llama-cpp/win-x64（可能是在別的平台安裝的）。請刪除 secure-cloud-storage-client\node_modules 後重新執行'
  }

  Step '連線設定（config/default.yaml）'
  # 不用雙引號：Windows PowerShell 5.1 傳參數給外部程式時會吃掉內嵌的雙引號
  $js = @'
const y = require('js-yaml')
const f = require('fs')
const d = y.load(f.readFileSync('config/default.yaml', 'utf8')) || {}
const s = d.server || {}
const b = d.blockchain || {}
console.log(JSON.stringify({
  server: s.protocol + '://' + s.host + ':' + (s.port || {}).https,
  ta: (d.trustedAuthority || {}).url || '',
  rpc: b.jsonRpcUrl || '',
  contract: b.contractAddr || ''
}))
'@
  $cfgJson = & node -e $js
  if ($LASTEXITCODE -ne 0 -or -not $cfgJson) { Fail '無法讀取 config/default.yaml' }
  $cfg = $cfgJson | ConvertFrom-Json
  $contractNote = if ($cfg.contract) { '(合約已設定)' } else { '(合約未設定!)' }
  Info "server       = $($cfg.server)"
  Info "TA           = $($cfg.ta)"
  Info "blockchain   = $($cfg.rpc) $contractNote"
  if (-not $cfg.rpc -or -not $cfg.contract) { Fail 'default.yaml 缺少 blockchain.jsonRpcUrl 或 contractAddr' }
  if (Test-Path 'config\local*.yaml') {
    Info '注意：config\local*.yaml 不會打包，安裝版的連線目標以上面的 default.yaml 為準'
  }

  Step '結束從 dist\win-unpacked 執行中的 App（避免檔案被鎖住）'
  $unpacked = Join-Path $Client 'dist\win-unpacked'
  $running = @(Get-Process -Name 'client-side' -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and $_.Path.StartsWith($unpacked, [System.StringComparison]::OrdinalIgnoreCase)
    })
  if ($running.Count -gt 0) {
    $running | Stop-Process -Force
    Start-Sleep -Seconds 1
    Info "已結束 $($running.Count) 個程序"
  } else {
    Info '沒有（已安裝的版本不受影響）'
  }

  Step '編譯、打包並驗證（npm run build:win，約 2～3 分鐘）'
  & npm.cmd run build:win
  if ($LASTEXITCODE -ne 0) { Fail 'npm run build:win 失敗（訊息見上方）' }

  Step '輸出'
  $pkg = Get-Content 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
  $installer = Join-Path $Client ('dist\{0}-{1}-setup.exe' -f $pkg.name, $pkg.version)
  if (-not (Test-Path $installer)) { Fail "找不到 $installer" }
  $sizeMB = [math]::Round((Get-Item $installer).Length / 1MB)
  $sha256 = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLower()
  Info $installer
  Info "大小 $sizeMB MB，SHA-256 $sha256"
} finally {
  Pop-Location
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
Info '安裝檔沒有程式碼簽章，第一次執行時 SmartScreen 可能攔下：選「其他資訊」→「仍要執行」。'
Info '安裝檔不含智慧分類模型；第一次打開「智慧標籤」時可下載或匯入（約 4.6 GB，存在 %LOCALAPPDATA%\client-side\models）。'
