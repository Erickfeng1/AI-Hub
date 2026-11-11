#!/usr/bin/env bash
# 企业 AI 中台 · 部署包打包脚本（在开发机上运行，产出可上传到服务器的 tar.gz）
#
# 用法：
#   ./infra/pack.sh                    # 打包到 ai-hub/../ai-hub-deploy-<时间>.tar.gz
#   ./infra/pack.sh --out ~/Desktop    # 指定输出目录
#   ./infra/pack.sh --with-data        # 连历史数据一起打包（迁移已有用户/应用时用）
#
# 打包原则：
#   必带  src/ scripts/ infra/ fixtures/ package.json Dockerfile docker-compose.yml
#   不带  node_modules/（服务器 npm install 现装）data/（--with-data 才带）
#         .env*（凭证不入包，到服务器上由 deploy.sh 生成 infra/.env）
#         infra/traefik/dynamic/hub.yml（部署时按真实域名生成）

set -euo pipefail

HUB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR=""
WITH_DATA=0

log() { printf '\033[1;36m[pack]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m  ✔ \033[0m %s\n' "$*"; }
die() { printf '\033[1;31m  ✘ \033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)      OUT_DIR="$2"; shift 2 ;;
    --with-data) WITH_DATA=1; shift ;;
    -h|--help)  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          die "未知参数: $1（--help 看用法）" ;;
  esac
done

[[ -d "$HUB_ROOT/src" ]] || die "找不到 $HUB_ROOT/src，请在本项目内运行"

OUT_DIR="${OUT_DIR:-$(dirname "$HUB_ROOT")}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARBALL="$OUT_DIR/ai-hub-deploy-$STAMP.tar.gz"
STAGE="$(mktemp -d)/ai-hub"
mkdir -p "$STAGE"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT

log "打包中（源：${HUB_ROOT}）"

# ---- 必带：代码 ----
for item in src scripts infra fixtures package.json Dockerfile docker-compose.yml README.md; do
  [[ -e "$HUB_ROOT/$item" ]] || die "缺少 $item，项目结构不完整"
  cp -R "$HUB_ROOT/$item" "$STAGE/"
done

# infra/.env 若已存在（含真实凭证）必须剔除，绝不进包
rm -f "$STAGE/infra/.env" "$STAGE/infra/.env.bak."*
# 门户路由按真实域名在服务器上生成，带过去反而会误导
rm -f "$STAGE/infra/traefik/dynamic/hub.yml"
# e2e 演示产物
find "$STAGE" -name '*.log' -delete 2>/dev/null || true
find "$STAGE" -name '.DS_Store' -delete 2>/dev/null || true

# ---- 可选：历史数据（迁移用）----
if [[ "$WITH_DATA" -eq 1 ]]; then
  [[ -d "$HUB_ROOT/data" ]] || die "--with-data 但找不到 data/ 目录"
  cp -R "$HUB_ROOT/data" "$STAGE/"
  ok "已包含 data/（用户 / 会话 / 应用 / Skill / 资料库）"
else
  mkdir -p "$STAGE/data"
  ok "data/ 为空目录（服务器上首次部署无需历史数据）"
fi

# ---- 打包 ----
tar czf "$TARBALL" -C "$(dirname "$STAGE")" ai-hub
SIZE="$(du -h "$TARBALL" | cut -f1)"

ok "打包完成：${TARBALL}（${SIZE}）"

cat <<EOF

────────────────────────────────────────────────────────────
  上传到服务器：
    scp "$TARBALL" user@your-server:/tmp/

  服务器上解压并部署：
    tar xzf /tmp/ai-hub-deploy-*.tar.gz -C /opt
    cd /opt/ai-hub/infra
    ./deploy.sh --domain hub.example.com --email ops@example.com
────────────────────────────────────────────────────────────

  包里有什么：
$(cd "$STAGE" && find . -maxdepth 2 -mindepth 1 -not -path './data/*' -not -name data | sort | sed 's/^/    /')
    data/（空或含历史数据）

  包里没有什么（都是故意排除的）：
    node_modules/   → 服务器上 npm install（只有一个 MCP SDK 依赖）
    .env / .env.feishu → 凭证不进包，服务器上填
    infra/.env      → 由 deploy.sh 按真实域名生成
    hub.yml         → 同上，按真实域名生成

────────────────────────────────────────────────────────────
EOF