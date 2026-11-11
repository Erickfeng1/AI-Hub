import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startRouter } from "../src/router.js";
import { HUB_ROOT, HUB_PORT } from "../src/config.js";
import { hubLogin as devLogin } from "./e2e-login.mjs";

const MCP_SERVER = path.join(HUB_ROOT, "src", "mcp-server.js");
const HUB = `http://localhost:${HUB_PORT}`;

function section(title) {
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}

function toolText(res) {
  const first = res?.content?.[0];
  return first?.type === "text" ? first.text : JSON.stringify(res);
}

/** 调用工具并断言没有 isError，返回解析后的 JSON / 原文 */
async function callToolOk(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`工具 ${name} 返回错误: ${toolText(res)}`);
  const text = toolText(res);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function get(url, token) {
  return fetch(url, {
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    redirect: "manual",
  });
}

let passed = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed++;
}

async function main() {
  section("第 0 步 · 启动中台（门户 + 子域名路由 + 权限强制 + /mcp）");
  startRouter();

  section("第 1 步 · 两名同事通过门户登录（dev Provider，生产对应飞书 OAuth）");
  const fang = await devLogin("方科", "商务部");
  const li = await devLogin("小李", "广告执行部");
  console.log(`用户A: ${fang.user.name}（${fang.user.department}）token=${fang.user.token.slice(0, 18)}…`);
  console.log(`用户B: ${li.user.name}（${li.user.department}）token=${li.user.token.slice(0, 18)}…`);

  section("第 2 步 · Agent 连接中台 MCP（第一段 Prompt，绑定用户身份）");
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_SERVER], env: { ...process.env } });
  const client = new Client({ name: "claude-demo", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log("MCP 可用工具:", tools.map((t) => t.name).join(", "));

  const connRes = await callToolOk(client, "connect", { agentName: "Claude", userToken: fang.user.token });
  const conn = connRes;
  console.log(`connect 成功: agent=${conn.name} 绑定用户=${conn.绑定用户.name} token=${conn.token.slice(0, 16)}…`);
  const agentToken = conn.token;

  const who = await callToolOk(client, "whoami", { agentToken });
  console.log(toolText(who));

  section("第 3 步 · 发布静态应用，权限 self（第二段 Prompt）");
  const pub1 = await callToolOk(client, "publish_app", {
    projectPath: path.join(HUB_ROOT, "fixtures", "demo-app"),
    appName: "team-dashboard",
    visibility: "self",
    agentToken,
  });
  const app1 = pub1;
  console.log(`发布成功: ${app1.名称} → ${app1.子域名}（${app1.权限范围}）`);
  console.log(`依赖审查: ${app1.依赖审查}`);

  section("第 4 步 · 权限强制验证（匿名 / 越权 / 本人）");
  const anon = await get(app1.子域名);
  check("匿名访问被拦截", anon.status === 401, `HTTP ${anon.status}`);
  const other = await get(app1.子域名, li.user.token);
  check("其他用户访问被拒绝", other.status === 403, `HTTP ${other.status}`);
  const mine = await get(app1.子域名, fang.user.token);
  const title1 = /<title>([^<]*)<\/title>/.exec(await mine.text())?.[1];
  check("发布者本人可访问", mine.status === 200 && title1 === "团队数据看板", `HTTP ${mine.status} · <title>${title1}</title>`);

  section("第 5 步 · 改权限为全员 → 其他用户立即放行");
  const perm = await callToolOk(client, "set_app_permission", { appId: app1.appId, visibility: "all", agentToken });
  console.log(toolText(perm));
  const nowAllowed = await get(app1.子域名, li.user.token);
  check("全员可见后其他用户可访问", nowAllowed.status === 200, `HTTP ${nowAllowed.status}`);

  section("第 6 步 · 第二个 Agent（小李的 Codex）发布 Python 应用，权限=指定同事");
  const transport2 = new StdioClientTransport({ command: process.execPath, args: [MCP_SERVER], env: { ...process.env } });
  const client2 = new Client({ name: "codex-demo", version: "0.1.0" }, { capabilities: {} });
  await client2.connect(transport2);
  const conn2 = await callToolOk(client2, "connect", { agentName: "Codex", userToken: li.user.token });
  console.log(`connect 成功: agent=${conn2.name} 绑定用户=${conn2.绑定用户.name}`);

  const pub2 = await callToolOk(client2, "publish_app", {
    projectPath: path.join(HUB_ROOT, "fixtures", "python-app"),
    visibility: "users",
    users: ["方科"],
    agentToken: conn2.token,
  });
  const app2 = pub2;
  console.log(`发布成功: ${app2.名称} → ${app2.子域名}（${app2.权限范围}，白名单：方科）`);
  console.log(`依赖审查: ${app2.依赖审查}`);

  section("第 7 步 · Python 应用鉴权与运行验证");
  const pyOwner = await get(app2.子域名, li.user.token);
  check("发布者（小李）可访问", pyOwner.status === 200, `HTTP ${pyOwner.status}`);
  const pyWhitelisted = await get(app2.子域名, fang.user.token);
  const info = pyWhitelisted.status === 200 ? await (await get(`${app2.子域名}/api/info`, fang.user.token)).json() : null;
  check("白名单同事（方科）可访问", pyWhitelisted.status === 200 && info?.runtime === "flask", `HTTP ${pyWhitelisted.status} · flask PID ${info?.pid ?? "?"}`);
  const pyAnon = await get(app2.子域名);
  check("匿名访问被拦截", pyAnon.status === 401, `HTTP ${pyAnon.status}`);

  section("第 8 步 · 远程 Agent 通过 HTTP（/mcp）接入");
  const httpTransport = new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`));
  const httpClient = new Client({ name: "remote-agent", version: "0.1.0" }, { capabilities: {} });
  await httpClient.connect(httpTransport);
  const httpWho = await callToolOk(httpClient, "whoami", { agentToken });
  check("HTTP 传输可用且身份一致", httpWho.user?.name === "方科", `whoami → ${httpWho.user?.name}`);
  const httpList = await callToolOk(httpClient, "list_apps", { agentToken });
  // 不假设 store 是干净的（历史演示应用可能仍在），断言本次发布的两个应用都在可见列表里
  const httpIds = (Array.isArray(httpList) ? httpList : []).map((a) => a.appId);
  check("HTTP 端 list_apps 返回可见应用", httpIds.includes(app1.appId) && httpIds.includes(app2.appId), `可见 ${httpIds.length} 个，含本次发布的 ${app1.appId} / ${app2.appId}`);
  await httpClient.close();

  section(`演示完成 · ${passed} 项断言全部通过`);
  console.log(`门户地址: ${HUB}`);
  console.log(`静态应用: ${app1.子域名}（全员可见）`);
  console.log(`Python应用: ${app2.子域名}（仅 小李/方科 可见）`);
  console.log(`\n重新运行 node scripts/dev-server.mjs 可恢复所有应用（Node/Python 自动重启）。`);

  await client.close();
  await client2.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("演示失败:", e);
  process.exit(1);
});
