import crypto from "node:crypto";
import { load, save, nextId } from "./store.js";

/**
 * 身份层（可插拔）。
 *
 * Provider 接口约定：
 *   {
 *     id: "dev" | "feishu" | ...,
 *     label: string,                 // 门户登录按钮文案
 *     interactive: boolean,          // true=需要跳转外部授权（飞书）；false=本地表单（dev）
 *     loginUrl(next, state): string, // 发起登录的地址
 *     exchange(code, state): Promise<{providerId, name, department, avatarUrl}>,
 *   }
 *
 * 生产环境把 HUB_IDENTITY_PROVIDER 设为 feishu 并配置应用即可，其余代码零改动。
 */

export const SESSION_COOKIE = "ah_session";
const STATE_TTL_MS = 10 * 60 * 1000;

const oauthStates = new Map(); // state -> { next, expiresAt }

/* app_access_token 缓存（飞书有效期约 2 小时，避免每次登录都换） */
let appTokenCache = { token: "", tenantKey: "", expiresAt: 0 };

async function fetchAppAccessToken() {
  if (appTokenCache.token && appTokenCache.expiresAt > Date.now()) return appTokenCache;
  const { appId, appSecret } = identityConfig().feishu;
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (!data.app_access_token) throw new Error(`获取 app_access_token 失败: ${data.msg || res.status}`);
  appTokenCache = {
    token: data.app_access_token,
    tenantKey: data.tenant_key || "",
    expiresAt: Date.now() + (data.expire || 7200) * 1000 - 60 * 1000, // 提前 1 分钟过期
  };
  return appTokenCache;
}

/** 部门 ID → 部门名（权限模型按部门名匹配，best-effort，失败返回空串） */
async function fetchDepartmentName(appToken, departmentId) {
  try {
    const res = await fetch(
      `https://open.feishu.cn/open-apis/contact/v3/departments/${encodeURIComponent(departmentId)}?department_id_type=department_id`,
      { headers: { Authorization: `Bearer ${appToken}` } },
    );
    const data = await res.json();
    if (data.code === 0 && data.data?.department?.name) return data.data.department.name;
  } catch {
    /* best-effort */
  }
  return "";
}

export function identityConfig() {
  return {
    provider: (process.env.HUB_IDENTITY_PROVIDER || "dev").toLowerCase(),
    feishu: {
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      redirectUri: process.env.FEISHU_REDIRECT_URI || "",
    },
  };
}

/* ---------------- 用户 ---------------- */

export function upsertUser({ provider, providerId, name, department = "", avatarUrl = "" }) {
  const store = load();
  let user = store.users.find(
    (u) => u.provider === provider && (u.providerId === providerId || u.name === name),
  );
  if (!user) {
    user = {
      id: nextId(store, "user"),
      provider,
      providerId,
      name,
      department,
      avatarUrl,
      token: "ah_user_" + crypto.randomBytes(24).toString("base64url"),
      createdAt: new Date().toISOString(),
    };
    store.users.push(user);
  } else {
    if (department) user.department = department;
    if (avatarUrl) user.avatarUrl = avatarUrl;
    if (!user.token) user.token = "ah_user_" + crypto.randomBytes(24).toString("base64url");
  }
  save(store);
  return user;
}

export function findUserByToken(token) {
  if (!token) return null;
  return load().users.find((u) => u.token === token) || null;
}

/* ---------------- 会话 ---------------- */

