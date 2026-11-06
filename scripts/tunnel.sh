#!/bin/bash
# 機敏雲端 demo 用的 SSH 隧道，斷線自動重連。
#
#   ./scripts/tunnel.sh        啟動，保持這個視窗開著
#   Control-C                  結束
#
# 轉發埠對應 ~/.ssh/config 的 nchc-tunnel 區塊：
#   3001 Cloud Server / 2999 Trusted Authority / 7001 SFTP / 11435 Ollama
#
# 會自動重連的情境：Wi-Fi 切換、DHCP 換 IP、電腦睡眠喚醒、伺服器重啟。

set -u
HOSTALIAS="${1:-nchc-tunnel}"
ATTEMPT=0

cleanup() { echo; echo "[tunnel] 已結束"; exit 0; }
trap cleanup INT TERM

echo "[tunnel] 目標: $HOSTALIAS"
echo "[tunnel] 按 Control-C 結束"
echo

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  printf '[tunnel] %s 第 %d 次連線...\n' "$(date '+%H:%M:%S')" "$ATTEMPT"

  ssh -N \
      -o BatchMode=yes \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=3 \
      -o ConnectTimeout=10 \
      -o StrictHostKeyChecking=accept-new \
      -o TCPKeepAlive=yes \
      "$HOSTALIAS"
  RC=$?

  printf '[tunnel] %s 連線中斷 (exit=%d)，5 秒後重連\n' "$(date '+%H:%M:%S')" "$RC"

  # 埠被佔用時 ssh 會立刻以 255 結束，提示使用者排除
  if [ $RC -eq 255 ]; then
    if lsof -nP -iTCP:3001 -sTCP:LISTEN 2>/dev/null | grep -qv COMMAND; then
      echo "[tunnel] 提示: 本機 3001 已被佔用。若在跑本機 server，請先執行 make stop"
    fi
  fi
  sleep 5
done
