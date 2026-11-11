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
import { STATUS_META, probeAppStates, invalidateSnapshot } from "./reconcile.js";
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

/** 状态色调 → 圆点颜色（门户与 STATUS_META.tone 对应） */
const TONE_COLORS = {
  ok: "#3B6D11",
  warn: "#BA7517",
  bad: "#A32D2D",
  wait: "#854F0B",
  muted: "#888780",
};

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
调用 publish_app，agentToken = 刚才 connect 返回的 token。
中台部署在远程服务器，读不到我本机的目录：请把项目目录打包成 tar.gz 并转为 base64，作为 contentBase64 传入（tar -czf - -C <项目目录> . | base64，排除 node_modules 与 .git），不要传 projectPath。
应用名和权限范围（self 仅自己 / department 部门 / users 指定同事 / all 全员）先问我，不要擅自决定。`;

const SKILL_PROMPT = `请把我的 Skill 发布到企业 AI 中台：
调用 publish_skill，agentToken = 刚才 connect 返回的 token。
中台部署在远程服务器，读不到我本机的目录：请把 Skill 目录（含 SKILL.md）打包成 tar.gz 并转为 base64，作为 contentBase64 传入（tar -czf - -C <Skill目录> . | base64），不要传 projectPath。
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

/**
 * 门户渲染。
 *
 * 状态展示用**实时探测**的结果，而不是 store 里的快照——
 * 快照只在发布那一刻写，之后从不更新，会让已死的容器继续显示绿点「运行中」。
 * 实时探测走带 TTL 的缓存（见 reconcile.js），页面始终近实时且不拖慢渲染。
 *
 * @param {object} store
 * @param {object} user 当前登录用户
 * @param {string} csrf
 * @param {Map<string, {alive:boolean,status:string,detail?:string}>} [liveStates] appId → 实时状态
 */
