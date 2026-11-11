import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startRouter } from "../src/router.js";
import { HUB_ROOT, HUB_PORT } from "../src/config.js";
import { hubLogin } from "./e2e-login.mjs";

const MCP_SERVER = path.join(HUB_ROOT, "src", "mcp-server.js");
const HUB = `http://localhost:${HUB_PORT}`;
const SKILL_DIR = path.join(HUB_ROOT, "fixtures", "skill-demo");

function section(title) {
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}

function toolText(res) {
  const first = res?.content?.[0];
  return first?.type === "text" ? first.text : JSON.stringify(res);
}

/** 调用工具；expectError=true 时断言返回 isError 并返回错误文本 */
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

/** dev Provider 走 dev-login；其他 Provider 回退到门户已有用户（见 e2e-login.mjs） */
async function devLogin(name, department) {
  return (await hubLogin(name, department)).user;
}

let passed = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed++;
}

async function connectAgent(name, userToken) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_SERVER], env: { ...process.env } });
  const client = new Client({ name: `${name}-demo`, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const conn = await call(client, "connect", { agentName: name, userToken });
  return { client, token: conn.token };
}

async function main() {
  section("第 0 步 · 启动中台（若已在运行则自动复用）");
  startRouter();

  section("第 1 步 · 两名同事登录");
  const fang = await devLogin("方科", "商务部");
  const li = await devLogin("小李", "广告执行部");
  console.log(`方科=${fang.id} 小李=${li.id}`);

  section("第 2 步 · 方科的 Agent 发布 Skill v1.0.0");
  // 自洽重置：若历史运行在平台上留下了同名 Skill，先下线，保证从 v1.0.0 开始（否则自动递增会让版本断言失效）
  const fangAgent = await connectAgent("Claude", fang.token);
  const existing = await call(fangAgent.client, "list_skills", { agentToken: fangAgent.token });
  for (const s of Array.isArray(existing) ? existing.filter((x) => x.名称 === "周报生成器" && x.我是发布者) : []) {
    await call(fangAgent.client, "unpublish_skill", { skillId: s.skillId, agentToken: fangAgent.token });
    console.log(`（重置：已下线历史遗留的 ${s.名称} v${s.版本}）`);
  }
  const pub = await call(fangAgent.client, "publish_skill", {
    projectPath: SKILL_DIR,
    visibility: "self",
    agentToken: fangAgent.token,
  });
  console.log(`发布: ${pub.名称} v${pub.版本} · ${pub.权限范围} · ${pub.文件数} 个文件`);
  const skillId = pub.skillId;
  check("发布版本为 1.0.0", pub.版本 === "1.0.0", `v${pub.版本}`);

  section("第 3 步 · 版本检查（本地=平台，应提示已最新）");
  const check1 = await call(fangAgent.client, "check_skill_version", { projectPath: SKILL_DIR, agentToken: fangAgent.token });
  console.log(`${check1.本地版本} vs ${check1.平台版本} → ${check1.状态}: ${check1.结论}`);
  check("本地 v1.0.0 = 平台 v1.0.0", check1.状态 === "up-to-date");

  section("第 4 步 · 重复发布同版本号应被拒绝");
  const err = await call(fangAgent.client, "publish_skill", {
    projectPath: SKILL_DIR,
    version: "1.0.0",
    agentToken: fangAgent.token,
  }, { expectError: true });
  console.log(`错误信息: ${err.split("\n")[0]}`);
  check("同版本号被拒绝", /必须高于平台当前版本 1.0.0/.test(err));

  section("第 5 步 · 升级发布 v1.1.0（旧版归档，历史可查）");
  const pub2 = await call(fangAgent.client, "publish_skill", {
    projectPath: SKILL_DIR,
    version: "1.1.0",
    agentToken: fangAgent.token,
  });
  console.log(`新版本: v${pub2.版本} · 历史: ${pub2.历史版本.join(" → ")}`);
  check("历史版本已记录", pub2.历史版本.includes("1.0.0"));

  section("第 6 步 · 平台较新 → 提醒更新（文章的更新提醒场景）");
  const check2 = await call(fangAgent.client, "check_skill_version", { projectPath: SKILL_DIR, agentToken: fangAgent.token });
  console.log(`本地 v${check2.本地版本} vs 平台 v${check2.平台版本} → ${check2.状态}: ${check2.结论}`);
  check("platform-newer 提醒", check2.状态 === "platform-newer" && /建议更新/.test(check2.结论));

  section("第 7 步 · 省略 version 自动递增补丁号");
  const pub3 = await call(fangAgent.client, "publish_skill", { projectPath: SKILL_DIR, agentToken: fangAgent.token });
  console.log(`自动版本: v${pub3.版本}`);
  check("自动递增到 1.1.1", pub3.版本 === "1.1.1");

  section("第 8 步 · 权限：小李默认看不到，越权读取被拒");
  const liAgent = await connectAgent("Codex", li.token);
  const liList1 = await call(liAgent.client, "list_skills", { agentToken: liAgent.token });
  const asArray = (r) => (Array.isArray(r) ? r : []);
  check("小李的 Skill 列表为空", asArray(liList1).length === 0, typeof liList1 === "string" ? liList1 : `${liList1.length} 条`);
  const deny = await call(liAgent.client, "get_skill", { skillId, agentToken: liAgent.token }, { expectError: true });
  check("越权读取被拒", /无权查看/.test(deny), deny.split("\n")[0]);

  section("第 9 步 · 方科改权限为全员 → 小李可发现可读取");
  await call(fangAgent.client, "set_skill_permission", { skillId, visibility: "all", agentToken: fangAgent.token });
  const liList2 = await call(liAgent.client, "list_skills", { agentToken: liAgent.token });
  check("全员后小李可见", asArray(liList2).length === 1 && liList2[0].版本 === "1.1.1", `v${liList2[0]?.版本}`);
  const detail = await call(liAgent.client, "get_skill", { skillId, agentToken: liAgent.token });
  check("get_skill 返回 SKILL.md 全文", /周报生成器/.test(detail.SKILL_MD全文 || "") && Array.isArray(detail.文件清单));
  check("历史版本两条", detail.历史版本.length === 2, detail.历史版本.map((h) => h.version).join(" → "));

  section("第 10 步 · 下线 Skill");
  const removed = await call(fangAgent.client, "unpublish_skill", { skillId, agentToken: fangAgent.token });
  const liList3 = await call(liAgent.client, "list_skills", { agentToken: liAgent.token });
  check("下线后列表为空", removed.removed === skillId && asArray(liList3).length === 0);

  section(`Skill 管理端到端验证通过 · ${passed} 项断言`);
  await fangAgent.client.close();
  await liAgent.client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("演示失败:", e);
  process.exit(1);
});
