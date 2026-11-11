#!/bin/bash
# ============================================================
# 上线收尾脚本：备案完成 + DNS 生效后，签发证书并做上线验收
#
# 用法：
#   bash infra/finish-launch.sh [域名]      # 默认 unilink.icu
#
# 前置条件（两条缺一不可）：
#   1) Cloudflare DNS 已加 A 记录：@ → 服务器公网 IP（Proxy=DNS only 灰云）
#   2) 通配符记录：* → 服务器公网 IP（否则应用子域名签不出证书）
#
# 本脚本做四件事：
#   检查 DNS → 触发 Traefik 重新申请证书 → 核验证书签发者 → 输出验收清单
# ============================================================
set -uo pipefail

DOMAIN="${1:-unilink.icu}"
TRAEFIK_C="ai-hub-traefik-1"
HUB_URL="https://${DOMAIN}"
WARN=0

echo "═══════════════════════════════════════════════"
echo " 上线收尾检查 · ${DOMAIN}"
echo "═══════════════════════════════════════════════"

# ----------------------------------------------------------
echo ""
echo "【1/4】DNS 解析检查"

# 云厂商内网 DNS（火山引擎 100.96.0.x 等）常对刚添加的记录返回空结果，
# 而公共 DNS 早已生效。因此逐级回退到公共解析器再判定，避免误判为"无记录"。
resolve_a() {
    local name="$1" ip=""
    for ns in "" "@223.5.5.5" "@8.8.8.8" "@1.1.1.1"; do
        ip=$(dig ${ns} +short "${name}" A 2>/dev/null | grep -E "^[0-9.]+$" | head -1)
        [[ -n "${ip}" ]] && { echo "${ip}"; return 0; }
    done
    echo ""
    return 1
}

A_REC=$(resolve_a "${DOMAIN}")
if [[ -z "${A_REC}" ]]; then
    echo "  ✗ ${DOMAIN} 公共 DNS 也查不到 A 记录 —— 请到 Cloudflare 添加："
    echo "      Type=A   Name=@   IPv4=<服务器公网 IP>   Proxy=DNS only（灰云）"
    exit 1
fi
echo "  ✓ ${DOMAIN} → ${A_REC}"

PROBE="acme-probe-$RANDOM"
WILD=$(resolve_a "${PROBE}.${DOMAIN}")
if [[ -z "${WILD}" ]]; then
    echo "  ⚠ 通配符 *.${DOMAIN} 未解析 —— 主域名能用，但应用子域名签不出证书"
    echo "    请再加一条：Type=A   Name=*   IPv4=${A_REC}   Proxy=DNS only（灰云）"
    WARN=1
else
    echo "  ✓ *.${DOMAIN} → ${WILD}"
fi

# ----------------------------------------------------------
echo ""
echo "【2/4】触发 Traefik 重新申请证书"
docker restart "${TRAEFIK_C}" >/dev/null 2>&1 && echo "  ✓ 已重启 ${TRAEFIK_C}" || echo "  ✗ 重启失败：docker restart ${TRAEFIK_C}"
sleep 25
echo "  ── ACME 日志 ──"
docker logs --since 1m "${TRAEFIK_C}" 2>&1 | grep -iE "acme|certificate|challenge" | tail -8 | sed 's/^/  /'

# ----------------------------------------------------------
echo ""
echo "【3/4】核验证书"
# 直连 127.0.0.1 + SNI，绕开本机 DNS（云内 DNS 常解析不了自己的域名）
CERT_SUBJ=$(echo | openssl s_client -connect "127.0.0.1:443" -servername "${DOMAIN}" 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>/dev/null)
if [[ -z "${CERT_SUBJ}" ]]; then
    echo "  ✗ 取不到证书（域名可能还没生效到公网）"
    WARN=1
else
    echo "${CERT_SUBJ}" | sed 's/^/  /'
    if echo "${CERT_SUBJ}" | grep -qiE "let.?s ?encrypt|R[0-9]|YR[0-9]|E[0-9]"; then
        echo "  ✓ 证书已由 Let's Encrypt 签发"
    else
        echo "  ⚠ 当前不是 Let's Encrypt 证书（可能是 Traefik 自签）—— ACME 尚未成功"
        WARN=1
    fi
fi

# ----------------------------------------------------------
echo ""
echo "【4/4】上线验收清单"
# 同理用 --resolve 直连，避免本机 DNS 影响验收结果
check() {
    local name="$1" path="$2" expect="$3" accept="$4"
    local code
    code=$(curl -sk -m 15 -o /dev/null -w "%{http_code}" ${accept:+-H "${accept}"} --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}${path}" 2>/dev/null)
    if [[ "${code}" == "${expect}" ]]; then
        echo "  ✓ ${name}（${code}）"
    else
        echo "  ✗ ${name} 期望 ${expect} 实际 ${code}"
        WARN=1
    fi
}
check "门户首页 ${HUB_URL}/"                    "/"                            "200"  ""
# MCP 端点必须带 Accept 头，否则按协议返回 406（不是故障）
check "MCP 接入 ${HUB_URL}/mcp"                 "/mcp"                         "200"  "Accept: application/json, text/event-stream"
check "登录跳转 ${HUB_URL}/__hub__/auth/login"   "/__hub__/auth/login"          "302"  ""

REDIR=$(curl -sk -m 10 -o /dev/null -w "%{redirect_url}" --resolve "${DOMAIN}:443:127.0.0.1" "${HUB_URL}/__hub__/auth/login" 2>/dev/null)
if [[ "${REDIR}" == *"open.feishu.cn"* ]]; then
    echo "  ✓ 飞书授权跳转正常"
else
    echo "  ✗ 飞书授权跳转异常：${REDIR}"
    WARN=1
fi

echo ""
echo "  ── 公网视角复核（走真实域名，不带 --resolve）──"
PUB=$(curl -sk -m 15 -o /dev/null -w "%{http_code}" "${HUB_URL}/" 2>/dev/null)
if [[ "${PUB}" == "200" ]]; then
    echo "  ✓ 公网访问 ${HUB_URL}/ → 200"
else
    echo "  ⚠ 公网访问 ${HUB_URL}/ → ${PUB}（若服务器内网 DNS 解析不了本域名，属本机现象，不影响外部用户）"
fi

echo ""
if [[ "${WARN}" -eq 0 ]]; then
    echo "✅ 全部通过，可以正式交付员工使用。"
else
    echo "⚠ 仍有未通过项，见上面标 ✗ / ⚠ 的条目。"
fi
