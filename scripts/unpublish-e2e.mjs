/**
 * 门户「下架（删除）」端到端验证。
 *
 * 覆盖：
 *   1. 发布者能看到自己应用/Skill 的「下架」按钮，别人看不到
 *   2. 发布者 POST 下架 → 302 回门户、store 移除、目录清理、usage 记录清理
 *   3. 非发布者下架 → 403（越权拒绝）
 *   4. 匿名下架 → 401
 *   5. Cookie 会话缺 CSRF 令牌 → 403（防跨站提交）
 *   6. Bearer 显式凭据 → 放行（不需 csrf）
 *   7. 下架后应用子域名不可访问
 *
 * 自洽重置：开跑先清掉本账号历史遗留的同名应用/Skill。
 */
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startRouter } from "../src/router.js";
import { HUB_ROOT, HUB_PORT } from "../src/config.js";
import { hubLogin } from "./e2e-login.mjs";
import { load } from "../src/store.js";

const MCP_SERVER = path.join(HUB_ROOT, "src", "mcp-server.js");
const HUB = `http://localhost:${HUB_PORT}`;
const APP_DIR = "/tmp/ah-unpublish-app";
const SKILL_DIR = "/tmp/ah-unpublish-skill";
const APP_NAME = "待下架应用";
const SKILL_NAME = "待下架Skill";

function section(title) {
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}

let passed = 0;
function check(label, cond, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed++;
}

function toolText(res) {
  const first = res?.content?.[0];
  return first?.type === "text" ? first.text : JSON.stringify(res);
}

async function call(client, name, args, { expectError = false } = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (expectError) {
    if (!res.isError) throw new Error(`工具 ${name} 应当报错但没有`);
    return toolText(res);
  }
  if (res.isError) throw new Error(`工具 ${name} 返回错误: ${toolText(res)}`);
  const text = toolText(res);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function connectAgent(name, userToken) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_SERVER], env: { ...process.env } });
  const client = new Client({ name: `${name}-demo`, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const conn = await call(client, "connect", { agentName: name, userToken });
  return { client, token: conn.token };
}

/** 提取门户 HTML 中的 csrf 令牌 */
function extractCsrf(html) {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  return m ? m[1] : "";
}

/** 门户 HTML 中某个 slug / skill id 对应卡片的「下架」按钮是否存在 */
function hasUnpublishBtn(html, id) {
  return html.includes(`/unpublish"`) && html.includes(`/${encodeURIComponent(id)}/unpublish`);
}

function prepareFixtures() {
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(path.join(APP_DIR, "index.html"), "<h1>待下架应用</h1><p>这是一个用于验证下架流程的测试应用。</p>");

  fs.rmSync(SKILL_DIR, { recursive: true, force: true });
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SKILL_DIR, "SKILL.md"),
    ["---", "name: 待下架Skill", "description: 用于验证下架流程的测试 Skill", "version: 1.0.0", "---", "", "# 待下架Skill", "", "占位内容。"].join("\n"),
  );
}

/** 登录并展开用户字段（hubLogin 返回 { user, cookie } 嵌套结构） */
async function devLogin(name, department) {
  const { user, cookie } = await hubLogin(name, department);
  return { ...user, cookie };
}

