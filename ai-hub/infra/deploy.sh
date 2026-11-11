#!/usr/bin/env bash
# 企业 AI 中台 · Linux 服务器一键部署脚本（形态 A：中台跑宿主机 + Traefik 网关）
#
# 用法：
#   cd ai-hub/infra
#   ./deploy.sh --domain hub.example.com --email ops@example.com
#   ./deploy.sh --domain hub.example.com --port 8099        # 8080 被占用时换端口
#   ./deploy.sh --domain hub.example.com --auto-port        # 自动挑选空闲端口
#   ./deploy.sh --domain hub.example.com --gateway-port 8000  # 80/443 已被 nginx 占用时挪网关
#
# 脚本做的事：
#   1. 环境体检（Docker / Node / 端口 / DNS 解析）
#   2. 生成 infra/.env（含 Cookie 域、forwardAuth 地址、ACME 邮箱、中台端口）
#   3. 生成 Traefik 门户路由（把 hub.<域名> 转到中台）
#   4. 拉起 Traefik
#   5. 安装 systemd 守护（开机自启 + 崩溃自愈）
#   6. 输出验收清单
#
# 幂等：可重复执行；已存在的配置项会覆盖，data/ 目录不动。

set -euo pipefail

DOMAIN=""
ACME_EMAIL=""
SKIP_SYSTEMD=0
DRY_RUN=0
PORT=""
AUTO_PORT=0
GATEWAY_PORT=""
GATEWAY_TLS_PORT=""
IDENTITY=""
HUB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA="$HUB_ROOT/infra"

log()  { printf '\033[1;36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✘ %s\033[0m\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)      DOMAIN="$2"; shift 2 ;;
    --email)       ACME_EMAIL="$2"; shift 2 ;;
    --port)        PORT="$2"; shift 2 ;;
    --auto-port)   AUTO_PORT=1; shift ;;
    --gateway-port)     GATEWAY_PORT="$2"; shift 2 ;;
    --gateway-tls-port) GATEWAY_TLS_PORT="$2"; shift 2 ;;
    --identity)    IDENTITY="$2"; shift 2 ;;
    --skip-systemd) SKIP_SYSTEMD=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)     sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             die "未知参数: $1（--help 看用法）" ;;
  esac
done

[[ -n "$DOMAIN" ]] || die "必须指定 --domain，例如 --domain hub.example.com"

# ------------------------------------------------------------ 端口决策
# 8080 只是默认值，不是硬约束。中台端口从不对公网开放（对外只有 Traefik 的
# 80/443），所以被谁占了都不影响使用者 —— 换端口即可，不必去动别人的服务。
port_busy()  { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
port_owner() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 | xargs -r ps -p 2>/dev/null | tail -1 | sed 's/^ *//'; }

if [[ -z "$PORT" ]]; then
  # 未显式 --port：默认先试 8080；若 --auto-port 且 8080 被占，由下面的循环另选
  PORT=8080
fi

if [[ -n "$PORT" ]]; then
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "--port 必须是数字，收到：${PORT}"
  (( PORT >= 1024 && PORT <= 65535 )) || die "--port 需在 1024-65535 之间（<1024 是特权端口，非 root 起不来），收到：${PORT}"
  if port_busy "$PORT"; then
    OWNER="$(port_owner "$PORT" || true)"
    # 沙箱/无 ps 环境可能取不到进程名，补一句通用诊断命令
    [[ -z "$OWNER" ]] && OWNER="（进程名不可读，用 'ss -lntp | grep ${PORT}' 查看占用方）"
    if [[ "$AUTO_PORT" -eq 1 ]]; then
      warn "端口 ${PORT} 已被占用（${OWNER}），--auto-port 生效，自动另选"
      FOUND=""
      for CAND in 8080 8081 8082 8083 8090 8099 9000 9080; do
        if ! port_busy "$CAND"; then FOUND="$CAND"; break; fi
      done
      [[ -n "$FOUND" ]] || die "候选端口（8080/8081/8082/8083/8090/8099/9000/9080）全被占用，请手工指定 --port"
      PORT="$FOUND"
      ok "已选用空闲端口 ${PORT}"
    else
      die "端口 ${PORT} 已被占用：${OWNER}
       三种处理方式（任选其一）：
         1) 换端口          --port 8099
         2) 自动挑空闲端口  --auto-port
         3) 让出端口        停掉占用方（如 systemctl stop nginx）"
    fi
  else
    ok "中台端口 ${PORT} 空闲"
  fi
