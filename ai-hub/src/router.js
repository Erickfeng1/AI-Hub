import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { load } from "./store.js";
import { createMcpServer, getSkills, getLibrary, getDeployer } from "./mcp-core.js";
import { compareVersions } from "./skills.js";
import { categoryLabel, MAX_LIBRARY_SIZE } from "./library.js";
import { recordUsage, recentFor, usageCount } from "./usage.js";
import {
  currentUser,
  canView,
  canManage,
  getProvider,
  identityConfig,
  upsertUser,
  sessionCookie,
  sessionInfo,
  destroySession,
  SESSION_COOKIE,
} from "./identity.js";
import {
  HUB_PORT,
  HUB_DOMAIN,
  HUB_ORIGIN,
  HUB_SCHEME,
  DATA_DIR,
  appUrl,
  VISIBILITY_LABELS,
  TYPE_LABELS,
  isDockerMode,
} from "./config.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

let cache = { mtimeMs: 0, store: null };

export function getStore() {
  const file = path.join(DATA_DIR, "store.json");
  try {
    const { mtimeMs } = fs.statSync(file);
    if (mtimeMs !== cache.mtimeMs) {
      cache = { mtimeMs, store: load() };
    }
  } catch {
    cache = { mtimeMs: 0, store: load() };
  }
  return cache.store;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const MCP_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "mcp-server.js");
const MCP_HTTP_URL = `${HUB_ORIGIN}/mcp`;

/**
 * 构造浏览器可见的绝对 URL。走 Traefik 时以 x-forwarded-proto 为准，
 * 避免在 https 页面上生成 http:// 链接（混合内容会被浏览器拦截）。
 */
function publicOrigin(req) {
  const proto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  if (proto === "https" || proto === "http") {
    const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || `${HUB_DOMAIN}:${HUB_PORT}`)
      .split(",")[0]
      .trim();
    return `${proto}://${host}`;
  }
  return HUB_ORIGIN;
}

const CONNECT_PROMPT = `请连接企业 AI 中台（MCP Server）。
方式一（本地 Agent）：运行 node ${MCP_PATH}，然后调用 connect 工具，agentName 设为你的名称，userToken 设为我在中台网页登录后获得的用户令牌。
方式二（远程 Agent）：MCP 地址 ${MCP_HTTP_URL}（Streamable HTTP）。
妥善保存 connect 返回的 token。`;

const PUBLISH_PROMPT = `请把我的应用发布到企业 AI 中台：
调用 publish_app，projectPath = 我的项目绝对路径，agentToken = 刚才 connect 返回的 token。
应用名和权限范围（self 仅自己 / department 部门 / users 指定同事 / all 全员）先问我，不要擅自决定。`;

const SKILL_PROMPT = `请把我的 Skill 发布到企业 AI 中台：
调用 publish_skill，projectPath = 我的 Skill 目录（含 SKILL.md），agentToken = 刚才 connect 返回的 token。
版本号与权限范围先问我，不要擅自决定。

把中台上的 Skill 装到本地：调用 list_skills 找到 skillId，再调用 export_skill 导出整包（返回 base64 或下载链接），解压后放入本地 skills 目录。

检查本地 Skill 是否有更新：调用 check_skill_version，platform-newer 时用 export_skill 拉取最新整包提醒我更新。`;

const LIBRARY_PROMPT = `请把这份资料归档到企业 AI 中台资料库：
调用 publish_library，sourcePath = 文件绝对路径（或 contentBase64 = 文件内容），fileName = 文件名，agentToken = 刚才 connect 返回的 token。
权限范围（self 仅自己 / department 部门 / users 指定同事 / all 全员）先问我，不要擅自决定。`;