export function createSession(userId) {
  const store = load();
  const session = {
    id: "ah_s_" + crypto.randomBytes(18).toString("base64url"),
    userId,
    // CSRF 令牌：破坏性操作（下架/删除）表单携带，浏览器自动带 Cookie 的场景必须校验
    csrf: crypto.randomBytes(16).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
  store.sessions.push(session);
  save(store);
  return session;
}

/**
 * 取当前 Cookie 会话（存量 session 惰性补 csrf 字段）。
 * 注意：Bearer / ?ah_token= 认证不经过会话，此时返回 null——
 * 那两类是「显式携带凭据」，天然免疫 CSRF，服务端不再要求 csrf 令牌。
 */
export function sessionInfo(req) {
  const cookieToken = parseCookies(req)[SESSION_COOKIE];
  if (!cookieToken) return null;
  const store = load();
  const session = store.sessions.find((s) => s.id === cookieToken);
  if (!session) return null;
  if (!session.csrf) {
    session.csrf = crypto.randomBytes(16).toString("base64url");
    save(store);
  }
  return session;
}

export function destroySession(sessionId) {
  const store = load();
  store.sessions = store.sessions.filter((s) => s.id !== sessionId);
  save(store);
}

export function userFromSession(sessionId) {
  if (!sessionId) return null;
  const store = load();
  const session = store.sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  return store.users.find((u) => u.id === session.userId) || null;
}

/* ---------------- 请求身份解析 ----------------
 * 支持三种载体：Cookie（浏览器）、Authorization: Bearer（Agent/API）、?ah_token= 查询参数（localhost 下 cookie 不通透子域名时的兜底）。
 * Bearer 既接受用户 token，也接受 Agent token（解析到其绑定用户）。 */

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function currentUser(req) {
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const url = new URL(req.url, "http://localhost");
  const queryToken = url.searchParams.get("ah_token") || "";
  const cookieToken = parseCookies(req)[SESSION_COOKIE];

  if (bearer) {
    const user = findUserByToken(bearer);
    if (user) return user;
    const agent = load().agents.find((a) => a.token === bearer);
    if (agent?.userId) return load().users.find((u) => u.id === agent.userId) || null;
  }
  if (queryToken) {
    const user = findUserByToken(queryToken);
    if (user) return user;
  }
  return userFromSession(cookieToken);
}

export function sessionCookie(userId, req) {
  const session = createSession(userId);
  const attrs = [`${SESSION_COOKIE}=${session.id}`, "HttpOnly", "Path=/", "SameSite=Lax"];
  const domain = process.env.HUB_COOKIE_DOMAIN;
  if (domain) attrs.push(`Domain=${domain}`);
  const secure = (req.headers["x-forwarded-proto"] || "") === "https";
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/* ---------------- 权限判定 ---------------- */

/**
 * 判断用户是否有权访问应用。
 * 规则：all=任何登录用户；self=仅发布者；department=同部门；users=在白名单内。
 * 兼容旧数据（无 ownerId 时按发布者姓名匹配）。
 */
export function canView(app, user) {
  if (!app || !user) return false;
  const isOwner = app.ownerId ? app.ownerId === user.id : app.owner === user.name;
  if (isOwner) return true;
  switch (app.visibility) {
    case "all":
      return true;
    case "department":
      return Boolean(user.department) && user.department === app.extra?.department;
    case "users":
      return (app.extra?.users || []).includes(user.name) || (app.extra?.users || []).includes(user.id);
    case "self":
    default:
      return false;
  }
}

export function canManage(app, user) {
  if (!app || !user) return false;
  return app.ownerId ? app.ownerId === user.id : app.owner === user.name;
}

/* ---------------- Provider: dev ---------------- */

const devProvider = {
  id: "dev",
  label: "开发登录（无需真实 OAuth）",
  interactive: false,
};

/* ---------------- Provider: 飞书 OAuth ---------------- */

const feishuProvider = {
  id: "feishu",
  label: "飞书登录",
  interactive: true,

  loginUrl(next) {
    const { appId, redirectUri } = identityConfig().feishu;
    if (!appId || !redirectUri) {
      throw new Error("飞书 OAuth 未配置：请设置 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_REDIRECT_URI");
    }
    const state = crypto.randomBytes(16).toString("hex");
    oauthStates.set(state, { next: next || "/", expiresAt: Date.now() + STATE_TTL_MS });
    const uri = encodeURIComponent(redirectUri);
    return `https://open.feishu.cn/open-apis/authen/v1/index?redirect_uri=${uri}&app_id=${encodeURIComponent(appId)}&state=${state}`;
  },

  takeState(state) {
    const entry = oauthStates.get(state);
    if (!entry) return null;
    oauthStates.delete(state);
    if (entry.expiresAt < Date.now()) return null;
    return entry;
  },

  async _appAccessToken() {
    const { token, tenantKey } = await fetchAppAccessToken();
    return { token, tenantKey };
  },

  async exchange(code) {
    const { token: appToken } = await feishuProvider._appAccessToken();
    const res = await fetch("https://open.feishu.cn/open-apis/authen/v1/oidc/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${appToken}` },
      body: JSON.stringify({ grant_type: "authorization_code", code }),
    });
    const data = await res.json();
    // 飞书响应结构：成功 {"code":0,"data":{"access_token":"u-...",...}}；失败 code 非 0、描述在 message（旧接口用 msg）
    // 注意 token 嵌在 data 下，不是顶层；错误描述字段是 message 不是 error（曾因这两点解析错误报「失败: 200」）
    const tokenInfo = data.data || data;
    if (data.code !== 0 || !tokenInfo?.access_token) {
      const reason = data.message || data.msg || tokenInfo?.message || `HTTP ${res.status}`;
      throw new Error(`飞书授权码换 token 失败: code=${data.code ?? "?"} ${reason}`);
    }
    const accessToken = tokenInfo.access_token;
    const infoRes = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const info = await infoRes.json();
    if (info.code !== 0 && !info.data) throw new Error(`获取飞书用户信息失败: ${info.msg || infoRes.status}`);
    const u = info.data || info;
    let department = "";
    try {
      const deptRes = await fetch(
        `https://open.feishu.cn/open-apis/contact/v3/users/${u.open_id}?user_id_type=open_id&department_id_type=department_id`,
        { headers: { Authorization: `Bearer ${appToken}` } },
      );
      const dept = await deptRes.json();
      if (dept.code === 0 && dept.data?.user?.department_ids?.length) {
        // 权限模型按「部门名」匹配（与发布时用户声明的部门名对应），必须把 ID 解析为名称；
        // 取主部门（列表第一个）。解析失败留空，避免把不可读的 ID 存进权限字段。
        department = await fetchDepartmentName(appToken, dept.data.user.department_ids[0]);
      }
    } catch {
      /* 部门信息 best-effort，失败不影响登录 */
    }
    return {
      providerId: u.open_id || u.union_id || u.user_id,
      name: u.name || u.en_name || "飞书用户",
      department,
      avatarUrl: u.avatar_url || "",
    };
  },
};

export function getProvider() {
  return identityConfig().provider === "feishu" ? feishuProvider : devProvider;
}