fi
HUB_PORT="$PORT"
HUB_INTERNAL="http://host.docker.internal:${HUB_PORT}"

# 网关对外端口。默认沿用Traefik 原生的 80/443；但目标机上80/443 常常已被
# nginx/Apache 占着（这台机器就在跑 1Panel + WordPress），此时用
# --gateway-port 8000 把网关挪到高端口，由前置 nginx 反代进来，
# 不去动别人已有的 Web 服务。
if [[ -n "$GATEWAY_PORT" ]]; then
  [[ "$GATEWAY_PORT" =~ ^[0-9]+$ ]] || die "--gateway-port 必须是数字，收到：${GATEWAY_PORT}"
  if port_busy "$GATEWAY_PORT"; then
    die "网关端口 ${GATEWAY_PORT} 已被占用：$(port_owner "$GATEWAY_PORT")
       换一个：--gateway-port 8001"
  fi
  ok "网关端口 ${GATEWAY_PORT}空闲（需由前置 nginx 反代进来）"
elif port_busy 80 || port_busy 443; then
  warn "80/443 已被占用（$(port_owner 80 || true)），Traefik 启动会失败。"
  warn "两条路走其一："
  warn "  1) 让出端口   systemctl stop nginx   （会影响该端口上的既有站点）"
  warn "  2) 换网关端口 --gateway-port 8000  再由前置 nginx 反代到它（推荐，不动既有服务）"
  die "请显式指定处理方式，不要在未确认的情况下停掉既有服务"
else
  GATEWAY_PORT=80
fi
: "${GATEWAY_TLS_PORT:=8443}"
# 对外协议：有 ACME 邮箱走 https，否则纯 http。提前算好给后面的告警/清单复用，
# 免得在各处重复展开三元表达式（踩过一次 unbound variable）。
PUBLIC_SCHEME=$([ -n "$ACME_EMAIL" ] && echo https || echo http)

# ---------------------------------------------------------------- 1. 环境体检
log "1/6 环境体检"

command -v docker >/dev/null || die "未安装 Docker。Debian/Ubuntu: curl -fsSL https://get.docker.com | sh"
docker info >/dev/null 2>&1 || die "Docker 守护进程未运行。启动它：systemctl start docker"
docker compose version >/dev/null 2>&1 || die "缺少 compose v2 插件（docker-compose），请安装后重试"
ok "Docker $(docker version --format '{{.Server.Version}}') + compose 可用"

# Node 20+（package.json engines 要求 >=20）
if command -v node >/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$NODE_MAJOR" -ge 20 ]] || die "Node 版本过低（$(node -v)），需要 >= 20"
  ok "Node $(node -v)"
else
  die "未安装 Node.js 20+。Ubuntu/Debian 可用 NodeSource：curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
fi

# 80/443 占用检查（Traefik 要独占）
# 注意循环变量绝不能叫 PORT 或 GATEWAY_PORT —— 前者覆盖选定的中台端口，
# 后者覆盖选定的网关端口（踩过：循环跑完 GATEWAY_PORT 变成 443，
# 写进 .env 后compose 把 443 映射到宿主 443，与既有 nginx 抢端口）。
for GATEWAY_PROBE in 80 443; do
  if lsof -nP -iTCP:$GATEWAY_PROBE -sTCP:LISTEN >/dev/null 2>&1; then
    warn "端口 $GATEWAY_PROBE 已被占用：$(lsof -nP -iTCP:$GATEWAY_PROBE -sTCP:LISTEN -t | head -1 | xargs -r ps -p 2>/dev/null | tail -1)"
    if [[ "$GATEWAY_PORT" == 80 || "$GATEWAY_PORT" == 443 ]]; then
      warn "本次选了独占 ${GATEWAY_PORT}，但它被占用 —— Traefik 会起不来。"
      warn "要么让出端口（systemctl stop nginx），要么改用 --gateway-port 8000让前置 nginx 反代。"
    else
      warn "网关已挪到 ${GATEWAY_PORT}，此占用不影响本次部署（由前置 nginx 承接 80/443）。"
    fi
  else
    ok "端口 $GATEWAY_PROBE 空闲"
  fi