function iconSvg(name) {
  const chars = [...String(name || "A")];
  const ch = chars[0] || "A";
  const colors = ["#185FA5", "#0F6E56", "#534AB7", "#993C1D", "#993556", "#854F0B"];
  const sum = chars.reduce((a, c) => a + c.codePointAt(0), 0);
  const color = colors[sum % colors.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="33" dominant-baseline="central" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#ffffff">${escapeHtml(ch)}</text></svg>`;
}

/* ---------------- 门户页面 ---------------- */

function renderHubPage(store, user, csrf = "") {
  const apps = store.apps || [];
  const agents = store.agents || [];
  const running = apps.filter((a) => a.status === "running").length;
  const visible = user ? apps.filter((a) => canView(a, user)) : [];
  // 千人千面：登录用户的应用按个人使用频次排序，常用置顶（无记录保持发布时间序）
  if (user) {
    visible.sort(
      (a, b) =>
        usageCount(user.id, "app", b.id) - usageCount(user.id, "app", a.id) ||
        (b.createdAt || "").localeCompare(a.createdAt || ""),
    );
  }
  const hidden = apps.length - visible.length;
  const provider = getProvider();
  const tokenSuffix = process.env.HUB_COOKIE_DOMAIN || !user ? "" : `?ah_token=${encodeURIComponent(user.token)}`;

  const cards = visible.map((a) => {
    const vis = VISIBILITY_LABELS[a.visibility] || a.visibility;
    const type = TYPE_LABELS[a.type] || a.type;
    const statusDot = a.status === "running" ? "#3B6D11" : a.status === "failed" ? "#A32D2D" : "#854F0B";
    // 下架按钮：仅发布者可见（与后端 canManage 判定一致）
    const owner = user && canManage(a, user);
    return `
      <div class="card">
        <img class="icon" src="/__hub__/icon/${encodeURIComponent(a.slug)}" alt="">
        <div class="body">
          <div class="title">${escapeHtml(a.name)}</div>
          <div class="meta"><span class="badge type">${escapeHtml(type)}</span><span class="badge vis">${escapeHtml(vis)}</span><span class="status"><span class="dot" style="background:${statusDot}"></span>${escapeHtml(a.status)}</span></div>
          <div class="slug">${escapeHtml(a.url)}</div>
          <div class="owner">发布者：${escapeHtml(a.owner)} · ${escapeHtml(a.createdAt?.slice(0, 10) || "")}</div>
        </div>
        <div class="actions">
          <a class="open" href="${escapeHtml(a.url)}${tokenSuffix}" target="_blank">打开</a>
          ${owner ? `<form class="del" method="POST" action="/__hub__/apps/${encodeURIComponent(a.id)}/unpublish" onsubmit="return confirm('确定下架并删除应用「${escapeHtml(a.name)}」？该操作会停止运行并清理文件，不可恢复。')">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button type="submit" class="del-btn">下架</button>
          </form>` : ""}
        </div>
      </div>`;
  }).join("");

  const agentList = agents.map((ag) => {
    const owner = store.users.find((u) => u.id === ag.userId);
    return `
      <li><strong>${escapeHtml(ag.name)}</strong> <span class="token">${escapeHtml(ag.token.slice(0, 14))}…</span> <span class="muted">${owner ? `绑定用户 ${escapeHtml(owner.name)} · ` : ""}连接于 ${escapeHtml(ag.createdAt?.slice(0, 16).replace("T", " ") || "")}</span></li>`;
  }).join("");

  const allSkills = store.skills || [];
  const visibleSkills = user ? allSkills.filter((s) => canView(s, user)) : [];
  const hiddenSkills = allSkills.length - visibleSkills.length;
  const skillCards = visibleSkills.map((s) => {
    const vis = VISIBILITY_LABELS[s.visibility] || s.visibility;
    const localRec = (store.installedSkills || []).find((r) => r.userId === user.id && r.skillId === s.id);
    const hasUpdate = localRec && compareVersions(s.version, localRec.localVersion) > 0;
    const tokenSuffix = process.env.HUB_COOKIE_DOMAIN || !user ? "" : `?ah_token=${encodeURIComponent(user.token)}`;
    // 下架按钮：仅发布者可见
    const owner = user && canManage(s, user);
    return `
      <div class="card">
        <img class="icon" src="/__hub__/icon/${encodeURIComponent(s.slug)}" alt="">
        <div class="body">
          <div class="title">${escapeHtml(s.name)} <span class="version">v${escapeHtml(s.version)}</span>${hasUpdate ? ` <span class="badge upd">有新版本 · 本地 v${escapeHtml(localRec.localVersion)}</span>` : ""}</div>
          <div class="meta"><span class="badge vis">${escapeHtml(vis)}</span><span class="muted">${s.files?.length || 0} 个文件</span></div>
          <div class="owner">${escapeHtml(s.description || "（无描述）")}</div>
          <div class="owner">发布者：${escapeHtml(s.owner)} · 更新于 ${escapeHtml(s.updatedAt?.slice(0, 16).replace("T", " ") || "")}</div>
        </div>
        <div class="actions">
          <a class="open" href="/__hub__/skills/${encodeURIComponent(s.id)}/export${tokenSuffix}">下载</a>
          ${owner ? `<form class="del" method="POST" action="/__hub__/skills/${encodeURIComponent(s.id)}/unpublish" onsubmit="return confirm('确定下架并删除 Skill「${escapeHtml(s.name)}」？该操作会清理文件，不可恢复。')">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button type="submit" class="del-btn">下架</button>
          </form>` : ""}
        </div>
      </div>`;
  }).join("");

  const allLibrary = store.library || [];
  const visibleLibrary = user ? allLibrary.filter((x) => canView(x, user)) : [];
  // 资料库同样按个人下载频次排序，常用置顶
  if (user) {
    visibleLibrary.sort(
      (a, b) =>
        usageCount(user.id, "library", b.id) - usageCount(user.id, "library", a.id) ||
        (b.createdAt || "").localeCompare(a.createdAt || ""),
    );
  }
  const hiddenLibrary = allLibrary.length - visibleLibrary.length;
  const libraryCards = visibleLibrary
    .map((x) => {
      const vis = VISIBILITY_LABELS[x.visibility] || x.visibility;
      const dl = getLibrary().downloadCount(x.id);
      return `
      <div class="card">
        <div class="body">
          <div class="title">${escapeHtml(x.name)}</div>
          <div class="meta"><span class="badge cat">${escapeHtml(categoryLabel(x.category))}</span><span class="badge vis">${escapeHtml(vis)}</span><span class="muted">${(x.size / 1024).toFixed(1)} KB</span></div>
          <div class="owner">上传者：${escapeHtml(x.owner)} · ${escapeHtml(x.createdAt?.slice(0, 10) || "")} · 下载 ${dl} 次</div>
        </div>
        <a class="open" href="/__hub__/library/${encodeURIComponent(x.id)}/download${tokenSuffix}">下载</a>
      </div>`;
    })
    .join("");

  /* 千人千面：最近使用（应用 + 资料混合，按频次排序） */
  const recentItems = user
    ? recentFor(user.id, 6)
        .map((r) => {
          if (r.kind === "app") {
            const a = visible.find((x) => x.id === r.refId);
            return a ? { kind: "应用", name: a.name, href: `${a.url}${tokenSuffix}`, meta: `使用 ${r.count} 次` } : null;
          }
          const l = visibleLibrary.find((x) => x.id === r.refId);
          return l
            ? { kind: "资料", name: l.name, href: `/__hub__/library/${l.id}/download${tokenSuffix}`, meta: `下载 ${r.count} 次` }
            : null;
        })
        .filter(Boolean)
    : [];
  const recentList = recentItems
    .map(
      (r) =>
        `<li><a href="${escapeHtml(r.href)}">${escapeHtml(r.name)}</a> <span class="badge">${r.kind}</span> <span class="muted">${r.meta}</span></li>`,
    )
    .join("");

  const uploadForm = user
    ? `<form class="upload" method="POST" action="/__hub__/library/upload" enctype="multipart/form-data">
        <input type="file" name="file" required>
        <input type="text" name="name" placeholder="显示名称（可选）">
        <select name="visibility">
          <option value="self">仅自己</option>
          <option value="all">全员</option>
          <option value="department">部门可见</option>
          <option value="users">指定同事</option>
        </select>
        <input type="text" name="department" placeholder="部门名（部门可见时填）">
        <input type="text" name="users" placeholder="同事姓名，逗号分隔（指定同事时填）">
        <button type="submit">上传资料</button>
      </form>`
    : "";

  const userBar = user
    ? `<div class="userbar">当前身份：<strong>${escapeHtml(user.name)}</strong>（${escapeHtml(user.provider)}${user.department ? ` · ${escapeHtml(user.department)}` : ""}）
        <span class="token">用户令牌 ${escapeHtml(user.token.slice(0, 16))}…</span>
        <a href="/__hub__/auth/logout">退出</a></div>`
    : provider.interactive
      ? `<div class="userbar"><a class="login-btn" href="/__hub__/auth/login">${escapeHtml(provider.label)}</a></div>`
      : `<div class="userbar">未登录（开发模式）
        <form method="GET" action="/__hub__/auth/dev-login" class="devlogin">
          <input name="name" placeholder="你的姓名" required>
          <input name="department" placeholder="部门（可选）">
          <button type="submit">登录</button>
        </form></div>`;

  const loginHint = user
    ? ""
    : `<div class="empty">未登录，只能看到公开提示。登录后可查看权限范围内的应用。</div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>企业 AI 中台</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f7f7f5; color: #2c2c2a; line-height: 1.6; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
  header h1 { font-size: 22px; font-weight: 500; }
  header p { color: #5f5e5a; font-size: 13px; margin-top: 4px; }
  .userbar { background: #fff; border: 1px solid #e5e3dc; border-radius: 10px; padding: 10px 16px; font-size: 13px; margin-top: 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .userbar a { color: #185fa5; }
  .login-btn { border: 1px solid #b5d4f4; background: #e6f1fb; border-radius: 8px; padding: 4px 14px; text-decoration: none; }
  .devlogin { display: inline-flex; gap: 8px; }
  .devlogin input { border: 1px solid #d3d1c7; border-radius: 8px; padding: 4px 10px; font-size: 13px; }
  .devlogin button { border: 1px solid #b5d4f4; background: #e6f1fb; color: #185fa5; border-radius: 8px; padding: 4px 14px; font-size: 13px; cursor: pointer; }
  .stats { display: flex; gap: 12px; margin: 24px 0 8px; }
  .stat { background: #fff; border: 1px solid #e5e3dc; border-radius: 12px; padding: 14px 20px; flex: 1; }
  .stat b { font-size: 22px; font-weight: 500; display: block; }
  .stat span { font-size: 12px; color: #5f5e5a; }
  section { margin-top: 28px; }
  h2 { font-size: 15px; font-weight: 500; margin-bottom: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  .card { background: #fff; border: 1px solid #e5e3dc; border-radius: 12px; padding: 16px; display: flex; gap: 12px; align-items: flex-start; }
  .icon { width: 44px; height: 44px; border-radius: 10px; flex: none; }
  .body { flex: 1; min-width: 0; }
  .title { font-size: 14px; font-weight: 500; }
  .meta { display: flex; gap: 6px; align-items: center; margin: 6px 0 4px; flex-wrap: wrap; }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #eef2f7; color: #185fa5; }
  .badge.vis { background: #e8f3ee; color: #0f6e56; }
  .badge.upd { background: #faece7; color: #993c1d; }
  .badge.cat { background: #eef0fb; color: #534ab7; }
  .upload { background: #fff; border: 1px solid #e5e3dc; border-radius: 12px; padding: 14px 16px; display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; align-items: center; }
  .upload input[type="file"] { font-size: 12px; flex: 1 1 170px; }
  .upload input[type="text"], .upload select { border: 1px solid #d3d1c7; border-radius: 8px; padding: 5px 10px; font-size: 12px; flex: 1 1 130px; }
  .upload button { border: 1px solid #b5d4f4; background: #e6f1fb; color: #185fa5; border-radius: 8px; padding: 6px 16px; font-size: 12px; cursor: pointer; }
  ul.recent { list-style: none; }
  ul.recent li { background: #fff; border: 1px solid #e5e3dc; border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 8px; display: flex; gap: 8px; align-items: center; }
  ul.recent li a { color: #185fa5; text-decoration: none; font-weight: 500; }
  ul.recent li a:hover { text-decoration: underline; }
  .version { font-size: 11px; font-family: ui-monospace, monospace; background: #f1efe8; color: #854f0b; border-radius: 6px; padding: 1px 7px; margin-left: 6px; }
  .status { font-size: 11px; color: #5f5e5a; display: inline-flex; align-items: center; gap: 4px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .slug { font-size: 12px; color: #185fa5; font-family: ui-monospace, monospace; word-break: break-all; }
  .owner { font-size: 11px; color: #888780; margin-top: 2px; }
  .open { font-size: 12px; color: #185fa5; text-decoration: none; border: 1px solid #b5d4f4; padding: 4px 12px; border-radius: 8px; flex: none; }
  .open:hover { background: #e6f1fb; }
  .actions { display: flex; flex-direction: column; gap: 6px; flex: none; align-items: stretch; }
  form.del { margin: 0; }
  .del-btn { font-size: 12px; color: #a32d2d; background: #fff; border: 1px solid #f0cfcf; padding: 4px 12px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
  .del-btn:hover { background: #fdf0f0; }
  .empty { background: #fff; border: 1px dashed #d3d1c7; border-radius: 12px; padding: 28px; text-align: center; color: #888780; font-size: 13px; }
  .prompt { background: #fff; border: 1px solid #e5e3dc; border-radius: 12px; padding: 16px; margin-bottom: 12px; }
  .prompt h3 { font-size: 13px; font-weight: 500; margin-bottom: 8px; }
  .prompt pre { background: #f1efe8; border-radius: 8px; padding: 12px; font-size: 12px; font-family: ui-monospace, monospace; white-space: pre-wrap; word-break: break-all; color: #444441; }
  ul.agents { list-style: none; }
  ul.agents li { background: #fff; border: 1px solid #e5e3dc; border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 8px; }
  .token { font-family: ui-monospace, monospace; font-size: 11px; color: #534ab7; }
  .muted { color: #888780; font-size: 12px; }
  footer { margin-top: 40px; font-size: 12px; color: #888780; border-top: 1px solid #e5e3dc; padding-top: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>企业 AI 中台 <span style="font-size:12px;color:#888780;font-weight:400">MVP · 本地运行版</span></h1>
    <p>中台即 MCP，Agent 即部署通道。把下面的 Prompt 发给你的 Agent，即可发布应用。</p>
    ${userBar}
  </header>
  <div class="stats">
    <div class="stat"><b>${visible.length}</b><span>可见应用</span></div>
    <div class="stat"><b>${running}</b><span>运行中</span></div>
    <div class="stat"><b>${agents.length}</b><span>已连接 Agent</span></div>
  </div>
  <section>
    <h2>应用广场${hidden > 0 ? `（另有 ${hidden} 个应用不在你的权限范围内）` : ""}</h2>
    ${visible.length ? `<div class="grid">${cards}</div>` : loginHint || `<div class="empty">还没有可见的应用。把下方第二段 Prompt 发给你的 Agent 试试。</div>`}
  </section>
  <section>
    <h2>Skill 库${hiddenSkills > 0 ? `（另有 ${hiddenSkills} 个 Skill 不在你的权限范围内）` : ""}</h2>
    ${visibleSkills.length ? `<div class="grid">${skillCards}</div>` : `<div class="empty">${user ? "还没有可见的 Skill。把下方 Skill Prompt 发给你的 Agent 发布。" : "未登录，登录后可查看权限范围内的 Skill。"}</div>`}
  </section>
  <section>
    <h2>最近使用</h2>
    ${recentItems.length ? `<ul class="recent">${recentList}</ul>` : `<div class="empty">${user ? "打开应用或下载资料后，你的常用入口会置顶显示在这里。" : "未登录，登录后展示你的常用入口。"}</div>`}
  </section>
  <section>
    <h2>资料库${hiddenLibrary > 0 ? `（另有 ${hiddenLibrary} 份资料不在你的权限范围内）` : ""}</h2>
    ${uploadForm}
    ${visibleLibrary.length ? `<div class="grid">${libraryCards}</div>` : `<div class="empty">${user ? "资料库还是空的。用上方表单上传，或把下方资料库 Prompt 发给 Agent 归档。" : "未登录，登录后可查看权限范围内的资料。"}</div>`}
  </section>
  <section>
    <h2>发布你的应用（两段 Prompt）</h2>
    <div class="prompt"><h3>第一段 · 连接中台</h3><pre>${escapeHtml(CONNECT_PROMPT)}</pre></div>
    <div class="prompt"><h3>第二段 · 发布应用</h3><pre>${escapeHtml(PUBLISH_PROMPT)}</pre></div>
    <div class="prompt"><h3>发布 / 检查 Skill</h3><pre>${escapeHtml(SKILL_PROMPT)}</pre></div>
    <div class="prompt"><h3>归档资料到资料库</h3><pre>${escapeHtml(LIBRARY_PROMPT)}</pre></div>
  </section>
  <section>
    <h2>已连接的 Agent</h2>
    ${agents.length ? `<ul class="agents">${agentList}</ul>` : `<div class="empty">暂无 Agent 连接</div>`}
  </section>
  <footer>本地 MVP：身份用开发登录（生产配置 HUB_IDENTITY_PROVIDER=feishu 走飞书 OAuth），运行时默认本地进程（生产设 HUB_EXECUTOR=docker，容器 + Traefik 子域名路由，部署见 infra/）。数据与 Context 存于 data/store.json。资料库混合架构：门户上传 + Agent 归档（publish_library），飞书知识库索引待 wiki 权限审批后接入。</footer>
</div>
</body>
</html>`;
}

function renderLoginPage(next) {
  const provider = getProvider();
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录 · 企业 AI 中台</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f7f7f5;display:flex;min-height:100vh;align-items:center;justify-content:center}
.box{background:#fff;border:1px solid #e5e3dc;border-radius:16px;padding:32px;width:340px}
h1{font-size:18px;font-weight:500;margin-bottom:6px}p{font-size:12px;color:#888780;margin-bottom:18px}
input{width:100%;border:1px solid #d3d1c7;border-radius:8px;padding:8px 12px;font-size:14px;margin-bottom:10px}
button{width:100%;border:none;background:#185fa5;color:#fff;border-radius:8px;padding:9px;font-size:14px;cursor:pointer}
a{color:#185fa5;font-size:13px}</style></head><body>
<div class="box"><h1>登录企业 AI 中台</h1><p>${escapeHtml(provider.label)}</p>
<form method="GET" action="/__hub__/auth/dev-login">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <input name="name" placeholder="姓名" required autofocus>
  <input name="department" placeholder="部门（可选）">
  <button type="submit">登录</button>
</form>
<p style="margin-top:14px"><a href="/">返回门户</a></p></div></body></html>`;
}

function forbiddenPage(host, user) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>403</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f7f7f5;display:flex;min-height:100vh;align-items:center;justify-content:center;color:#2c2c2a}
.box{background:#fff;border:1px solid #e5e3dc;border-radius:16px;padding:32px;max-width:420px;text-align:center}
h1{font-size:20px;margin-bottom:8px}p{font-size:13px;color:#5f5e5a;margin-bottom:16px}
a{color:#185fa5}</style></head><body><div class="box">
<h1>无权访问</h1><p>应用 <b>${escapeHtml(host)}</b> 不在 ${escapeHtml(user.name)} 的权限范围内。请联系发布者调整权限（self / department / users / all）。</p>
<a href="${HUB_ORIGIN}">返回应用广场</a></div></body></html>`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(obj));
}

function redirect(res, location, cookie) {
  const headers = { Location: location };
  if (cookie) headers["Set-Cookie"] = cookie;
  res.writeHead(302, headers);
  res.end();
}

/* ---------------- 静态服务与代理 ---------------- */

function serveStatic(dir, req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return send(res, 400, "Bad Request");
  }
  let filePath = path.normalize(path.join(dir, urlPath));
  if (!filePath.startsWith(dir)) return send(res, 403, "Forbidden");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const idx = path.join(dir, "index.html");
    if (!fs.existsSync(idx)) return send(res, 404, `<h1>404</h1><p>${escapeHtml(urlPath)} 不存在</p>`);
    filePath = idx;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(filePath).pipe(res);
}

function proxy(req, res, port) {
  const upstream = http.request(
    { hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: { ...req.headers, host: req.headers.host } },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    },
  );
  upstream.on("error", () => {
    send(res, 502, `<h1>502</h1><p>应用进程未响应（端口 ${port}）。查看 data/logs/ 下的日志。</p>`);
  });
  req.pipe(upstream);
}

/* ---------------- MCP HTTP 传输（Streamable HTTP） ---------------- */

async function handleMcpHttp(req, res) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        return sendJson(res, 413, { jsonrpc: "2.0", error: { code: -32600, message: "payload too large" }, id: null });
      }
      chunks.push(chunk);
    }
  } catch {
    return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32600, message: "bad request" }, id: null });
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let body;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
  }

  // stateless：每个请求独立 transport + server；状态全部落 store.json，执行器进程表模块级共享
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  res.on("close", () => {
    try {
      server.close();
      transport.close();
    } catch {
      /* ignore */
    }
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null });
  }
}

