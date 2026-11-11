import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startRouter } from "../src/router.js";
import { HUB_ROOT, HUB_PORT } from "../src/config.js";

const MCP_SERVER = path.join(HUB_ROOT, "src", "mcp-server.js");
const HUB = `http://localhost:${HUB_PORT}`;

function toolText(res) {
  return res?.content?.[0]?.type === "text" ? res.content[0].text : JSON.stringify(res);
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${toolText(res)}`);
  try {
    return JSON.parse(toolText(res));
  } catch {
    return toolText(res);
  }
}

async function devLogin(name, department) {
  const res = await fetch(`${HUB}/__hub__/auth/dev-login?name=${encodeURIComponent(name)}&department=${encodeURIComponent(department || "")}`, {
    redirect: "manual",
  });
  const cookie = res.headers.getSetCookie()[0].split(";")[0];
  return (await (await fetch(`${HUB}/__hub__/me`, { headers: { cookie } })).json()).user;
}

async function connectAgent(name, userToken) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_SERVER], env: { ...process.env } });
  const client = new Client({ name: `${name}-seed`, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const conn = await call(client, "connect", { agentName: name, userToken });
  return { client, token: conn.token };
}

async function main() {
  startRouter();
  const fang = await devLogin("方科", "商务部");
  const li = await devLogin("小李", "广告执行部");

  const fangAgent = await connectAgent("Claude", fang.token);
  const liAgent = await connectAgent("Codex", li.token);

  const app1 = await call(fangAgent.client, "publish_app", {
    projectPath: path.join(HUB_ROOT, "fixtures", "demo-app"),
    appName: "team-dashboard",
    visibility: "all",
    agentToken: fangAgent.token,
  });
  console.log(`应用: ${app1.名称} → ${app1.子域名}（全员可见）`);

  const app2 = await call(liAgent.client, "publish_app", {
    projectPath: path.join(HUB_ROOT, "fixtures", "python-app"),
    visibility: "users",
    users: ["方科"],
    agentToken: liAgent.token,
  });
  console.log(`应用: ${app2.名称} → ${app2.子域名}（白名单：方科）`);

  const skill = await call(fangAgent.client, "publish_skill", {
    projectPath: path.join(HUB_ROOT, "fixtures", "skill-demo"),
    version: "1.0.0",
    visibility: "all",
    agentToken: fangAgent.token,
  });
  console.log(`Skill: ${skill.名称} v${skill.版本}（全员可见）`);

  await fangAgent.client.close();
  await liAgent.client.close();
  console.log(`\n播种完成。门户: ${HUB}（未登录时用开发登录表单，姓名填「方科」或「小李」体验不同权限视野）`);
  process.exit(0);
}

main().catch((e) => {
  console.error("播种失败:", e);
  process.exit(1);
});
