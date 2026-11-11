import path from "node:path";
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { load, save, nextId } from "./store.js";
import { Deployer } from "./deployer.js";
import { SkillManager, compareVersions } from "./skills.js";
import { LibraryManager, categoryLabel, MAX_LIBRARY_SIZE } from "./library.js";
import { createExecutor } from "./executors/index.js";
import { randomToken, nowIso } from "./util.js";
import { findUserByToken, canManage, canView } from "./identity.js";
import { HUB_PORT, HUB_DOMAIN, VISIBILITY_LABELS } from "./config.js";

/* 共享单例：HTTP 传输每次请求都会新建 Server 实例，
 * 但执行器（进程表）与存储必须跨实例共享，否则跨进程 stop/revive 会失效。 */
let sharedDeployer = null;
let sharedSkills = null;
let sharedLibrary = null;
export function getDeployer() {
  if (!sharedDeployer) sharedDeployer = new Deployer({ executor: createExecutor() });
  return sharedDeployer;
}
export function getSkills() {
  if (!sharedSkills) sharedSkills = new SkillManager();
  return sharedSkills;
}
export function getLibrary() {
  if (!sharedLibrary) sharedLibrary = new LibraryManager();
  return sharedLibrary;
}

const MCP_HTTP_URL = `http://${HUB_DOMAIN}:${HUB_PORT}/mcp`;