/* ---------------- 门户路由 ---------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeNext(next) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

async function handleAuthRoutes(req, res, url) {
  const provider = getProvider();
  const p = url.pathname;

  if (p === "/__hub__/auth/login") {
    if (provider.interactive) {
      try {
        return redirect(res, provider.loginUrl(safeNext(url.searchParams.get("next"))));
      } catch (e) {
        return send(res, 500, `<h1>500</h1><p>${escapeHtml(e.message)}</p>`);
      }
    }
    return send(res, 200, renderLoginPage(safeNext(url.searchParams.get("next"))));
  }

  if (p === "/__hub__/auth/dev-login") {
    if (provider.interactive) return send(res, 400, "当前身份 Provider 不是 dev，无法使用开发登录。");
    let params = url.searchParams;
    if (req.method === "POST") {
      const body = await readBody(req);
      params = new URLSearchParams(body);
    }
    const name = String(params.get("name") || "").trim();
    if (!name) return send(res, 400, "缺少姓名参数");
    const department = String(params.get("department") || "").trim();
    const user = upsertUser({ provider: "dev", providerId: `dev-${name}`, name, department });
    return redirect(res, safeNext(params.get("next")), sessionCookie(user.id, req));
  }

  if (p === "/__hub__/auth/callback") {
    if (!provider.interactive) return send(res, 400, "当前身份 Provider 不是 OAuth 类型，无回调。");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const stateEntry = provider.takeState ? provider.takeState(state) : null;
    if (!code || !stateEntry) return send(res, 400, `<h1>登录失败</h1><p>state 无效或已过期，请重新 <a href="/__hub__/auth/login">登录</a>。</p>`);
    try {
      const profile = await provider.exchange(code);
      const user = upsertUser({ provider: provider.id, ...profile });
      return redirect(res, safeNext(stateEntry.next), sessionCookie(user.id, req));
    } catch (e) {
      return send(res, 500, `<h1>登录失败</h1><p>${escapeHtml(e.message)}</p>`);
    }
  }

  if (p === "/__hub__/auth/logout") {
    const cookie = String(req.headers.cookie || "");
    const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie);
    if (m) destroySession(decodeURIComponent(m[1]));
    return redirect(res, "/", `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
  }

  return null;
}

function handleMe(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "unauthenticated" });
  const store = getStore();
  return sendJson(res, 200, {
    user: { id: user.id, name: user.name, department: user.department, provider: user.provider, token: user.token },
    visibleApps: store.apps.filter((a) => canView(a, user)).map((a) => a.id),
  });
}

/* ---------------- 鉴权端点（Traefik forwardAuth 回调） ----------------
 * docker 模式下应用路由挂在 Traefik，每个应用的 router 都配了 forwardAuth 中间件，
 * 网关先把请求送到这里，200 才放行进容器——权限模型与 local 模式完全一致。
 * 注意：Traefik 转发时不带查询参数，localhost 的 ?ah_token= 兜底在此模式下不可用，
 * 生产需配置 HUB_COOKIE_DOMAIN 让 Cookie 穿透子域名。 */
