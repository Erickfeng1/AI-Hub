import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hubLogin } from "./e2e-login.mjs";

const HUB = "http://localhost:8080";
const HUB_ROOT = "/Users/fzj/WorkBuddy/2026-10-14-14-29-13/ai-hub";

function toolText(res) {
  return res?.content?.[0]?.type === "text" ? res.content[0].text : JSON.stringify(res);
}

async function main() {
  const client = new Client({ name: "http-e2e", version: "0.1.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`)));

  // 登录用户王五（dev Provider 走 dev-login；其他 Provider 回退到门户已有用户）
  const { user: me } = await hubLogin("王五", "技术部");

  const conn = JSON.parse(toolText(await client.callTool({ name: "connect", arguments: { agentName: "HTTP-Agent", userToken: me.token } })));
  console.log("connect:", conn.name, "→", conn.绑定用户.name);

  const pub = JSON.parse(toolText(await client.callTool({
    name: "publish_app",
    arguments: { projectPath: path.join(HUB_ROOT, "fixtures", "node-app"), agentToken: conn.token },
  })));
  console.log("publish:", pub.名称, "→", pub.子域名, "|", pub.权限范围);

  const r = await fetch(pub.子域名, { headers: { Accept: "application/json", Authorization: `Bearer ${me.token}` }, redirect: "manual" });
  const html = await r.text();
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  console.log(`access: HTTP ${r.status} · <title>${title}</title>`);
  if (r.status !== 200) throw new Error("Node 应用访问失败");

  const unpub = JSON.parse(toolText(await client.callTool({ name: "unpublish_app", arguments: { appId: pub.appId, agentToken: conn.token } })));
  console.log("unpublish:", JSON.stringify(unpub));
  const r2 = await fetch(pub.子域名, { headers: { Accept: "application/json" }, redirect: "manual" });
  console.log(`after unpublish: HTTP ${r2.status}（应为 404）`);
  if (r2.status !== 404) throw new Error("下线后仍可访问");

  const list = JSON.parse(toolText(await client.callTool({ name: "list_apps", arguments: { agentToken: conn.token } })));
  console.log("王五可见应用:", list.map((a) => a.名称).join(", ") || "（无）");

  await client.close();
  console.log("\nHTTP 端到端闭环验证通过");
  process.exit(0);
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