done

# 中台端口：只应被本机/容器内网访问，绝不能对外暴露
if lsof -nP -iTCP:$HUB_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  warn "${HUB_PORT} 已有服务在监听（可能是上次部署的中台）。systemd 部署前请先停：systemctl stop ai-hub"
fi

# DNS 自检：能否解析到本机公网 IP
PUBLIC_IP="$(curl -sf --max-time 5 https://api.ipify.org || curl -sf --max-time 5 ifconfig.me || echo "")"
RESOLVED="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
if [[ -n "$PUBLIC_IP" && -n "$RESOLVED" ]]; then
  if [[ "$RESOLVED" == "$PUBLIC_IP" ]]; then
    ok "DNS 已解析：$DOMAIN → $RESOLVED"
  else
    warn "DNS 指向 ${RESOLVED}，但本机公网 IP 是 ${PUBLIC_IP} —— 请检查 A 记录与泛解析"
  fi
else
  warn "未能解析 ${DOMAIN}（DNS 可能尚未生效或机器无外网）。上线前务必确认解析正确，否则 ACME 证书签发会失败。"
fi

# ---------------------------------------------------- 2. 生成 infra/.env
log "2/6 生成环境配置"

[[ -f "$INFRA/.env" ]] && cp "$INFRA/.env" "$INFRA/.env.bak.$(date +%s)"

# 保留已有的飞书凭证（用户可能已填好），其余按参数重写
FEISHU_BLOCK=""
if [[ -f "$INFRA/.env" ]] && grep -q '^FEISHU_APP_ID=' "$INFRA/.env"; then
  FEISHU_BLOCK="$(grep -E '^(FEISHU_APP_ID|FEISHU_APP_SECRET)=' "$INFRA/.env")"
  # 已有凭证先读进变量，heredoc 里的占位符才能填上真实值
  # shellcheck disable=SC1090
  while IFS='=' read -r _k _v; do
    case "$_k" in
      FEISHU_APP_ID) FEISHU_APP_ID="$_v" ;;
      FEISHU_APP_SECRET) FEISHU_APP_SECRET="$_v" ;;
    esac
  done <<< "$FEISHU_BLOCK"
  ok "沿用已有飞书配置"
fi

# 身份层决策：显式 --identity > 沿用旧 .env 里已填好的飞书模式 > dev 兜底
if [[ -z "$IDENTITY" ]]; then
  if [[ -n "${FEISHU_APP_ID:-}" && -n "${FEISHU_APP_SECRET:-}" ]]; then
    IDENTITY_PROVIDER=feishu
  else
    IDENTITY_PROVIDER=dev
  fi
else
  case "$IDENTITY" in
    dev|feishu) IDENTITY_PROVIDER="$IDENTITY" ;;
    *) die "--identity 只能是 dev 或 feishu，收到：${IDENTITY}" ;;
  esac
fi
[[ "$IDENTITY_PROVIDER" == feishu && -z "${FEISHU_APP_ID:-}" ]] \
  && die "选了 feishu 身份层但 FEISHU_APP_ID/SECRET 为空。请把凭证写进 ${INFRA}/.env 后重跑，或先--identity dev 跑通链路。"
ok "身份层：${IDENTITY_PROVIDER}"

cat > "$INFRA/.env" <<EOF
# 由 infra/deploy.sh 生成于 $(date '+%F %T')
# 门户：https://$DOMAIN    应用：https://<slug>.$DOMAIN

# ---- 门户与域名 ----
HUB_DOMAIN=$DOMAIN
# 中台监听端口。--port 8080（默认）/ --auto-port / --port 8099 可改。
# 该端口只对本机与 Docker 内网开放，公网入口永远是 Traefik。
HUB_PORT=$HUB_PORT
# Traefik 在宿主上的对外端口。宿主 80/443 被占用时用 --gateway-port 8000 挪走，
# 再由前置 nginx 反代到它；此时 ACME 的 80 挑战需由前置服务透传（见部署指南）。
HUB_GATEWAY_PORT=$GATEWAY_PORT
HUB_GATEWAY_TLS_PORT=$GATEWAY_TLS_PORT
# 对外协议：配了 ACME 邮箱走 https（Traefik 443），否则只能 http
HUB_EXTERNAL_SCHEME=$([ -n "$ACME_EMAIL" ] && echo https || echo http)