function handleAuthz(req, res, url) {
  const host = String(url.searchParams.get("host") || req.headers["x-forwarded-host"] || "").split(":")[0];
  const slug = host.endsWith(`.${HUB_DOMAIN}`) ? host.slice(0, -(HUB_DOMAIN.length + 1)) : null;
  const app = slug ? getStore().apps.find((a) => a.slug === slug) : null;
  if (!app) return send(res, 404, `unknown app: ${host}`);

  const user = currentUser(req);
  if (!user) {
    const acceptsHtml = String(req.headers.accept || "").includes("text/html");
    if (acceptsHtml) {
      const next = encodeURIComponent(`${HUB_SCHEME}://${host}${url.searchParams.get("path") || "/"}`);
      return redirect(res, `${HUB_ORIGIN}/__hub__/auth/login?next=${next}`);
    }
    return sendJson(res, 401, { error: "unauthenticated", message: "请先登录中台" });
  }
  if (!canView(app, user)) {
    return send(res, 403, forbiddenPage(host, user));
  }
  // 放行；X-Forwarded-User 经 Traefik authResponseHeaders 透传给应用（应用可选读）。
  // 姓名可能含中文，HTTP 头不允许非 ASCII，按 RFC 3986 百分号编码传输，应用侧 decodeURIComponent 还原
  res.writeHead(200, { "X-Forwarded-User": encodeURIComponent(user.name), "Content-Length": "0" });
  res.end();
}