async function main() {
  section("第 0 步 · 启动中台（若已在运行则自动复用）");
  startRouter();
  prepareFixtures();

  section("第 1 步 · 两名同事登录");
  const fang = await devLogin("方科", "商务部");
  const li = await devLogin("小李", "广告执行部");
  console.log(`方科=${fang.id} 小李=${li.id}`);

  const fangAgent = await connectAgent("Claude", fang.token);
  const liAgent = await connectAgent("Codex", li.token);

  section("第 2 步 · 自洽重置：清掉历史遗留的同名应用/Skill");
  // 注意：只清理「我是发布者」的同名项——上一轮可能是别的账号发布的（全员可见），
  // 那不属于本账号的垃圾数据，无权删除（会触发越权）。留下的同名项在第 3 步会因 slug 冲突自动加后缀。
  const existingApps = await call(fangAgent.client, "list_apps", { agentToken: fangAgent.token });
  for (const a of Array.isArray(existingApps) ? existingApps.filter((x) => x.名称 === APP_NAME && x.我是发布者) : []) {
    await call(fangAgent.client, "unpublish_app", { appId: a.appId, agentToken: fangAgent.token });
    console.log(`（重置：已下线历史遗留应用 ${a.名称}）`);
  }
  const existingSkills = await call(fangAgent.client, "list_skills", { agentToken: fangAgent.token });
  for (const s of Array.isArray(existingSkills) ? existingSkills.filter((x) => x.名称 === SKILL_NAME && x.我是发布者) : []) {
    await call(fangAgent.client, "unpublish_skill", { skillId: s.skillId, agentToken: fangAgent.token });
    console.log(`（重置：已下线历史遗留 Skill ${s.名称}）`);
  }

  section("第 3 步 · 方科发布应用与 Skill（全员可见，便于验证越权拒绝）");
  const app = await call(fangAgent.client, "publish_app", {
    projectPath: APP_DIR,
    appName: APP_NAME,
    visibility: "all",
    agentToken: fangAgent.token,
  });
  console.log(`应用: ${app.名称} · ${app.appId} · ${app.权限范围}`);
  const appId = app.appId;
  const skill = await call(fangAgent.client, "publish_skill", {
    projectPath: SKILL_DIR,
    visibility: "all",
    agentToken: fangAgent.token,
  });
  console.log(`Skill: ${skill.名称} · ${skill.skillId} · ${skill.版本}`);
  const skillId = skill.skillId;
  check("应用发布成功", !!appId);
  check("Skill 发布成功", !!skillId);

  section("第 4 步 · 门户：发布者看得到「下架」按钮，非发布者看不到");
  const fangHtml = await (await fetch(HUB, { headers: { cookie: fang.cookie } })).text();
  const liHtml = await (await fetch(HUB, { headers: { cookie: li.cookie } })).text();
  const csrf = extractCsrf(fangHtml);
  check("方科（发布者）看得到应用下架按钮", hasUnpublishBtn(fangHtml, appId));
  check("方科（发布者）看得到 Skill 下架按钮", hasUnpublishBtn(fangHtml, skillId));
  check("小李（非发布者）看不到应用下架按钮", !hasUnpublishBtn(liHtml, appId));
  check("小李（非发布者）看不到 Skill 下架按钮", !hasUnpublishBtn(liHtml, skillId));
  check("门户渲染出 csrf 令牌", csrf.length > 10, `${csrf.slice(0, 8)}…`);

  section("第 5 步 · 越权与未登录：非发布者 / 匿名下架被拒");
  const liApp = await fetch(`${HUB}/__hub__/apps/${encodeURIComponent(appId)}/unpublish`, {
    method: "POST",
    headers: { cookie: li.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `csrf=${encodeURIComponent(extractCsrf(liHtml))}`,
    redirect: "manual",
  });
  check("小李下架方科的应用 → 403", liApp.status === 403, `HTTP ${liApp.status}`);
  const anonApp = await fetch(`${HUB}/__hub__/apps/${encodeURIComponent(appId)}/unpublish`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "",
    redirect: "manual",
  });
  check("匿名下架 → 401", anonApp.status === 401, `HTTP ${anonApp.status}`);
  const liSkill = await fetch(`${HUB}/__hub__/skills/${encodeURIComponent(skillId)}/unpublish`, {
    method: "POST",
    headers: { cookie: li.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `csrf=${encodeURIComponent(extractCsrf(liHtml))}`,
    redirect: "manual",
  });
  check("小李下架方科的 Skill → 403", liSkill.status === 403, `HTTP ${liSkill.status}`);

  section("第 6 步 · CSRF 防护：Cookie 会话缺令牌 → 403");
  const noCsrf = await fetch(`${HUB}/__hub__/apps/${encodeURIComponent(appId)}/unpublish`, {
    method: "POST",
    headers: { cookie: fang.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "csrf=wrong-token",
    redirect: "manual",
  });
  check("错误 csrf 令牌 → 403", noCsrf.status === 403, `HTTP ${noCsrf.status}`);
  const stillThere = load().apps.find((a) => a.id === appId);
  check("被拒后应用仍在", !!stillThere);

  section("第 7 步 · Bearer 显式凭据 → 放行（不需 csrf）");
  const bearerRes = await fetch(`${HUB}/__hub__/skills/${encodeURIComponent(skillId)}/unpublish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fang.token}`, "content-type": "application/x-www-form-urlencoded" },
    body: "",
    redirect: "manual",
  });
  check("Bearer 下架 Skill → 302 跳转门户", bearerRes.status === 302, `HTTP ${bearerRes.status}`);
  const skillGone = !load().skills.find((s) => s.id === skillId);
  check("Skill 已从 store 移除", skillGone);

  section("第 8 步 · 发布者正常下架应用：302 + store 移除 + 目录清理");
  const storeBefore = load();
  const appBefore = storeBefore.apps.find((a) => a.id === appId);
  const sourceDir = appBefore.sourceDir;
  const appDir = path.dirname(sourceDir);
  check("下架前应用目录存在", fs.existsSync(appDir), appDir);
  const okRes = await fetch(`${HUB}/__hub__/apps/${encodeURIComponent(appId)}/unpublish`, {
    method: "POST",
    headers: { cookie: fang.cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `csrf=${encodeURIComponent(csrf)}`,
    redirect: "manual",
  });
  check("发布者下架 → 302 跳转门户", okRes.status === 302, `HTTP ${okRes.status}`);
  check("Location 指向门户", (okRes.headers.get("location") || "") === "/", okRes.headers.get("location"));
  const storeAfter = load();
  check("应用已从 store 移除", !storeAfter.apps.find((a) => a.id === appId));
  check("应用目录已清理", !fs.existsSync(appDir), appDir);
  const orphanUsage = (storeAfter.usage || []).find((u) => u.kind === "app" && u.refId === appId);
  check("usage 记录已清理（无孤儿数据）", !orphanUsage);

  section("第 9 步 · 下架后子域名不可访问");
  const slug = appBefore.slug;
  const sub = await fetch(`http://${slug}.localhost:${HUB_PORT}/`, { redirect: "manual" });
  check("已下架应用子域名 → 404", sub.status === 404, `HTTP ${sub.status}`);

  section("第 10 步 · 门户页面不再展示已下架项");
  const fangHtml2 = await (await fetch(HUB, { headers: { cookie: fang.cookie } })).text();
  check("门户不再出现该应用卡片", !fangHtml2.includes(appBefore.name) || !hasUnpublishBtn(fangHtml2, appId));

  section(`下架功能端到端验证通过 · ${passed} 项断言`);
  await fangAgent.client.close();
  await liAgent.client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("验证失败:", e);
  process.exit(1);
});
