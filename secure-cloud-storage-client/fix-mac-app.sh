#!/usr/bin/env bash
set -euo pipefail

DMG="dist/client-side-2.0.0.dmg"
APP_NAME="client-side.app"
DEST="/Applications/$APP_NAME"

echo "[0/7] Check DMG exists..."
ls -la "$DMG" >/dev/null

echo "[1/7] Mount DMG..."
MNT="$(mktemp -d /tmp/client-side-mnt.XXXXXX)"
hdiutil attach "$DMG" -nobrowse -mountpoint "$MNT" >/dev/null

echo "[2/7] Copy app to /Applications..."
sudo rm -rf "$DEST"
sudo cp -R "$MNT/$APP_NAME" /Applications/

echo "[3/7] Detach DMG..."
hdiutil detach "$MNT" >/dev/null || true
rmdir "$MNT" 2>/dev/null || true

echo "[4/7] Remove quarantine attribute..."
sudo xattr -dr com.apple.quarantine "$DEST" || true

echo "[5/7] Remove ALL existing code signatures (important)..."
# 先把 app 內所有既有簽章移掉，避免混簽
sudo find "$DEST" -type f -perm -111 -print0 \
  | sudo xargs -0 -I{} codesign --remove-signature "{}" >/dev/null 2>&1 || true
sudo codesign --remove-signature "$DEST" >/dev/null 2>&1 || true

echo "[6/7] Ad-hoc sign EVERYTHING in correct order..."
# 6-1 先簽 Frameworks 內可執行檔 / dylib / node / so
sudo find "$DEST/Contents/Frameworks" -type f \( -perm -111 -o -name "*.dylib" -o -name "*.so" -o -name "*.node" \) -print0 \
  | sudo xargs -0 -I{} codesign --force --sign - --timestamp=none "{}"

# 6-2 簽所有 nested .app（Helper apps）
sudo find "$DEST/Contents/Frameworks" -name "*.app" -type d -print0 \
  | sudo xargs -0 -I{} codesign --force --sign - --timestamp=none "{}"

# 6-3 最後簽主 app（不要省略）
sudo codesign --force --deep --sign - --timestamp=none "$DEST"

echo "[7/7] Verify..."
codesign -vvv --deep --strict "$DEST" || true
echo
echo "Gatekeeper (spctl) may still say 'rejected' because no notarization (expected)."
echo "Now launch via Finder -> Right click -> Open (first time), or run:"
echo "open \"$DEST\""