/* Skill 整包下载端点：鉴权 + 权限校验后返回 tar.gz */
async function handleSkillExport(req, res, url) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "unauthenticated", message: "请先登录中台（Bearer 用户令牌或门户登录）" });
  const m = /^\/__hub__\/skills\/([^/]+)\/export$/.exec(url.pathname);
  if (!m) return send(res, 404, "Not Found");
  const skillId = decodeURIComponent(m[1]);
  try {
    const packed = await getSkills().pack(skillId, user);
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${packed.fileName}"`,
      "Content-Length": packed.size,
    });
    fs.createReadStream(packed.file).pipe(res);
  } catch (e) {
    const forbidden = /无权/.test(e.message);
    return sendJson(res, forbidden ? 403 : 404, { error: e.message });
  }
}

/* ---------------- 资料库：上传 / 下载 / 删除 ---------------- */

/** 解析 multipart/form-data（单文件字段 file + 若干文本字段）。
 *  用 latin1 中转保证二进制内容按字节切分时不丢失。 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) throw new Error("不是 multipart/form-data 请求");
  const boundary = "--" + (m[1] || m[2]).trim();
  const text = buf.toString("latin1");
  const fields = {};
  let file = null;
  for (const raw of text.split(boundary)) {
    const part = raw.replace(/^(\r\n|\n|\r)/, "").replace(/(\r\n|\n|\r)--$/, "");
    if (!part || part === "--") continue;
    const sep = part.search(/\r\n\r\n|\n\n/);
    if (sep < 0) continue;
    const rawHeaders = part.slice(0, sep);
    const bodyStart = sep + (part.slice(sep).startsWith("\r\n\r\n") ? 4 : 2);
    const body = part.slice(bodyStart).replace(/\r\n$/, "");
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(rawHeaders)?.[1] || "";
    const nameMatch = /name="([^"]*)"/.exec(disposition);
    if (!nameMatch) continue;
    const fileNameMatch = /filename\*?="([^"]*)"/.exec(disposition);
    if (fileNameMatch) {
      const mime = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders)?.[1]?.trim() || "application/octet-stream";
      // 头部按 latin1 读入，文件名按 UTF-8 还原，中文名不乱码
      const fileName = Buffer.from(fileNameMatch[1], "latin1").toString("utf8");
      file = { field: nameMatch[1], fileName, mime, buffer: Buffer.from(body, "latin1") };
    } else {
      fields[nameMatch[1]] = Buffer.from(body, "latin1").toString("utf8");
    }
  }
  return { fields, file };
}

async function handleLibraryUpload(req, res) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "unauthenticated", message: "请先登录中台" });
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.includes("multipart/form-data")) {
    return sendJson(res, 400, { error: "需要 multipart/form-data 上传" });
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const c of req) {
      size += c.length;
      if (size > MAX_LIBRARY_SIZE + 1024 * 1024) return sendJson(res, 413, { error: "文件超过大小上限（50MB）" });
      chunks.push(c);
    }
  } catch {
    return sendJson(res, 400, { error: "请求体读取失败" });
  }
  let parsed;
  try {
    parsed = parseMultipart(Buffer.concat(chunks), contentType);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (!parsed.file?.buffer?.length) return sendJson(res, 400, { error: "未找到文件字段（file）或文件为空" });
  try {
    getLibrary().upload({
      user,
      fileName: parsed.file.fileName || "file",
      buffer: parsed.file.buffer,
      name: parsed.fields.name,
      visibility: parsed.fields.visibility,
      extra: {
        department: parsed.fields.department,
        users: (parsed.fields.users || "")
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
      },
    });
    return redirect(res, "/");
  } catch (e) {
    return send(res, 400, `<h1>上传失败</h1><p>${escapeHtml(e.message)}</p><a href="/">返回门户</a>`);
  }
}

async function handleLibraryDownload(req, res, url) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "unauthenticated", message: "请先登录中台（Bearer 用户令牌或门户登录）" });
  const m = /^\/__hub__\/library\/([^/]+)\/download$/.exec(url.pathname);
  if (!m) return send(res, 404, "Not Found");
  const libId = decodeURIComponent(m[1]);
  try {
    const item = getLibrary().get(libId, user);
    const file = getLibrary().fileOf(item);
    recordUsage(user.id, "library", libId); // 下载即使用记录，驱动千人千面
    const ext = path.extname(item.fileName).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(item.fileName)}"`,
      "Content-Length": fs.statSync(file).size,
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    const forbidden = /无权/.test(e.message);
    return sendJson(res, forbidden ? 403 : 404, { error: e.message });
  }
}

async function handleLibraryDelete(req, res, url) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "unauthenticated" });
  const m = /^\/__hub__\/library\/([^/]+)\/delete$/.exec(url.pathname);
  if (!m) return send(res, 404, "Not Found");
  const libId = decodeURIComponent(m[1]);
  try {
    const item = getLibrary().get(libId, user);
    if (!canManage(item, user)) return sendJson(res, 403, { error: "只有发布者可以删除该资料。" });
    getLibrary().unpublish(libId);
    return redirect(res, "/");
  } catch (e) {
    const forbidden = /无权/.test(e.message);
    return sendJson(res, forbidden ? 403 : 404, { error: e.message });
  }
}

/* ---------------- 下架（删除）应用 / Skill ---------------- */