const TOOLS = [
  {
    name: "connect",
    description:
      "连接企业 AI 中台（注册当前 Agent 并获取访问令牌）。发布应用前必须先调用本工具。userToken 为中台用户的访问令牌（网页端登录后获得，用于把发布行为绑定到具体身份）；未提供时开发模式下使用默认开发用户。",
    inputSchema: {
      type: "object",
      properties: {
        agentName: { type: "string", description: "Agent 名称，例如 Claude / Codex / WorkBuddy" },
        userToken: { type: "string", description: "中台用户令牌（网页登录后获得）。生产环境必填，权限随之绑定" },
      },
      required: ["agentName"],
    },
  },
  {
    name: "whoami",
    description: "查看当前 Agent 令牌绑定的身份（用户、部门）与可见范围。",
    inputSchema: {
      type: "object",
      properties: { agentToken: { type: "string", description: "connect 返回的访问令牌" } },
      required: ["agentToken"],
    },
  },
  {
    name: "publish_app",
    description:
      "把一个 VibeCoding 项目部署到企业 AI 中台。自动完成：识别项目类型（静态 / Node / Python / Dockerfile）→ 依赖锁审查 → 在服务器隔离环境构建运行 → 自动分配子域名 → 绑定发布者账号与权限。规则：1) 用户未提供 appName 时，先阅读项目内容建议一个名称并询问用户确认，不要擅自使用文件夹名；2) 用户未提供 visibility 时，必须先询问用户希望的权限范围，禁止擅自默认；3) 部署成功后把返回的 url 告知用户。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "VibeCoding 项目的绝对路径" },
        appName: { type: "string", description: "应用名称（可选）。未提供时 Agent 应先建议并询问用户" },
        visibility: {
          type: "string",
          enum: ["self", "department", "users", "all"],
          description: "权限范围：self=仅自己 / department=部门可见 / users=指定同事 / all=全员。未提供必须先询问用户",
        },
        department: { type: "string", description: "visibility=department 时的部门名" },
        users: { type: "array", items: { type: "string" }, description: "visibility=users 时的同事账号列表" },
        agentToken: { type: "string", description: "connect 返回的访问令牌" },
      },
      required: ["projectPath", "agentToken"],
    },
  },
  {
    name: "list_apps",
    description: "列出中台上当前身份可见的应用（名称、子域名、类型、权限范围、状态）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_app",
    description: "查看单个应用的详细信息与访问地址。",
    inputSchema: {
      type: "object",
      properties: { appId: { type: "string", description: "应用 ID，如 app_0001" } },
      required: ["appId"],
    },
  },
  {
    name: "set_app_permission",
    description: "修改已发布应用的权限范围（发布后随时可改，仅发布者可操作）。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", description: "应用 ID" },
        visibility: { type: "string", enum: ["self", "department", "users", "all"], description: "新的权限范围" },
        department: { type: "string", description: "visibility=department 时的部门名" },
        users: { type: "array", items: { type: "string" }, description: "visibility=users 时的同事账号列表" },
      },
      required: ["appId", "visibility"],
    },
  },
  {
    name: "unpublish_app",
    description: "下线并删除一个已发布的应用（停止运行并清理文件，仅发布者可操作）。",
    inputSchema: {
      type: "object",
      properties: { appId: { type: "string", description: "应用 ID" } },
      required: ["appId"],
    },
  },
  {
    name: "publish_skill",
    description:
      "把一个 Skill 发布到企业 AI 中台（Skill = 含 SKILL.md 的目录，frontmatter 需有 name/description/version）。同一发布者的同名 Skill 再次发布即版本更新，版本号必须递增（省略 version 自动递增补丁号），旧版本自动归档。用户未提供 visibility 时必须先询问权限范围。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Skill 目录的绝对路径（含 SKILL.md）" },
        skillName: { type: "string", description: "Skill 名称（可选，默认取 SKILL.md frontmatter 的 name）" },
        version: { type: "string", description: "版本号（可选，默认取 frontmatter version；重复发布时必须高于平台当前版本）" },
        visibility: {
          type: "string",
          enum: ["self", "department", "users", "all"],
          description: "权限范围：self=仅自己 / department=部门可见 / users=指定同事 / all=全员。未提供必须先询问用户",
        },
        department: { type: "string", description: "visibility=department 时的部门名" },
        users: { type: "array", items: { type: "string" }, description: "visibility=users 时的同事账号列表" },
        agentToken: { type: "string", description: "connect 返回的访问令牌" },
      },
      required: ["projectPath", "agentToken"],
    },
  },
  {
    name: "list_skills",
    description: "列出中台上当前身份可见的 Skill（名称、版本、权限范围、更新时间）。",
    inputSchema: {
      type: "object",
      properties: { agentToken: { type: "string", description: "connect 返回的访问令牌" } },
      required: ["agentToken"],
    },
  },
  {
    name: "get_skill",
    description: "查看单个 Skill 的详情：版本历史、文件清单与 SKILL.md 全文（越权即拒）。",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Skill ID，如 skill_0001" },
        agentToken: { type: "string", description: "connect 返回的访问令牌" },
      },
      required: ["skillId", "agentToken"],
    },
  },
  {
    name: "check_skill_version",
    description:
      "检查本地 Skill 目录与平台收录版本的差异。平台版本较新时提醒用户更新（对应中台的 Skill 更新提醒场景）；本地较新时可发布。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "本地 Skill 目录的绝对路径（含 SKILL.md）" },
        agentToken: { type: "string", description: "connect 返回的访问令牌" },
      },
      required: ["projectPath", "agentToken"],
    },
  },
  {
    name: "set_skill_permission",
    description: "修改已发布 Skill 的权限范围（发布后随时可改，仅发布者可操作）。",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Skill ID" },
        visibility: { type: "string", enum: ["self", "department", "users", "all"], description: "新的权限范围" },
        department: { type: "string", description: "visibility=department 时的部门名" },
        users: { type: "array", items: { type: "string" }, description: "visibility=users 时的同事账号列表" },
        agentToken: { type: "string", description: "connect 返回的访问令牌" },
      },
      required: ["skillId", "visibility", "agentToken"],
    },
  },
  {
    name: "export_skill",
    description:
      "导出一个 Skill 的完整整包（tar.gz，含 SKILL.md 与全部附属文件），用于把中台上的 Skill 安装到本地 Agent。小包直接返回 base64 内容（解压即用），大包返回带令牌的下载链接。发布新版后，其他用户可通过本工具获取最新整包。",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Skill ID，如 skill_0001" },
        agentToken: { type: "string", description: "connect 返回的访问令牌" },
      },
      required: ["skillId", "agentToken"],
    },
  },
  {
    name: "unpublish_skill",
    description: "下线并删除一个已发布的 Skill（仅发布者可操作）。",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "Skill ID" },
        agentToken: { type: "string", description: "connect 返回的访问令牌" },
      },
      required: ["skillId", "agentToken"],
    },
  },
  {
    name: "publish_library",
    description:
      "把一份资料归档到企业 AI 中台资料库（中台的统一资料入口，同事可在门户发现与下载）。两种取文件方式：sourcePath 传服务器上的绝对路径，或 contentBase64 直接传文件内容（≤10MB 建议）。用户未提供 visibility 时，必须先询问权限范围（self 仅自己 / department 部门 / users 指定同事 / all 全员），禁止擅自默认。",
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: { type: "string", description: "服务器上文件的绝对路径（与 contentBase64 二选一）" },
        contentBase64: { type: "string", description: "文件内容的 base64 编码（与 sourcePath 二选一）" },
        fileName: { type: "string", description: "文件名（含扩展名）。sourcePath 模式下默认取路径文件名；contentBase64 模式必填" },
        name: { type: "string", description: "资料显示名称（可选，默认取文件名）" },
        visibility: {
          type: "string",
          enum: ["self", "department", "users", "all"],
          description: "权限范围：self=仅自己 / department=部门可见 / users=指定同事 / all=全员。未提供必须先询问用户",
        },
        department: { type: "string", description: "visibility=department 时的部门名" },
        users: { type: "array", items: { type: "string" }, description: "visibility=users 时的同事账号列表" },
        agentToken: { type: "string", description: "connect 返回的访问令牌" },
      },
    },
  },
  {
    name: "list_library",
    description: "列出中台资料库中当前身份可见的资料（名称、分类、大小、权限范围、下载次数）。",
    inputSchema: {
      type: "object",
      properties: { agentToken: { type: "string", description: "connect 返回的访问令牌" } },
      required: ["agentToken"],
    },
  },
  {
    name: "set_library_permission",
    description: "修改已归档资料的权限范围（发布后随时可改，仅发布者可操作）。",
    inputSchema: {
      type: "object",
      properties: {
        libId: { type: "string", description: "资料 ID，如 lib_0001" },
        visibility: { type: "string", enum: ["self", "department", "users", "all"], description: "新的权限范围" },
        department: { type: "string", description: "visibility=department 时的部门名" },
        users: { type: "array", items: { type: "string" }, description: "visibility=users 时的同事账号列表" },
        agentToken: { type: "string", description: "connect 返回的访问令牌" },
      },
      required: ["libId", "visibility", "agentToken"],
    },
  },
  {
    name: "unpublish_library",
    description: "删除一份已归档的资料（清理文件，仅发布者可操作）。",
    inputSchema: {
      type: "object",
      properties: {
        libId: { type: "string", description: "资料 ID" },
        agentToken: { type: "string", description: "connect 返回的访问令牌" },
      },
      required: ["libId", "agentToken"],
    },
  },
];

