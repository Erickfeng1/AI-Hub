import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startRouter } from "../src/router.js";
import { HUB_ROOT, HUB_PORT } from "../src/config.js";
import { hubLogin } from "./e2e-login.mjs";

const MCP_SERVER = path.join(HUB_ROOT, "src", "mcp-server.js");
const HUB = `http://localhost:${HUB_PORT}`;
const SKILL_DIR = path.join(HUB_ROOT, "fixtures", "skill-demo");
const LOCAL_COPY = "/tmp/ah-dist-local"; // 模拟「同事本地已安装的旧版 Skill」

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

/** dev Provider 走 dev-login；其他 Provider 回退到门户已有用户（cookie 为 null 时用 Bearer） */
async function devLogin(name, department) {
  const { user, cookie } = await hubLogin(name, department);
  return { ...user, cookie };
}

let passed = 0;
function check(label, cond, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed++;
}

async function connectAgent(name, userToken) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_SERVER], env: { ...process.env } });
  const client = new Client({ name: `${name}-demo`, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const conn = await call(client, "connect", { agentName: name, userToken });
  return { client, token: conn.token, conn };
}

/** 列出 tar.gz 内的文件（相对路径） */
function tarList(file) {
  return execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  section("第 0 步 · 启动中台（若已在运行则自动复用）");
  startRouter();

  section("第 1 步 · 三名同事登录");
  const fang = await devLogin("方科", "商务部");
  const li = await devLogin("小李", "广告执行部");
  const wang = await devLogin("王五", "广告执行部");
  console.log(`方科=${fang.id} 小李=${li.id} 王五=${wang.id}`);

  section("第 2 步 · 方科发布 Skill v1.0.0（仅自己可见）");
  // 自洽重置：先下线历史遗留的同名 Skill，保证从 v1.0.0 开始（与 skill-e2e 的约定一致）
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
  const skillId = pub.skillId;
  console.log(`发布: ${pub.名称} v${pub.版本} · ${pub.权限范围} · ${pub.文件数} 个文件`);
  check("发布成功", pub.发布成功 === true && pub.版本 === "1.0.0", `skillId=${skillId}`);

  section("第 3 步 · export_skill：base64 内联整包（Agent 解压即用）");
  const exp = await call(fangAgent.client, "export_skill", { skillId, agentToken: fangAgent.token });
  check("返回 base64 内容", typeof exp.base64内容 === "string" && exp.base64内容.length > 200);
  check("包含完整文件清单", (exp.包含文件 || []).some((f) => f === "SKILL.md") && (exp.包含文件 || []).some((f) => f.includes("weekly.py")),
    (exp.包含文件 || []).join(", "));
  fs.rmSync(LOCAL_COPY, { recursive: true, force: true });
  fs.mkdirSync(LOCAL_COPY, { recursive: true });
  fs.writeFileSync("/tmp/ah-dist-skill.tar.gz", Buffer.from(exp.base64内容, "base64"));
  const inlineList = tarList("/tmp/ah-dist-skill.tar.gz");
  check("内联包可解压且含 SKILL.md 与附属脚本", inlineList.some((f) => f.endsWith("SKILL.md")) && inlineList.some((f) => f.includes("weekly.py")),
    inlineList.join(" "));
  execFileSync("tar", ["-xzf", "/tmp/ah-dist-skill.tar.gz", "-C", LOCAL_COPY]);
  check("解压后是合法 Skill 目录", fs.existsSync(path.join(LOCAL_COPY, "SKILL.md")) && fs.existsSync(path.join(LOCAL_COPY, "scripts", "weekly.py")));
  const firstMd = fs.readFileSync(path.join(LOCAL_COPY, "SKILL.md"), "utf8");
  check("整包内 SKILL.md version 与平台一致（1.0.0）", /version:\s*1\.0\.0/.test(firstMd), firstMd.split("\n").find((l) => l.includes("version")) || "");

  section("第 4 步 · 下载端点：带令牌直接拉取 tar.gz");
  const dl = await fetch(`${HUB}/__hub__/skills/${skillId}/export?ah_token=${encodeURIComponent(fang.token)}`);
  check("下载端点 200 且为 gzip", dl.status === 200 && (dl.headers.get("content-type") || "").includes("gzip"), `HTTP ${dl.status}`);
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  check("文件头是 gzip magic", dlBuf[0] === 0x1f && dlBuf[1] === 0x8b, `0x${dlBuf[0].toString(16)} 0x${dlBuf[1].toString(16)}`);
  check("Content-Disposition 带文件名", /attachment; filename=".*\.tar\.gz"/.test(dl.headers.get("content-disposition") || ""), dl.headers.get("content-disposition"));
  fs.writeFileSync("/tmp/ah-dist-download.tar.gz", dlBuf);
  check("下载包内容一致", tarList("/tmp/ah-dist-download.tar.gz").join(" ") === inlineList.join(" "));

  section("第 5 步 · 权限：小李越权导出被拒（self 权限）");
  const liAgent = await connectAgent("Codex", li.token);
  const denyExport = await call(liAgent.client, "export_skill", { skillId, agentToken: liAgent.token }, { expectError: true });
  check("越权导出被拒", /无权查看/.test(denyExport), denyExport.split("\n")[0]);
  const denyDl = await fetch(`${HUB}/__hub__/skills/${skillId}/export?ah_token=${encodeURIComponent(li.token)}`);
  check("下载端点越权 403", denyDl.status === 403, `HTTP ${denyDl.status}`);
  const anonDl = await fetch(`${HUB}/__hub__/skills/${skillId}/export`);
  check("下载端点匿名 401", anonDl.status === 401, `HTTP ${anonDl.status}`);

  section("第 6 步 · 方科改权限为全员 → 小李可导出");
  await call(fangAgent.client, "set_skill_permission", { skillId, visibility: "all", agentToken: fangAgent.token });
  const liExp = await call(liAgent.client, "export_skill", { skillId, agentToken: liAgent.token });
  check("小李导出成功", liExp.导出成功 === true && typeof liExp.base64内容 === "string", `v${liExp.版本} ${liExp.大小}`);

  section("第 7 步 · 方科升级 v1.1.0，小李本地留痕 v1.0.0");
  const pub2 = await call(fangAgent.client, "publish_skill", {
    projectPath: SKILL_DIR,
    version: "1.1.0",
    agentToken: fangAgent.token,
  });
  check("升级到 v1.1.0", pub2.版本 === "1.1.0");
  const liCheck = await call(liAgent.client, "check_skill_version", { projectPath: LOCAL_COPY, agentToken: liAgent.token });
  console.log(`小李本地 v${liCheck.本地版本} vs 平台 v${liCheck.平台版本} → ${liCheck.状态}: ${liCheck.结论}`);
  check("小李收到 platform-newer 提醒", liCheck.状态 === "platform-newer" && /建议更新/.test(liCheck.结论));

  section("第 7b 步 · 升级后导出的整包，SKILL.md version 必须同步为平台新版本");
  const liExp2 = await call(liAgent.client, "export_skill", { skillId, agentToken: liAgent.token });
  fs.writeFileSync("/tmp/ah-dist-upgraded.tar.gz", Buffer.from(liExp2.base64内容, "base64"));
  fs.rmSync("/tmp/ah-dist-upgraded", { recursive: true, force: true });
  fs.mkdirSync("/tmp/ah-dist-upgraded", { recursive: true });
  execFileSync("tar", ["-xzf", "/tmp/ah-dist-upgraded.tar.gz", "-C", "/tmp/ah-dist-upgraded"]);
  const upgradedMd = fs.readFileSync("/tmp/ah-dist-upgraded/SKILL.md", "utf8");
  check("整包内 SKILL.md version 已改写为 1.1.0", /version:\s*1\.1\.0/.test(upgradedMd), upgradedMd.split("\n").find((l) => l.includes("version")) || "");

  section("第 8 步 · 触点一：list_skills 标注本地版本与更新");
  const liList = await call(liAgent.client, "list_skills", { agentToken: liAgent.token });
  const row = liList.find((s) => s.skillId === skillId);
  check("列出本地已装版本 v1.0.0", row.本地已装版本 === "1.0.0", `本地=${row.本地已装版本}`);
  check("有更新=true", row.有更新 === true);

  section("第 9 步 · 触点二：connect 返回待更新清单");
  const liReconn = await connectAgent("Codex-2", li.token);
  check("connect 提示 1 个待更新", Array.isArray(liReconn.conn.待更新Skill) && liReconn.conn.待更新Skill.length === 1 && liReconn.conn.待更新Skill[0].skillId === skillId,
    JSON.stringify(liReconn.conn.待更新Skill?.[0]?.名称 || liReconn.conn.待更新Skill));

  section("第 10 步 · 触点三：门户 Skill 卡片显示「有新版本」徽标");
  const page = await (await fetch(`${HUB}/`, { headers: li.cookie ? { cookie: li.cookie } : { Authorization: `Bearer ${li.token}` } })).text();
  check("门户显示更新徽标", /有新版本 · 本地 v1\.0\.0/.test(page), page.includes("有新版本") ? "已找到徽标" : "未找到徽标");
  check("门户提供下载入口", /\/__hub__\/skills\/[^"]*\/export\?ah_token=/.test(page));

  section("第 11 步 · 无留痕用户不误报（王五）");
  const wangAgent = await connectAgent("WorkBuddy", wang.token);
  const wangList = await call(wangAgent.client, "list_skills", { agentToken: wangAgent.token });
  const wangRow = wangList.find((s) => s.skillId === skillId);
  check("王五可见（全员）但无留痕", wangRow && wangRow.本地已装版本 === null && wangRow.有更新 === false);

  section(`Skill 分发闭环端到端验证通过 · ${passed} 项断言`);
  await fangAgent.client.close();
  await liAgent.client.close();
  await liReconn.client.close();
  await wangAgent.client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("演示失败:", e);
  process.exit(1);
});