/**
 * CSRF 校验：破坏性操作必须校验。
 * - Cookie 会话：表单必须携带与该会话匹配的 csrf 令牌（浏览器会自动带 Cookie，故必须防跨站提交）
 * - Bearer / ?ah_token=：调用方显式携带凭据，不存在「自动附带」问题，放行
 */
function checkCsrf(req, url, body) {
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (bearer || url.searchParams.get("ah_token")) return true;
  const session = sessionInfo(req);
  if (!session?.csrf) return false;
  const sent = body?.csrf || url.searchParams.get("csrf") || "";
  return sent === session.csrf;
}

/** 解析 application/x-www-form-urlencoded 表单体 */
function parseForm(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

/** 下架应用：停止运行 + 清理文件 + 从 store 移除（仅发布者） */
async function handleAppUnpublish(req, res, url) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "unauthenticated", message: "请先登录中台" });
  const m = /^\/__hub__\/apps\/([^/]+)\/unpublish$/.exec(url.pathname);
  if (!m) return send(res, 404, "Not Found");
  const appId = decodeURIComponent(m[1]);
  const body = parseForm(await readBody(req));
  if (!checkCsrf(req, url, body)) return sendJson(res, 403, { error: "CSRF 校验失败，请刷新页面后重试" });
  const app = getStore().apps.find((a) => a.id === appId);
  if (!app) return sendJson(res, 404, { error: `应用不存在: ${appId}` });
  if (!canManage(app, user)) return sendJson(res, 403, { error: "只有发布者可以下架该应用。" });
  try {
    await getDeployer().unpublish(appId);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
  return redirect(res, "/");
}