function ok(payload) {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

function fail(message) {
  return { content: [{ type: "text", text: `错误：${message}` }], isError: true };
}

function authAgent(token) {
  const store = load();
  const agent = store.agents.find((a) => a.token === token);
  if (!agent) {
    throw new Error("尚未连接中台：请先调用 connect 工具获取 token（生产环境对应飞书 OAuth 登录）。");
  }
  return agent;
}

function agentUser(agent) {
  if (!agent?.userId) return null;
  return load().users.find((u) => u.id === agent.userId) || null;
}

/** 开发模式下没有真实登录时使用的默认用户，保证单人试用流程不断。 */
function ensureDevUser() {
  const store = load();
  let user = store.users.find((u) => u.provider === "dev" && u.name === "开发用户");
  if (!user) {
    user = {
      id: nextId(store, "user"),
      provider: "dev",
      providerId: "dev-default",
      name: "开发用户",
      department: "",
      avatarUrl: "",
      token: "ah_user_" + randomToken().slice(3),
      createdAt: nowIso(),
    };
    store.users.push(user);
    save(store);
  }
  return user;
}

async function handleTool(name, args) {
  switch (name) {
    case "connect": {
      const store = load();
      const agentName = String(args.agentName || "").trim() || "unnamed-agent";
      let user = args.userToken ? findUserByToken(args.userToken) : null;
      if (args.userToken && !user) {
        throw new Error("userToken 无效或已失效，请先在门户页面登录获取新的用户令牌。");
      }
      if (!user) user = ensureDevUser();

      let agent = store.agents.find((a) => a.name === agentName);
      if (!agent) {
        agent = { id: nextId(store, "agent"), name: agentName, token: randomToken(), userId: user.id, createdAt: nowIso() };
        store.agents.push(agent);
      } else {
        agent.userId = user.id; // 重新连接时更新绑定身份
      }
      save(store);
      const pending = getSkills().pendingUpdates(user);
      return ok({
        连接成功: true,
        agentId: agent.id,
        name: agent.name,
        token: agent.token,
        绑定用户: { id: user.id, name: user.name, department: user.department || "（未设置）" },
        中台门户: `http://${HUB_DOMAIN}:${HUB_PORT}`,
        MCP接入地址: MCP_HTTP_URL,
        待更新Skill: pending.length ? pending : "（无待更新 Skill）",
        下一步: pending.length
          ? `检测到 ${pending.length} 个 Skill 平台有新版，已列在「待更新Skill」。调用 export_skill 导出最新整包后提醒用户更新。随后可调用 publish_app 发布应用；发布时若用户未指定权限范围，必须先询问用户（self/department/users/all），不要擅自默认。`
          : "调用 publish_app 发布应用。发布时若用户未指定权限范围，必须先询问用户（self/department/users/all），不要擅自默认。",
      });
    }

    case "whoami": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent);
      return ok({
        agent: { id: agent.id, name: agent.name },
        user: user ? { id: user.id, name: user.name, department: user.department || "（未设置）", provider: user.provider } : null,
        提示: user ? null : "当前 Agent 未绑定用户（开发模式默认用户），发布的应用将归属默认用户。",
      });
    }

    case "publish_app": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const app = await getDeployer().publish({
        projectPath: args.projectPath,
        appName: args.appName,
        visibility: args.visibility || "self",
        user,
        extra: { department: args.department, users: args.users },
      });
      const deps = app.deps || {};
      return ok({
        发布成功: true,
        appId: app.id,
        名称: app.name,
        类型: app.type,
        子域名: app.url,
        发布者: `${user.name}（${user.id}）`,
        权限范围: `${app.visibility}（${VISIBILITY_LABELS[app.visibility] || app.visibility}）`,
        依赖审查: deps.lockFile
          ? `已发现锁文件（${deps.lockFile}）`
          : `未发现依赖锁文件，已按清单直接安装（${(deps.warnings || []).join("；") || "无其他风险"}）`,
        提示:
          app.visibility === "self"
            ? "当前仅自己可见。如需全员/部门/指定同事可见，调用 set_app_permission 修改。"
            : "可随时调用 set_app_permission 调整权限范围。",
      });
    }

    case "list_apps": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const apps = getDeployer().list().filter((a) => canView(a, user));
      if (!apps.length) return ok("当前身份下没有可见的应用。");
      return ok(
        apps.map((a) => ({
          appId: a.id,
          名称: a.name,
          类型: a.type,
          子域名: a.url,
          权限: a.visibility,
          状态: a.status,
          发布者: a.owner,
          我是发布者: canManage(a, user),
        })),
      );
    }

    case "get_app": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const app = getDeployer().get(args.appId);
      if (!app) throw new Error(`应用不存在: ${args.appId}`);
      if (!canView(app, user)) throw new Error("无权查看该应用（不在权限范围内）。");
      return ok(app);
    }

    case "set_app_permission": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const app = getDeployer().get(args.appId);
      if (!app) throw new Error(`应用不存在: ${args.appId}`);
      if (!canManage(app, user)) throw new Error("只有发布者可以修改该应用的权限。");
      const updated = getDeployer().setPermission(args.appId, {
        visibility: args.visibility,
        department: args.department,
        users: args.users,
      });
      return ok({ 已更新: true, appId: updated.id, 权限范围: `${updated.visibility}（${VISIBILITY_LABELS[updated.visibility] || updated.visibility}）` });
    }

    case "unpublish_app": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const app = getDeployer().get(args.appId);
      if (!app) throw new Error(`应用不存在: ${args.appId}`);
      if (!canManage(app, user)) throw new Error("只有发布者可以下线该应用。");
      return ok(await getDeployer().unpublish(args.appId));
    }

    case "publish_skill": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const skill = getSkills().publish({
        projectPath: args.projectPath,
        user,
        skillName: args.skillName,
        version: args.version,
        visibility: args.visibility,
        extra: { department: args.department, users: args.users },
      });
      return ok({
        发布成功: true,
        skillId: skill.id,
        名称: skill.name,
        版本: skill.version,
        文件数: skill.files.length,
        发布者: `${user.name}（${user.id}）`,
        权限范围: `${skill.visibility}（${VISIBILITY_LABELS[skill.visibility] || skill.visibility}）`,
        历史版本: skill.history.map((h) => h.version),
        提示: "其他同事可调用 list_skills 发现；本地旧版本用户调用 check_skill_version 会收到更新提醒。",
      });
    }

    case "list_skills": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const skills = getSkills().list(user);
      if (!skills.length) return ok("当前身份下没有可见的 Skill。");
      return ok(
        skills.map((s) => {
          const local = getSkills().installedVersion(s.id, user);
          return {
            skillId: s.id,
            名称: s.name,
            版本: s.version,
            描述: s.description || "（无）",
            权限: s.visibility,
            发布者: s.owner,
            更新时间: s.updatedAt,
            我是发布者: canManage(s, user),
            本地已装版本: local,
            有更新: local ? compareVersions(s.version, local) > 0 : false,
          };
        }),
      );
    }

    case "get_skill": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const skill = getSkills().get(args.skillId, user);
      const fs = await import("node:fs");
      const skillMd = fs.existsSync(skill.sourceDir)
        ? fs.readFileSync(`${skill.sourceDir}/SKILL.md`, "utf8")
        : "（SKILL.md 缺失）";
      return ok({
        skillId: skill.id,
        名称: skill.name,
        版本: skill.version,
        描述: skill.description,
        权限范围: `${skill.visibility}（${VISIBILITY_LABELS[skill.visibility] || skill.visibility}）`,
        发布者: skill.owner,
        创建时间: skill.createdAt,
        更新时间: skill.updatedAt,
        历史版本: skill.history,
        文件清单: skill.files,
        SKILL_MD全文: skillMd,
      });
    }

    case "check_skill_version": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const result = getSkills().checkVersion({ projectPath: args.projectPath, user });
      return ok({
        Skill: result.skill,
        本地版本: result.localVersion,
        平台版本: result.platformVersion,
        状态: result.status,
        结论: result.message,
      });
    }

    case "set_skill_permission": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const skill = getSkills().get(args.skillId, user);
      if (!canManage(skill, user)) throw new Error("只有发布者可以修改该 Skill 的权限。");
      const updated = getSkills().setPermission(args.skillId, {
        visibility: args.visibility,
        department: args.department,
        users: args.users,
      });
      return ok({ 已更新: true, skillId: updated.id, 权限范围: `${updated.visibility}（${VISIBILITY_LABELS[updated.visibility] || updated.visibility}）` });
    }

    case "export_skill": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const packed = await getSkills().pack(args.skillId, user);
      const downloadUrl = `http://${HUB_DOMAIN}:${HUB_PORT}/__hub__/skills/${encodeURIComponent(packed.skill.id)}/export?ah_token=${encodeURIComponent(user.token)}`;
      const fs = await import("node:fs");
      const INLINE_LIMIT = 1024 * 1024; // 1MB 以内直接内联，Agent 解压即用
      const buf = fs.readFileSync(packed.file);
      const base = {
        导出成功: true,
        skillId: packed.skill.id,
        名称: packed.skill.name,
        版本: packed.skill.version,
        文件名: packed.fileName,
        大小: `${(packed.size / 1024).toFixed(1)} KB`,
        包含文件: packed.skill.files.map((f) => f.path),
        下载链接: downloadUrl,
        安装提示: "下载/解压后放入 Agent 的 skills 目录即可使用；解压命令：tar -xzf <文件名>",
      };
      if (packed.size <= INLINE_LIMIT) {
        return ok({ ...base, base64内容: buf.toString("base64"), 使用方式: "把 base64内容 写入文件后执行 tar -xzf 解压" });
      }
      return ok({ ...base, 使用方式: "整包超过 1MB，请使用下载链接（curl -O 带上链接中的令牌）获取" });
    }

    case "unpublish_skill": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const skill = getSkills().get(args.skillId, user);
      if (!canManage(skill, user)) throw new Error("只有发布者可以下线该 Skill。");
      return ok(getSkills().unpublish(args.skillId));
    }

    case "publish_library": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      let buffer;
      let fileName = args.fileName ? String(args.fileName) : "";
      if (args.sourcePath) {
        const abs = path.resolve(String(args.sourcePath));
        if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
          throw new Error(`文件不存在或不是普通文件: ${abs}`);
        }
        if (fs.statSync(abs).size > MAX_LIBRARY_SIZE) {
          throw new Error(`文件超过大小上限（${MAX_LIBRARY_SIZE / 1024 / 1024}MB）`);
        }
        buffer = fs.readFileSync(abs);
        if (!fileName) fileName = path.basename(abs);
      } else if (args.contentBase64) {
        buffer = Buffer.from(String(args.contentBase64), "base64");
        if (!buffer.length) throw new Error("contentBase64 解码后为空，请检查编码内容。");
      } else {
        throw new Error("必须提供 sourcePath 或 contentBase64 之一。");
      }
      if (!fileName) throw new Error("缺少文件名：请提供 fileName（含扩展名，如 周报.md）。");
      const item = getLibrary().upload({
        user,
        fileName,
        buffer,
        name: args.name,
        visibility: args.visibility,
        extra: { department: args.department, users: args.users },
      });
      return ok({
        归档成功: true,
        libId: item.id,
        名称: item.name,
        分类: `${item.category}（${categoryLabel(item.category)}）`,
        大小: `${(item.size / 1024).toFixed(1)} KB`,
        文件名: item.fileName,
        发布者: `${user.name}（${user.id}）`,
        权限范围: `${item.visibility}（${VISIBILITY_LABELS[item.visibility] || item.visibility}）`,
        下载链接: `http://${HUB_DOMAIN}:${HUB_PORT}/__hub__/library/${item.id}/download?ah_token=${encodeURIComponent(user.token)}`,
        提示: "同事可调用 list_library 发现；门户资料库分区展示。可随时调用 set_library_permission 调整权限。",
      });
    }

    case "list_library": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const items = getLibrary().list(user);
      if (!items.length) return ok("当前身份下资料库为空。");
      return ok(
        items.map((x) => ({
          libId: x.id,
          名称: x.name,
          分类: categoryLabel(x.category),
          大小: `${(x.size / 1024).toFixed(1)} KB`,
          权限: x.visibility,
          上传者: x.owner,
          下载次数: getLibrary().downloadCount(x.id),
          更新时间: x.updatedAt,
          我是发布者: canManage(x, user),
        })),
      );
    }

    case "set_library_permission": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const item = getLibrary().get(args.libId, user);
      if (!item) throw new Error(`资料不存在: ${args.libId}`);
      if (!canManage(item, user)) throw new Error("只有发布者可以修改该资料的权限。");
      const updated = getLibrary().setPermission(args.libId, {
        visibility: args.visibility,
        department: args.department,
        users: args.users,
      });
      return ok({ 已更新: true, libId: updated.id, 权限范围: `${updated.visibility}（${VISIBILITY_LABELS[updated.visibility] || updated.visibility}）` });
    }

    case "unpublish_library": {
      const agent = authAgent(args.agentToken);
      const user = agentUser(agent) || ensureDevUser();
      const item = getLibrary().get(args.libId, user);
      if (!item) throw new Error(`资料不存在: ${args.libId}`);
      if (!canManage(item, user)) throw new Error("只有发布者可以删除该资料。");
      return ok(getLibrary().unpublish(args.libId));
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

export function createMcpServer() {
  const server = new Server({ name: "ai-hub", version: "0.2.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleTool(name, args || {});
    } catch (e) {
      return fail(e.message);
    }
  });
  return server;
}