# ---- 运行时 ----
HUB_EXECUTOR=docker

# ---- 身份层 ----
# 显式 --identity 优先；否则有飞书凭证就用飞书，没有就退回 dev 表单登录。
# 不能无条件写 feishu：凭证为空时门户会跳到飞书授权页却直接失败，等于谁都登不进。
HUB_IDENTITY_PROVIDER=$IDENTITY_PROVIDER
FEISHU_APP_ID=${FEISHU_APP_ID:-}
FEISHU_APP_SECRET=${FEISHU_APP_SECRET:-}
FEISHU_REDIRECT_URI=$([ -n "$ACME_EMAIL" ] && echo https || echo http)://$DOMAIN/__hub__/auth/callback

# ---- forwardAuth 回调（形态 A：中台在宿主机）----
HUB_INTERNAL_URL=$HUB_INTERNAL

# ---- Cookie 域（生产必填）----
HUB_COOKIE_DOMAIN=.$DOMAIN

# ---- 应用容器资源配额 ----
HUB_APP_CPUS=1
HUB_APP_MEMORY=512m
HUB_APP_PIDS_LIMIT=256

# ---- HTTPS 证书 ----
ACME_EMAIL=$ACME_EMAIL
EOF

if [[ -n "$FEISHU_BLOCK" ]]; then
  # 用已有凭证覆盖刚写入的空占位（身份层不在此处覆盖，由上面的决策统一给出）
  while IFS= read -r line; do
    KEY="${line%%=*}"
    sed -i.bak "s|^${KEY}=.*|${line}|" "$INFRA/.env" && rm -f "$INFRA/.env.bak"
  done <<< "$FEISHU_BLOCK"
fi

chmod 600 "$INFRA/.env"
ok "已生成 $INFRA/.env（权限 600）"

if [[ "$IDENTITY_PROVIDER" == dev ]]; then
  warn "当前身份层是 dev 表单登录（无飞书凭证）。上线前必须切飞书，否则任何人都能自选身份登录："
  warn "  编辑 $INFRA/.env 填入 FEISHU_APP_ID / FEISHU_APP_SECRET，把 HUB_IDENTITY_PROVIDER 改成 feishu"
  warn "  然后 systemctl restart ai-hub；并到飞书开放平台把回调地址登记为 ${PUBLIC_SCHEME}://${DOMAIN}/__hub__/auth/callback"
fi

# ------------------------------------------------- 3. 生成 Traefik 门户路由
log "3/6 生成 Traefik 门户路由"