/** 下架 Skill：清理文件 + 从 store 移除 + 清掉本地安装记录（仅发布者） */
async function handleSkillUnpublish(req, res, url) {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "unauthenticated", message: "请先登录中台" });
  const m = /^\/__hub__\/skills\/([^/]+)\/unpublish$/.exec(url.pathname);
  if (!m) return send(res, 404, "Not Found");
  const skillId = decodeURIComponent(m[1]);
  const body = parseForm(await readBody(req));
  if (!checkCsrf(req, url, body)) return sendJson(res, 403, { error: "CSRF 校验失败，请刷新页面后重试" });
  const skill = getStore().skills.find((s) => s.id === skillId);
  if (!skill) return sendJson(res, 404, { error: `Skill 不存在: ${skillId}` });
  if (!canManage(skill, user)) return sendJson(res, 403, { error: "只有发布者可以下架该 Skill。" });
  try {
    getSkills().unpublish(skillId);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
  return redirect(res, "/");
}

export function createHubServer() {
  return http.createServer(async (req, res) => {
    const host = (req.headers.host || "").split(":")[0];
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return send(res, 400, "Bad Request");
    }

    if (req.url.startsWith("/__hub__/icon/")) {
      const slug = decodeURIComponent(req.url.slice("/__hub__/icon/".length).split("?")[0]);
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" });
      return res.end(iconSvg(slug));
    }

    // Traefik forwardAuth 回调：与 host 无关，必须在 host 分发之前处理
    if (url.pathname === "/__hub__/authz") return handleAuthz(req, res, url);

    if (host === HUB_DOMAIN || host === "127.0.0.1" || host === "0.0.0.0") {
      if (url.pathname === "/mcp") return handleMcpHttp(req, res);
      if (url.pathname === "/__hub__/me") return handleMe(req, res);
      if (/^\/__hub__\/skills\/[^/]+\/export$/.test(url.pathname)) return await handleSkillExport(req, res, url);
      if (/^\/__hub__\/skills\/[^/]+\/unpublish$/.test(url.pathname) && req.method === "POST")
        return await handleSkillUnpublish(req, res, url);
      if (/^\/__hub__\/apps\/[^/]+\/unpublish$/.test(url.pathname) && req.method === "POST")
        return await handleAppUnpublish(req, res, url);
      if (/^\/__hub__\/library\/[^/]+\/download$/.test(url.pathname)) return await handleLibraryDownload(req, res, url);
      if (/^\/__hub__\/library\/[^/]+\/delete$/.test(url.pathname) && req.method === "POST") return await handleLibraryDelete(req, res, url);
      if (url.pathname === "/__hub__/library/upload" && req.method === "POST") return await handleLibraryUpload(req, res);
      if (url.pathname.startsWith("/__hub__/auth/")) {
        const handled = await handleAuthRoutes(req, res, url);
        if (handled !== null) return;
      }
      const user = currentUser(req);
      // 破坏性操作表单的 CSRF 令牌（仅 Cookie 会话有；Bearer/ah_token 调用方自带凭据）
      const csrf = sessionInfo(req)?.csrf || "";
      return send(res, 200, renderHubPage(getStore(), user, csrf));
    }

    /* ---- 应用子域名：先鉴权，再服务 ---- */
    const slug = host.endsWith(`.${HUB_DOMAIN}`) ? host.slice(0, -(HUB_DOMAIN.length + 1)) : null;
    // docker 模式下应用由 Traefik（80/443）路由并回调 /__hub__/authz 鉴权，
    // 中台不再直接伺候应用子域名；若请求仍打到中台端口，给出明确指引
    if (isDockerMode() && slug) {
      return send(
        res,
        404,
        `<h1>404</h1><p>docker 模式下应用 <b>${escapeHtml(host)}</b> 由 Traefik 提供服务，请访问 <b>${escapeHtml(`${HUB_SCHEME}://${host}`)}</b>（不带 ${HUB_PORT} 端口，见 infra/ 部署指南）。</p>`,
      );
    }
    const app = slug ? getStore().apps.find((a) => a.slug === slug && a.status === "running") : null;
    if (!app) {
      return send(res, 404, `<h1>404</h1><p>子域名 <b>${escapeHtml(host)}</b> 没有对应应用。回到 <a href="${HUB_ORIGIN}">应用广场</a> 查看已发布应用。</p>`);
    }

    const user = currentUser(req);
    if (!user) {
      const acceptsHtml = String(req.headers.accept || "").includes("text/html");
      if (acceptsHtml) {
        const next = encodeURIComponent(`${publicOrigin(req)}${req.url}`);
        return redirect(res, `${HUB_ORIGIN}/__hub__/auth/login?next=${next}`);
      }
      return sendJson(res, 401, { error: "unauthenticated", message: "请先登录中台（Bearer 用户令牌或门户登录）" });
    }
    if (!canView(app, user)) {
      return send(res, 403, forbiddenPage(host, user));
    }
    // 打开应用首页记一次使用（驱动千人千面「最近使用」；只记根路径，避免静态资源请求灌水）
    if (url.pathname === "/" || url.pathname === "") {
      recordUsage(user.id, "app", app.id);
    }

    if (app.runtime?.kind === "static") return serveStatic(app.runtime.dir, req, res);
    return proxy(req, res, app.runtime.port);
  });
}

export function startRouter() {
  const server = createHubServer();
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.warn(`[hub] 端口 ${HUB_PORT} 已被占用（可能 dev-server 已在运行），本次演示直接复用现有中台。`);
    } else {
      throw e;
    }
  });
  // 监听地址：默认 0.0.0.0。
  // docker 运行时 Traefik 容器要通过 host.docker.internal 回访中台做 forwardAuth 鉴权，
  // 只绑 127.0.0.1 会让网关连不上（表现为应用全部 500）。对外暴露由防火墙控制，
  // 生产应在安全组/iptables 只放行 80/443。
  // 本机演示可用 HUB_BIND=127.0.0.1 收紧。
  const BIND = process.env.HUB_BIND || "0.0.0.0";
  server.listen(HUB_PORT, BIND, () => {
    console.log(`[hub] 中台门户已启动: ${HUB_ORIGIN}`);
    console.log(`[hub] 监听: ${BIND}:${HUB_PORT}（对外入口由 Traefik 统一收口）`);
    console.log(`[hub] 应用子域名格式: ${HUB_SCHEME}://<slug>.${HUB_DOMAIN}`);
    console.log(`[hub] MCP HTTP 接入: ${MCP_HTTP_URL}`);
  });
  return server;
}
