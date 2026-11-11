#!/bin/bash
# 启动 Web 控制台（前台模式，配合 run_in_background 使用）
# 架构约束：
# 1) 本机沙箱下 Chrome 不能在 Node 进程树内 spawn（SIGABRT），必须由 bash 拉起；
# 2) bash 会话退出会回收整棵进程树（nohup/disown 也无法跨会话存活），
#    因此 Chrome 与 node server 必须同处一个保活会话：本脚本先拉 Chrome，再前台跑 server。
cd "$(dirname "$0")/.."

if [ -n "$DEPLOY_RUN_PORT" ]; then
  echo "[dev.sh] production mode (port $DEPLOY_RUN_PORT), skip chrome probe"
  node server.js
  exit 0
fi

PORT_CHROME="${AUDIT_CHROME_PORT:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if curl -s --max-time 2 "http://127.0.0.1:$PORT_CHROME/json/version" >/dev/null 2>&1; then
  echo "[dev.sh] chrome already ready on :$PORT_CHROME"
else
  PROF=$(mktemp -d /tmp/audit-chrome-profile.XXXX)
  nohup "$CHROME" --headless=new --user-data-dir="$PROF" --remote-debugging-port="$PORT_CHROME" \
    --no-first-run < /dev/null >> /tmp/audit-chrome.log 2>&1 &
  disown 2>/dev/null || true
  ok=0
  for _ in $(seq 1 40); do
    if curl -s --max-time 2 "http://127.0.0.1:$PORT_CHROME/json/version" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" = "1" ]; then
    echo "[dev.sh] chrome ready on :$PORT_CHROME"
  else
    echo "[dev.sh] WARNING: chrome not ready, perf tests will be skipped"
  fi
fi

echo "[dev.sh] starting node server on :${DEPLOY_RUN_PORT:-8000}"
# 前台运行（不用 exec：保持 Chrome 的父进程是 bash 而非 node）
node server.js
