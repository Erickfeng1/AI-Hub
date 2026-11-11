#!/bin/bash
# 拉起常驻 headless Chrome（孤儿化运行，供 Lighthouse 以 --port 挂接）
# 注意：本机沙箱限制下 Chrome 不能在 Node 进程树内启动，因此必须由 bash 独立拉起并 disown。
set -u
PORT="${AUDIT_CHROME_PORT:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
LOG=/tmp/audit-chrome.log

if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "chrome already ready on :$PORT"
  exit 0
fi

PROF=$(mktemp -d /tmp/audit-chrome-profile.XXXX)
nohup "$CHROME" --headless=new --user-data-dir="$PROF" --remote-debugging-port="$PORT" \
  --no-first-run \
  >> "$LOG" 2>&1 &
disown 2>/dev/null || true

for i in $(seq 1 30); do
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "chrome ready on :$PORT"
    exit 0
  fi
  sleep 1
done
echo "chrome failed to start (see $LOG)" >&2
exit 1
