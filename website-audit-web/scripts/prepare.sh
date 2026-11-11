#!/bin/bash
# 开发态依赖准备（[dev].build）
set -e
cd "$(dirname "$0")/.."
CACHE=/tmp/npm-cache-audit
if [ ! -d node_modules/cheerio ] || [ ! -d node_modules/lighthouse ]; then
  npm install --no-audit --no-fund --cache "$CACHE"
fi
echo "deps ready"
