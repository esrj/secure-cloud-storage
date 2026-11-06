#!/bin/bash
# 產生可安裝的 macOS dmg。
#
#   ./scripts/build-dmg.sh
#
# 不使用 `npm run build:mac`：electron-builder 的 dmg 步驟曾漏掉 165 MB 的
# Electron Framework 二進位檔，裝出來的 App 一啟動就崩潰
# （Library not loaded: Electron Framework）。這裡改成：
#   1. electron-builder 只產生 .app（--dir）
#   2. 驗證 .app 完整且簽章有效
#   3. 用 hdiutil 自己製作 dmg
#   4. 掛載 dmg 再驗證一次，通過才覆蓋 dist/ 裡的正式檔
#
# 連線目標取自 secure-cloud-storage-client/config/default.yaml，打包前會印出來。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT="$ROOT/secure-cloud-storage-client"
cd "$CLIENT"

VERSION="$(node -p "require('./package.json').version")"
APP="dist/mac-arm64/client-side.app"
FW_REL="Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
OUT="dist/client-side-$VERSION.dmg"
VOLNAME="client-side $VERSION-arm64"

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

# 卸載這個專案任何 client-side dmg 的殘留附加。
# 殘留常掛在 /private/var/folders/.../T/ 的隨機路徑而不在 /Volumes，
# 所以依 hdiutil info 的裝置節點處理，否則會出現「資源忙碌中」。
detach_stale() {
  python3 - <<'PY'
import plistlib, subprocess
info = plistlib.loads(subprocess.run(["hdiutil", "info", "-plist"], capture_output=True).stdout)
for img in info.get("images", []):
    if "client-side" not in img.get("image-path", ""):
        continue
    ents = [e["dev-entry"] for e in img.get("system-entities", []) if e.get("dev-entry")]
    if ents:
        dev = sorted(ents, key=len)[0]
        subprocess.run(["hdiutil", "detach", dev, "-force"], capture_output=True)
        print(f"   已卸載殘留附加 {dev}")
PY
}

step "連線設定（config/default.yaml）"
node -e "
const y=require('js-yaml'),f=require('fs');
const d=y.load(f.readFileSync('config/default.yaml','utf8'));
console.log('   server       =', d.server.protocol+'://'+d.server.host+':'+d.server.port.https);
console.log('   TA           =', d.trustedAuthority.url);
console.log('   blockchain   =', d.blockchain.jsonRpcUrl, d.blockchain.contractAddr ? '(合約已設定)' : '(合約未設定!)');
if (!d.blockchain.jsonRpcUrl || !d.blockchain.contractAddr) process.exit(1);
" || fail "default.yaml 缺少 blockchain.jsonRpcUrl 或 contractAddr"

step "結束執行中的 App（避免佔用 out/）"
pkill -f "client-side.app/Contents/MacOS" 2>/dev/null && echo "   已結束" || echo "   沒有執行中的 App"

step "編譯（electron-vite build）"
npm run build

step "產生 .app（electron-builder --dir）"
npx electron-builder --mac --dir

step "驗證 .app"
[ -f "$APP/$FW_REL" ] || fail "$APP 缺少 Electron Framework 二進位檔"
codesign --verify --strict "$APP" || fail "$APP 簽章無效"
APP_FILES=$(find "$APP" -type f | wc -l | tr -d ' ')
echo "   檔案數 ${APP_FILES}，框架檔 $(du -h "$APP/$FW_REL" | awk '{print $1}')，簽章有效"

STAGE="$(mktemp -d)"
TMP_DMG="$(mktemp -u).dmg"
MP=""
cleanup() {
  [ -n "$MP" ] && hdiutil detach "$MP" -force >/dev/null 2>&1 || true
  rm -rf "$STAGE"
  rm -f "$TMP_DMG"
}
trap cleanup EXIT

step "準備 staging"
ditto "$APP" "$STAGE/client-side.app"
ln -s /Applications "$STAGE/Applications"

step "製作 dmg（hdiutil，約需數分鐘）"
detach_stale
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" \
  -fs HFS+ -format UDZO -imagekey zlib-level=6 "$TMP_DMG"

step "驗證 dmg"
hdiutil verify "$TMP_DMG" >/dev/null || fail "dmg 校驗失敗"
detach_stale
MP="$(hdiutil attach "$TMP_DMG" -nobrowse -readonly | grep -o '/Volumes/.*' | tail -1)"
[ -n "$MP" ] || fail "無法掛載剛做好的 dmg"
[ -f "$MP/client-side.app/$FW_REL" ] || fail "dmg 內缺少 Electron Framework 二進位檔"
[ -L "$MP/Applications" ] || fail "dmg 內缺少 Applications 捷徑"
DMG_FILES=$(find "$MP/client-side.app" -type f | wc -l | tr -d ' ')
[ "$DMG_FILES" = "$APP_FILES" ] || fail "dmg 內檔案數 $DMG_FILES 與 .app 的 $APP_FILES 不符"
codesign --verify --strict "$MP/client-side.app" || fail "dmg 內 App 簽章無效"
hdiutil detach "$MP" >/dev/null; MP=""
echo "   檔案數 ${DMG_FILES}、框架檔、Applications 捷徑、簽章皆通過"

step "輸出"
mv -f "$TMP_DMG" "$OUT"
rm -f "$OUT.blockmap"
ls -lh "$OUT" | awk '{print "   "$5"  "$9}'
echo
echo "完成：$CLIENT/$OUT"