cat > "$INFRA/traefik/dynamic/hub.yml" <<EOF
# 由 deploy.sh 生成于 $(date '+%F %T') —— 门户路由
#
# 为什么需要这份文件：应用的子域名路由是「发布时自动生成」的（docker provider
# 感知 label），但门户本身是长驻进程、不带 Traefik label，网关看不见它 ——
# 不配这条，上线后访问主域名会直接 404。
http:
  routers:
    hub-portal:
      rule: Host(\`$DOMAIN\`)
EOF

if [[ -n "$ACME_EMAIL" ]]; then
  # HTTPS 模式：80 只做跳转，业务流量走 443
  cat >> "$INFRA/traefik/dynamic/hub.yml" <<EOF
      entryPoints: [web, websecure]
      service: hub-portal
      priority: 100
      middlewares: [hub-headers, hub-to-https]
      tls:
        certResolver: le
EOF
else
  # 无 ACME 邮箱：纯 HTTP 模式。
  # 注意不能挂 https 跳转中间件（会把自己重定向成死循环），也不能挂 tls
  # （Traefik 申请不到证书会把整条路由摘掉，表现为「域名能解析但访问 404」）。
  cat >> "$INFRA/traefik/dynamic/hub.yml" <<EOF
      entryPoints: [web]
      service: hub-portal
      priority: 100
      middlewares: [hub-headers]
# （当前未配置 ACME_EMAIL，门户只走 http。配好邮箱后重跑 deploy.sh 即可启用 HTTPS）
EOF
fi

cat >> "$INFRA/traefik/dynamic/hub.yml" <<EOF

  services:
    hub-portal:
      loadBalancer:
        servers:
          - url: "$HUB_INTERNAL"

  middlewares:
    hub-to-https:
      redirectScheme:
        scheme: https
        permanent: true
    hub-headers:
      headers:
        referrerPolicy: "strict-origin-when-cross-origin"
        frameDeny: true
        customResponseHeaders:
          X-Content-Type-Options: ["nosniff"]
          Strict-Transport-Security: ["max-age=31536000; includeSubDomains"]
EOF
ok "已生成 $INFRA/traefik/dynamic/hub.yml"

# ------------------------------------------------------- 4. 拉起 Traefik
log "4/6 启动 Traefik 网关"
cd "$INFRA"
if [[ "$DRY_RUN" -eq 1 ]]; then
  warn "--dry-run：跳过 Traefik 启动"
else
  docker compose up -d
  sleep 3
  # 用退出码判定而非文本匹配：docker compose ps 的输出格式随版本变化，
  # grep -q "Up" 在部分版本会漏判（容器 Running 但脚本报失败）
  if docker compose ps --status running --services 2>/dev/null | grep -qx traefik; then
    ok "Traefik 运行中"
  else
    docker compose logs traefik --tail 30
    die "Traefik 启动失败，见上方日志"
  fi
fi

# --------------------------------------------------- 5. systemd 守护
if [[ "$SKIP_SYSTEMD" -eq 1 || "$DRY_RUN" -eq 1 ]]; then
  log "5/6 跳过 systemd（--skip-systemd / --dry-run）"
else
  log "5/6 安装 systemd 守护"
  [[ $EUID -eq 0 ]] || die "安装 systemd 需要 root：sudo ./deploy.sh --domain $DOMAIN --email $ACME_EMAIL"

  # 中台的 .env 与 infra/.env 同源
  cp "$INFRA/.env" "$HUB_ROOT/.env.production"
  chmod 600 "$HUB_ROOT/.env.production"

  cat > /etc/systemd/system/ai-hub.service <<UNIT
[Unit]
Description=企业 AI 中台（门户 + MCP + 应用编排）
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$HUB_ROOT
EnvironmentFile=$HUB_ROOT/.env.production
Environment=NODE_ENV=production
ExecStart=$(command -v node) scripts/dev-server.mjs
Restart=always
RestartSec=5
StandardOutput=append:/var/log/ai-hub.log
StandardError=append:/var/log/ai-hub.err.log

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now ai-hub
  sleep 6

  if systemctl is-active --quiet ai-hub; then
    ok "中台服务已启动（systemctl status ai-hub 查看日志）"
  else
    systemctl status ai-hub --no-pager -n 30 || true
    die "中台启动失败，见上方状态"
  fi
fi

# ------------------------------------------------------------ 6. 验收清单
log "6/6 部署完成 · 验收清单"

# 域名迁移检查：store 里的 url 是发布时按当时的 HUB_DOMAIN 固化的。
# 换域名后旧应用不会自动跟随，门户里会出现指向旧域名的死链。
if [[ "$DRY_RUN" -eq 0 && -f "$HUB_ROOT/data/store.json" ]]; then
  STALE=$(HUB_CHECK_DOMAIN="$DOMAIN" HUB_STORE="$HUB_ROOT/data/store.json" node -e "
const s = require(process.env.HUB_STORE);
const dom = process.env.HUB_CHECK_DOMAIN;
const bad = (s.apps || []).filter(a => a.url && !a.url.includes(dom));
if (bad.length) console.log(bad.map(a => '  - ' + a.slug + ' → ' + a.url).join('\n'));
" 2>/dev/null || true)
  if [[ -n "$STALE" ]]; then
    warn "以下应用的 URL 指向旧域名（换域名后需重新发布才会更新）："
    echo "$STALE"
    warn "全新部署不会有此问题；迁移场景请在门户对每个应用重新 publish"
  fi
fi

# 中台本机探活
if [[ "$DRY_RUN" -eq 1 ]]; then
  warn "--dry-run：跳过探活"
elif curl -sf --max-time 5 "http://127.0.0.1:${HUB_PORT}/" >/dev/null; then
  ok "中台本机响应正常（127.0.0.1:${HUB_PORT}）"
else
  warn "中台本机探活失败，检查：journalctl -u ai-hub -n 50"
  warn "若 8099 等端口被占用后启动失败：ss -lntp | grep ${HUB_PORT} 看是谁占着"
fi

SCHEME="$PUBLIC_SCHEME"
# 网关自测用的探测目标：走 TLS 时探 443 入口（需 -k，证书是刚签的自签/未生效状态），
# 否则探 HTTP 入口。注意 Traefik 容器内始终是 80/443，宿主端口由 compose 映射决定。
if [[ "$SCHEME" == https ]]; then
  GATEWAY_PROBE_SCHEME=https
  GATEWAY_PROBE_PORT="$GATEWAY_TLS_PORT"
  GATEWAY_PROBE_PATH="/"
else
  GATEWAY_PROBE_SCHEME=http
  GATEWAY_PROBE_PORT="$GATEWAY_PORT"
  GATEWAY_PROBE_PATH="/"
fi
if [[ "$GATEWAY_PORT" != 80 ]]; then
  GATEWAY_NOTE="
  ⚠ 网关未独占 80：Traefik 监听宿主 ${GATEWAY_PORT}/TLS ${GATEWAY_TLS_PORT}，需由前置 nginx 反代。
    反代配置（Host 头必须透传，子域名路由靠它）：
      location / {
        proxy_pass http://127.0.0.1:${GATEWAY_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
      }
    ACME 说明：Traefik 用的 tlsChallenge 走 443，必须把 443 也反代到 ${GATEWAY_TLS_PORT}；
    若前置只反代 80，则改用 HTTP-01 挑战并在 traefik.yml 里换 httpChallenge。"
else
  GATEWAY_NOTE=""
fi

cat <<EOF

────────────────────────────────────────────────────────────
  门户:   ${SCHEME}://$DOMAIN
  应用:   ${SCHEME}://<slug>.$DOMAIN
  MCP:    ${SCHEME}://$DOMAIN/mcp

  中台端口: ${HUB_PORT}（仅本机 + Docker 内网，公网请勿放行）
  网关端口: ${GATEWAY_PORT}（Traefik，宿主侧）
  身份层:   ${IDENTITY_PROVIDER}$([[ "$IDENTITY_PROVIDER" == dev ]] && echo "（上线前必须切飞书）")
────────────────────────────────────────────────────────────
${GATEWAY_NOTE}
逐项验证（按顺序）：

  1. 路由与证书
     curl -I -H "Host: $DOMAIN" ${GATEWAY_PROBE_SCHEME}://127.0.0.1:${GATEWAY_PROBE_PORT}${GATEWAY_PROBE_PATH}   # 直连网关自测，绕过前置 nginx
     docker compose -f infra/docker-compose.yml logs traefik --tail 30

  2. 身份层
     浏览器打开 ${SCHEME}://$DOMAIN → 应跳转飞书授权页
     若停留在 dev 登录表单：检查 .env 里 HUB_IDENTITY_PROVIDER=feishu 且凭证非空
     若飞书报 redirect_uri 不匹配：核对开放平台登记与 FEISHU_REDIRECT_URI 逐字符一致

  3. 发布一个应用（发给你的 Agent）
     请连接企业 AI 中台 MCP：${SCHEME}://$DOMAIN/mcp，
     调用 connect，agentName 设为你的名称，userToken 设为网页登录后 /__hub__/me 里的 token。
     然后在项目目录下调用 publish_app。

  4. 权限强制（关键安全项，必须逐条验）
     匿名访问应用子域名        → 期望 401/302 登录页
     换一个无权限账号登录       → 期望 403
     应用正常访问              → 期望 200

  5. 资源与运维
     docker stats --no-stream                   # 各容器 CPU/内存是否在配额内
     docker logs hub-<slug>                     # 应用容器日志
     tail -50 data/logs/<appId>.log             # 中台构建日志
     systemctl status ai-hub                    # 中台服务状态

  6. 备份（建议加 cron 每日执行，直接复制下面这行）
     tar czf /backup/ai-hub-\$(date +\%F).tar.gz -C $HUB_ROOT data
────────────────────────────────────────────────────────────
EOF