function renderHubPage(store, user, csrf = "", liveStates = null) {
  const allApps = store.apps || [];
  // 归档记录不进入门户（数据仍留在 store 里可查，但不再对外展示）
  const apps = allApps.filter((a) => a.status !== "archived");
  const agents = store.agents || [];
  const running = apps.filter((a) => (liveStates?.get(a.id)?.status ?? a.status) === "running").length;
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
    // 实时状态优先；探测不到才退回记录里的快照
    const live = liveStates?.get(a.id);
    const status = live?.status ?? a.status;
    const meta = STATUS_META[status] || { label: status, tone: "wait" };
    const statusDot = TONE_COLORS[meta.tone] || "#854F0B";
    // 下架按钮：仅发布者可见（与后端 canManage 判定一致）
    const owner = user && canManage(a, user);
    // 异常态（已停止/失败）额外给一行原因，避免用户以为「加载慢」
    const abnormal = meta.tone === "bad" || meta.tone === "warn";
    const reason = abnormal && live?.detail ? `<div class="reason">${escapeHtml(live.detail)}</div>` : "";
    // 已停止的应用给出「重建」引导，而不是让用户点一个必然失败的链接
    const openBtn = status === "running"
      ? `<a class="open" href="${escapeHtml(a.url)}${tokenSuffix}" target="_blank">打开</a>`
      : `<span class="open disabled" title="应用当前未运行，链接不可用">不可用</span>`;
    return `
      <div class="card${abnormal ? " abnormal" : ""}">
        <img class="icon" src="/__hub__/icon/${encodeURIComponent(a.slug)}" alt="">
        <div class="body">
          <div class="title">${escapeHtml(a.name)}</div>
          <div class="meta"><span class="badge type">${escapeHtml(type)}</span><span class="badge vis">${escapeHtml(vis)}</span><span class="status"><span class="dot" style="background:${statusDot}"></span>${escapeHtml(meta.label)}</span></div>
          <div class="slug">${escapeHtml(a.url)}</div>
          <div class="owner">发布者：${escapeHtml(a.owner)} · ${escapeHtml(a.createdAt?.slice(0, 10) || "")}</div>
          ${reason}
        </div>
        <div class="actions">
          ${openBtn}
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
  :root{--brand:#0F6E56;--brand-d:#04342C;--brand-l:#E1F5EE;--brand-b:#9FE1CB;--bg:#F7F8F6;--surface:#FFFFFF;--line:#E6E8E3;--line2:#D3D1C7;--tx:#232622;--tx2:#5F6560;--tx3:#8C918B}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--tx);line-height:1.6;font-size:13px}
  a{text-decoration:none}
  .app{display:flex;min-height:100vh}
  .sidebar{width:212px;flex:none;background:var(--surface);border-right:1px solid var(--line);padding:20px 12px;display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;overflow-y:auto}
  .brand{display:flex;align-items:center;gap:10px;padding:0 8px 20px}
  .brand .logo{width:32px;height:32px;border-radius:9px;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:500;flex:none}
  .brand b{font-size:15px;font-weight:500;display:block;line-height:1.3}
  .brand small{font-size:11px;color:var(--tx3);display:block}
  .navgrp{font-size:11px;color:var(--tx3);padding:6px 10px 6px}
  .nav{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;font-size:13px;color:var(--tx2);cursor:pointer;margin-bottom:2px}
  .nav:hover{background:var(--bg)}
  .nav.on{background:var(--brand-l);color:var(--brand-d);font-weight:500}
  .nav .sq{width:15px;height:15px;border-radius:5px;border:1.5px solid var(--line2);flex:none}
  .nav.on .sq{background:var(--brand);border-color:var(--brand)}
  .nav .cnt{margin-left:auto;background:var(--brand);color:#fff;font-size:11px;min-width:18px;height:18px;border-radius:9px;display:none;align-items:center;justify-content:center;padding:0 5px}
  .sidefoot{margin-top:auto;border-top:1px solid var(--line);padding-top:14px}
  .ucard{display:flex;align-items:center;gap:10px;padding:6px 8px}
  .avatar{width:32px;height:32px;border-radius:50%;background:var(--brand-l);color:var(--brand-d);display:flex;align-items:center;justify-content:center;font-weight:500;font-size:13px;flex:none}
  .ucard .un{font-size:13px;font-weight:500;line-height:1.3}
  .ucard .ud{font-size:11px;color:var(--tx3)}
  .sidelinks{display:flex;gap:8px;padding:4px 8px 0;flex-wrap:wrap}
  .sidelinks a,.tokbtn{font-size:11px;color:var(--brand);cursor:pointer;background:none;border:none;padding:0}
  .devlogin{display:flex;flex-direction:column;gap:6px}
  .devlogin input{border:1px solid var(--line2);border-radius:8px;padding:6px 9px;font-size:12px;width:100%}
  .devlogin button{border:1px solid var(--brand);background:var(--brand);color:#fff;border-radius:8px;padding:6px;font-size:12px;cursor:pointer}
  .main{flex:1;min-width:0;display:flex;flex-direction:column}
  .topbar{height:60px;flex:none;background:var(--surface);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;padding:0 24px;position:sticky;top:0;z-index:10}
  .crumb{font-size:14px;font-weight:500;flex:none}
  .search{flex:1;max-width:330px;margin-left:10px;position:relative}
  .search input{width:100%;border:1px solid var(--line);background:var(--bg);border-radius:9px;padding:7px 12px 7px 30px;font-size:12px;outline:none;color:var(--tx)}
  .search input:focus{border-color:var(--brand-b);background:var(--surface)}
  .search::before{content:"";position:absolute;left:11px;top:11px;width:10px;height:10px;border:1.5px solid var(--tx3);border-radius:50%}
  .btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line2);background:var(--surface);color:var(--tx);border-radius:9px;padding:7px 13px;font-size:12px;cursor:pointer;white-space:nowrap}
  .btn:hover{border-color:var(--brand-b);color:var(--brand)}
  .btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}
  .btn.primary:hover{background:#0B5946;color:#fff}
  .content{padding:26px 28px 64px;max-width:1240px;width:100%}
  .panel{display:none}
  .panel.on{display:block}
  body.searching [data-panel]{display:block}
  .searchhint{display:none;background:var(--brand-l);color:var(--brand-d);border-radius:9px;padding:8px 14px;font-size:12px;margin-bottom:14px}
  .hd{margin-bottom:18px}
  .hd h1{font-size:20px;font-weight:500;letter-spacing:-.2px}
  .hd p{font-size:13px;color:var(--tx2);margin-top:4px}
  .sec{margin-top:26px}
  .sec-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .sec-h h2{font-size:14px;font-weight:500}
  .sec-h .more{font-size:12px;color:var(--brand);cursor:pointer}
  .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:18px}
  .stat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .stat b{font-size:24px;font-weight:500;display:block;line-height:1.3}
  .stat span{font-size:12px;color:var(--tx2)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:12px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;gap:12px;align-items:flex-start}
  .card:hover{border-color:var(--brand-b)}
  .card.abnormal{border-color:#F0CFCF}
  .reason{font-size:11px;color:#A32D2D;margin-top:6px;word-break:break-all}
  .icon{width:40px;height:40px;border-radius:10px;flex:none}
  .body{flex:1;min-width:0}
  .title{font-size:13px;font-weight:500;line-height:1.5}
  .meta{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap}
  .badge{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--bg);color:var(--tx2)}
  .badge.type{background:#EEF2F7;color:#185FA5}
  .badge.vis{background:var(--brand-l);color:var(--brand-d)}
  .badge.upd{background:#FAEEDA;color:#854F0B}
  .badge.cat{background:#EEEDFE;color:#534AB7}
  .status{font-size:11px;color:var(--tx2);display:inline-flex;align-items:center;gap:5px}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block}
  .slug{font-size:11px;color:var(--brand);font-family:ui-monospace,monospace;word-break:break-all}
  .owner{font-size:11px;color:var(--tx3);margin-top:2px}
  .version{font-size:11px;font-family:ui-monospace,monospace;background:var(--bg);color:var(--tx2);border-radius:6px;padding:1px 6px;margin-left:5px}
  .actions{display:flex;flex-direction:column;gap:6px;flex:none;align-items:stretch}
  .open{font-size:12px;color:var(--brand);border:1px solid var(--brand-b);background:var(--brand-l);padding:5px 12px;border-radius:8px;text-align:center;white-space:nowrap}
  .open:hover{background:var(--brand);color:#fff;border-color:var(--brand)}
  .open.disabled,.open.disabled:hover{opacity:.5;cursor:not-allowed;pointer-events:none;background:var(--bg);border-color:var(--line);color:var(--tx3)}
  form.del{margin:0}
  .del-btn{font-size:11px;color:#A32D2D;background:var(--surface);border:1px solid #F0CFCF;padding:4px 12px;border-radius:8px;cursor:pointer;white-space:nowrap}
  .del-btn:hover{background:#FDF0F0}
  .empty{background:var(--surface);border:1px dashed var(--line2);border-radius:12px;padding:30px;text-align:center;color:var(--tx3);font-size:13px}
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
  .fgroup{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px}
  .fgroup .lbl{font-size:11px;color:var(--tx3);min-width:38px}
  .chip{display:inline-block;font-size:12px;padding:4px 11px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--tx2);cursor:pointer}
  #typeChips,#visChips{display:inline-flex;gap:6px;flex-wrap:wrap}
  .chip.on{background:var(--brand);border-color:var(--brand);color:#fff}
  .upload{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
  .upload input[type="file"]{font-size:12px;flex:1 1 170px}
  .upload input[type="text"],.upload select{border:1px solid var(--line2);border-radius:8px;padding:6px 10px;font-size:12px;flex:1 1 130px;background:var(--surface);color:var(--tx)}
  .upload button{border:1px solid var(--brand);background:var(--brand);color:#fff;border-radius:8px;padding:6px 16px;font-size:12px;cursor:pointer}
  ul.recent,ul.agents{list-style:none;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:2px 14px}
  ul.recent li,ul.agents li{padding:10px 0;font-size:13px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--line);flex-wrap:wrap}
  ul.recent li:last-child,ul.agents li:last-child{border-bottom:none}
  ul.recent li a{color:var(--brand);font-weight:500}
  ul.recent li a:hover{text-decoration:underline}
  .muted{color:var(--tx3);font-size:12px}
  .token{font-family:ui-monospace,monospace;font-size:11px;color:var(--brand-d)}
  .prompt{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px}
  .prompt .ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px}
  .prompt h3{font-size:13px;font-weight:500}
  .prompt pre{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:12px;font-size:12px;font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;color:var(--tx2);line-height:1.7}
  .cp{font-size:11px;color:var(--brand);border:1px solid var(--brand-b);background:var(--brand-l);border-radius:7px;padding:4px 10px;cursor:pointer;white-space:nowrap}
  .note{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px;font-size:12px;color:var(--tx2);margin-top:16px}
  footer{margin-top:32px;font-size:11px;color:var(--tx3);border-top:1px solid var(--line);padding-top:14px;line-height:1.8}
  @media(max-width:900px){
    .app{flex-direction:column}
    .sidebar{width:100%;height:auto;position:static;flex-direction:row;align-items:center;gap:4px;padding:10px 12px;overflow-x:auto;border-right:none;border-bottom:1px solid var(--line)}
    .brand{padding:0 12px 0 0;flex:none}
    .brand small,.navgrp,.sidefoot{display:none}
    .nav{white-space:nowrap;margin:0;padding:7px 10px}
    .nav .sq{display:none}
    .topbar{padding:0 14px;height:54px}
    .crumb{display:none}
    .content{padding:18px 14px 44px}
    .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
    .grid{grid-template-columns:1fr}
  }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="logo">A</div><div><b>AI 中台</b><small>企业工作区</small></div></div>
    <div class="navgrp">工作区</div>
    <a class="nav on" data-nav="home" href="#/home"><span class="sq"></span>工作台</a>
    <a class="nav" data-nav="apps" href="#/apps"><span class="sq"></span>应用广场</a>
    <a class="nav" data-nav="skills" href="#/skills"><span class="sq"></span>Skill 库<span class="cnt" id="navSkillCnt"></span></a>
    <a class="nav" data-nav="library" href="#/library"><span class="sq"></span>资料库</a>
    <div class="navgrp">帮助</div>
    <a class="nav" data-nav="guide" href="#/guide"><span class="sq"></span>接入指引</a>
    <div class="sidefoot">
      ${user ? `<div class="ucard"><div class="avatar">${escapeHtml((user.name || "U").slice(0, 1))}</div><div><div class="un">${escapeHtml(user.name)}</div><div class="ud">${escapeHtml(user.provider)}${user.department ? " · " + escapeHtml(user.department) : ""}</div></div></div>
        <div class="sidelinks"><button class="tokbtn" id="tokbtn" data-token="${escapeHtml(user.token)}">复制完整令牌</button><a href="/__hub__/auth/logout">退出</a></div>`
      : provider.interactive ? `<a class="btn primary" href="/__hub__/auth/login" style="width:100%;justify-content:center">${escapeHtml(provider.label)}</a>`
      : `<form method="GET" action="/__hub__/auth/dev-login" class="devlogin"><input name="name" placeholder="你的姓名" required><input name="department" placeholder="部门（可选）"><button type="submit">登录</button></form>`}
    </div>
  </aside>
  <div class="main">
    <div class="topbar">
      <div class="crumb" id="crumb">工作台</div>
      <div class="search"><input id="q" type="search" placeholder="搜索应用、Skill、资料…" autocomplete="off"></div>
      <a class="btn primary" data-more="guide" href="#/guide">发布应用</a>
    </div>
    <div class="content">
      <div class="searchhint" id="searchhint"></div>

      <section class="panel on" data-panel="home">
        <div class="hd"><h1 id="greet">你好</h1><p>把 AI 应用交给中台，随时找到你要的。</p></div>
        <div class="stats">
          <div class="stat"><b>${visible.length}</b><span>可见应用</span></div>
          <div class="stat"><b>${running}</b><span>运行中</span></div>
          <div class="stat"><b>${allSkills.length}</b><span>收录 Skill</span></div>
          <div class="stat"><b>${agents.length}</b><span>已连接 Agent</span></div>
        </div>
        <div class="sec">
          <div class="sec-h"><h2>常用应用</h2><a class="more" data-more="apps" href="#/apps">查看全部</a></div>
          <div class="grid" id="homeApps"></div>
        </div>
        <div class="sec">
          <div class="sec-h"><h2>最近动态</h2></div>
          ${recentItems.length ? `<ul class="recent">${recentList}</ul>` : `<div class="empty">${user ? "打开应用或下载资料后，你的常用入口会显示在这里。" : "登录后展示你的常用入口。"}</div>`}
        </div>
        <div class="note" id="updNote"></div>
      </section>

      <section class="panel" data-panel="apps">
        <div class="hd"><h1>应用广场</h1><p>${hidden > 0 ? `另有 ${hidden} 个应用不在你的权限范围内` : "中台已收录的全部应用，按你的使用频次排序"}</p></div>
        <div class="filters"><div class="fgroup"><span class="lbl">类型</span><span id="typeChips"></span></div></div>
        <div class="filters"><div class="fgroup"><span class="lbl">可见范围</span><span id="visChips"></span></div></div>
        ${visible.length ? `<div class="grid">${cards}</div>` : loginHint || `<div class="empty">还没有可见的应用。去「接入指引」把第二段 Prompt 发给你的 Agent 试试。</div>`}
      </section>

      <section class="panel" data-panel="skills">
        <div class="hd"><h1>Skill 库</h1><p>${hiddenSkills > 0 ? `另有 ${hiddenSkills} 个 Skill 不在你的权限范围内` : "团队沉淀的能力包，可整包导出安装到本地 Agent"}</p></div>
        ${visibleSkills.length ? `<div class="grid">${skillCards}</div>` : `<div class="empty">${user ? "还没有可见的 Skill。去「接入指引」发布一个吧。" : "登录后查看权限范围内的 Skill。"}</div>`}
      </section>

      <section class="panel" data-panel="library">
        <div class="hd"><h1>资料库</h1><p>${hiddenLibrary > 0 ? `另有 ${hiddenLibrary} 份资料不在你的权限范围内` : "团队资料统一入口，上传后按权限共享"}</p></div>
        ${uploadForm}
        ${visibleLibrary.length ? `<div class="grid">${libraryCards}</div>` : `<div class="empty">${user ? "资料库还是空的。用上方表单上传，或把资料库 Prompt 发给 Agent 归档。" : "登录后查看权限范围内的资料。"}</div>`}
      </section>

      <section class="panel" data-panel="guide">
        <div class="hd"><h1>接入指引</h1><p>把下面两段 Prompt 发给你的 Agent，即可把本地项目发布到中台。</p></div>
        <div class="prompt"><div class="ph"><h3>第一段 · 连接中台</h3><button class="cp" onclick="cp('p1',this)">复制</button></div><pre id="p1">${escapeHtml(CONNECT_PROMPT)}</pre></div>
        <div class="prompt"><div class="ph"><h3>第二段 · 发布应用</h3><button class="cp" onclick="cp('p2',this)">复制</button></div><pre id="p2">${escapeHtml(PUBLISH_PROMPT)}</pre></div>
        <div class="prompt"><div class="ph"><h3>发布 / 检查 Skill</h3><button class="cp" onclick="cp('p3',this)">复制</button></div><pre id="p3">${escapeHtml(SKILL_PROMPT)}</pre></div>
        <div class="prompt"><div class="ph"><h3>归档资料到资料库</h3><button class="cp" onclick="cp('p4',this)">复制</button></div><pre id="p4">${escapeHtml(LIBRARY_PROMPT)}</pre></div>
        <div class="sec">
          <div class="sec-h"><h2>已连接的 Agent</h2></div>
          ${agents.length ? `<ul class="agents">${agentList}</ul>` : `<div class="empty">暂无 Agent 连接。发送第一段 Prompt 即可接入。</div>`}
        </div>
        <div class="note"><strong>远程发布提示：</strong>中台部署在服务器，读不到你本机的目录路径。发布 Skill / 应用时请让 Agent 把目录打包成 <code>contentBase64</code> 上传（<code>tar -czf - -C &lt;目录&gt; . | base64</code>），不要传 <code>projectPath</code>。</div>
        <footer>身份：${user ? `${escapeHtml(user.provider)} 登录` : "开发登录（生产为飞书 OAuth）"} · 运行时：本地进程 / Docker + Traefik 子域名路由 · 数据与 Context 存于 data/store.json。资料库混合架构：门户上传 + Agent 归档，飞书知识库索引待权限审批后接入。</footer>
      </section>
    </div>
  </div>
</div>
<script>
(function(){
  var NAV=[['home','工作台'],['apps','应用广场'],['skills','Skill 库'],['library','资料库'],['guide','接入指引']];
  function key(){var h=(location.hash||'').replace('#','').replace(/^\\//,'');for(var i=0;i<NAV.length;i++){if(NAV[i][0]===h)return h;}return 'home';}
  function show(k,sync){
    for(var i=0;i<NAV.length;i++){
      var nv=document.querySelector('[data-nav="'+NAV[i][0]+'"]'),pn=document.querySelector('[data-panel="'+NAV[i][0]+'"]');
      if(nv)nv.className='nav'+(NAV[i][0]===k?' on':'');
      if(pn)pn.className='panel'+(NAV[i][0]===k?' on':'');
    }
    var cr=document.getElementById('crumb');if(cr)cr.textContent=NAV.filter(function(x){return x[0]===k;})[0][1];
    if(sync!==false){try{history.replaceState(null,'','#/'+k);}catch(e){location.hash='#/'+k;}}
  }
  document.addEventListener('click',function(e){
    var n=e.target.closest?e.target.closest('[data-nav],[data-more]'):null;
    if(!n)return;
    e.preventDefault();show(n.getAttribute('data-nav')||n.getAttribute('data-more'));window.scrollTo(0,0);
  });
  window.addEventListener('hashchange',function(){show(key(),false);});
  show(key(),false);

  var home=document.getElementById('homeApps');
  if(home){var src=document.querySelectorAll('[data-panel="apps"] .card');for(var i=0;i<Math.min(3,src.length);i++){home.appendChild(src[i].cloneNode(true));}}

  var cards=document.querySelectorAll('.card'),types={},viss={};
  for(var j=0;j<cards.length;j++){
    var c=cards[j];c.setAttribute('data-search',(c.textContent||'').toLowerCase());
    var t=c.querySelector('.badge.type'),v=c.querySelector('.badge.vis');
    if(t){var tv=t.textContent.trim();types[tv]=1;c.setAttribute('data-type',tv);}
    if(v){var vv=v.textContent.trim();viss[vv]=1;c.setAttribute('data-vis',vv);}
  }
  function addChips(box,vals,g){
    if(!box)return;
    var a=document.createElement('span');a.className='chip on';a.textContent='全部';a.setAttribute('data-filter',g);a.setAttribute('data-val','');box.appendChild(a);
    Object.keys(vals).forEach(function(v){var s=document.createElement('span');s.className='chip';s.textContent=v;s.setAttribute('data-filter',g);s.setAttribute('data-val',v);box.appendChild(s);});
  }
  addChips(document.getElementById('typeChips'),types,'type');
  addChips(document.getElementById('visChips'),viss,'vis');

  var ftype='',fvis='';
  document.addEventListener('click',function(e){
    var ch=e.target.closest?e.target.closest('[data-filter]'):null;if(!ch)return;
    var g=ch.getAttribute('data-filter'),val=ch.getAttribute('data-val')||'',sibs=document.querySelectorAll('[data-filter="'+g+'"]');
    for(var i=0;i<sibs.length;i++)sibs[i].className='chip';
    ch.className='chip on';if(g==='type')ftype=val;else fvis=val;applyFilters();
  });
  function applyFilters(){
    var cs=document.querySelectorAll('[data-panel="apps"] .card');
    for(var i=0;i<cs.length;i++){var c=cs[i],okT=!ftype||c.getAttribute('data-type')===ftype,okV=!fvis||c.getAttribute('data-vis')===fvis;c.style.display=(okT&&okV)?'':'none';}
  }
  var si=document.getElementById('q');
  if(si)si.addEventListener('input',function(){
    var q=(si.value||'').trim().toLowerCase();
    document.body.className=q?'searching':'';
    for(var j=0;j<cards.length;j++){cards[j].style.display=(!q||(cards[j].getAttribute('data-search')||'').indexOf(q)>=0)?'':'none';}
    var hint=document.getElementById('searchhint');
    if(hint){hint.style.display=q?'block':'none';hint.textContent=q?('搜索「'+si.value+'」· 在全部模块中查找，清空后返回当前页'):'';}
    if(!q)applyFilters();
  });

  var upd=document.querySelectorAll('[data-panel="skills"] .badge.upd').length;
  var nc=document.getElementById('navSkillCnt');if(nc&&upd){nc.textContent=upd;nc.style.display='flex';}
  var un=document.getElementById('updNote');
  if(un)un.textContent=upd?('有 '+upd+' 个 Skill 发布了新版本，去 Skill 库导出最新整包。'):'当前没有待更新的 Skill，所有能力包都是最新版本。';
  var h=new Date().getHours(),g=document.getElementById('greet');
  if(g)g.textContent=(h<11?'上午好':h<18?'下午好':'晚上好')+${JSON.stringify(user ? "，" + user.name : "").replace(/</g, "\\u003c")};

  var tb=document.getElementById('tokbtn');
  if(tb)tb.addEventListener('click',function(){
    var t=tb.getAttribute('data-token')||'';
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){flash(tb);},function(){flash(tb);});}
    else flash(tb);
  });
  function flash(b){var o=b.textContent;b.textContent='已复制';setTimeout(function(){b.textContent=o;},1500);}

  window.cp=function(id,btn){
    var el=document.getElementById(id);if(!el)return;var t=el.textContent;
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){flash(btn);},function(){legacy(t,btn);});}
    else legacy(t,btn);
  };
  function legacy(t,btn){var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);flash(btn);}
})();
</script>
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
    // 归档记录不对外提供服务，不应出现在可见列表里
    visibleApps: store.apps.filter((a) => a.status !== "archived" && canView(a, user)).map((a) => a.id),
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
  // 归档记录不对外提供服务：即使网关还有残留路由也不放行
  const app = slug ? getStore().apps.find((a) => a.slug === slug && a.status !== "archived") : null;
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
  invalidateSnapshot(); // 下线后实时状态缓存立即失效，避免门户仍显示旧卡片
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
      // 门户状态用实时探测结果渲染（带 TTL 缓存），避免展示发布时的过期快照
      const store = getStore();
      const liveStates = await probeAppStates(store.apps || [], getDeployer().executor);
      return send(res, 200, renderHubPage(store, user, csrf, liveStates));
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
    // 归档记录不再提供服务；已停止（stopped）的记录同样不应再被路由到
    const storeApps = getStore().apps || [];
    const app = slug
      ? storeApps.find((a) => a.slug === slug && a.status === "running" && a.status !== "archived")
      : null;
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
