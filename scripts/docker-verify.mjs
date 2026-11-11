/** docker 模式应用验收：清理既有容器应用 → 发布指定类型 → 验证 forwardAuth 与页面。
 * 用法：HUB_EXECUTOR=docker node scripts/docker-verify.mjs [static|node|python]
 * 前置：Traefik 已起（infra/docker-compose.yml）、中台以 HUB_EXECUTOR=docker 运行于 8080。
 */
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { load } from "../src/store.js";
import { HUB_ROOT, HUB_PORT } from "../src/config.js";

const HUB = `http://localhost:${HUB_PORT}`;
const MCP_SERVER = path.join(HUB_ROOT, "src", "mcp-server.js");

const CASES = {
  static: { dir: "demo-app", name: "静态验收应用", expect: "团队数据看板" },
  node: { dir: "node-app", name: "Node 验收应用", expect: "Node 演示应用" },
  python: { dir: "python-app", name: "Python 验收应用", expect: "运营助手" },
};

let passed = 0;
function check(label, cond, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed++;
}

async function main() {
  const kind = process.argv[2] || "static";
  const fx = CASES[kind];
  if (!fx) {
    console.error(`用法: node scripts/docker-verify.mjs [${Object.keys(CASES).join("|")}]`);
    process.exit(1);
  }

  // 1. 登录拿 userToken
  const login = await fetch(`${HUB}/__hub__/auth/dev-login?name=${encodeURIComponent("验收用户")}`, { redirect: "manual" });
  if (login.status !== 302) {
    console.error(`中台未就绪（HTTP ${login.status}）`);
    process.exit(1);
  }
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const me = await (await fetch(`${HUB}/__hub__/me`, { headers: { cookie } })).json();

  // 2. 连通 MCP（stdio 子进程独立加载 executor，须带 HUB_INTERNAL_URL，
  //    否则 forwardAuth 地址回退默认 http://hub:8080——那是全容器化部署的容器名，
  //    本脚本前置条件为中台跑宿主机，用 host.docker.internal 可达）
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER],
    env: {
      ...process.env,
      HUB_EXECUTOR: "docker",
      HUB_INTERNAL_URL: process.env.HUB_INTERNAL_URL || `http://host.docker.internal:${HUB_PORT}`,
    },
  });
  const client = new Client({ name: "docker-verify", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const connText = (await client.callTool({ name: "connect", arguments: { agentName: "验收Agent", userToken: me.user.token } })).content[0].text;
  const token = JSON.parse(connText).token;
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(r.content?.[0]?.text || "工具错误");
    return JSON.parse(r.content[0].text);
  };

  // 3. 清理既有容器应用（保证验收从干净状态开始）
  const stale = load().apps.filter((a) => a.runtime?.kind === "container");
  for (const a of stale) {
    await call("unpublish_app", { appId: a.id, agentToken: token });
    console.log(`  （清理历史容器应用 ${a.id} ${a.slug}）`);
  }

  // 4. 发布
  const pub = await call("publish_app", {
    projectPath: path.join(HUB_ROOT, "fixtures", fx.dir),
    appName: fx.name,
    visibility: "all",
    agentToken: token,
  });
  const slug = new URL(pub.子域名).hostname.split(".")[0];
  const appUrlStr = pub.子域名;
  console.log(`\n发布 → ${appUrlStr}（容器 hub-${slug}，端口见构建日志）`);

  // 5. 等容器健康（最多 30s）
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(appUrlStr, { redirect: "manual", headers: { cookie } });
    if (r.status === 200) {
      healthy = true;
      break;
    }
    await new Promise((s) => setTimeout(s, 1000));
  }
  check("容器健康并经 Traefik 可达（登录后 200）", healthy);

  // 6. forwardAuth：未登录 → 401/302
  const anon = await fetch(appUrlStr, { redirect: "manual" });
  check("未登录被网关拦下", anon.status === 401 || anon.status === 302, `HTTP ${anon.status}`);

  // 7. 登录后内容正确
  const authed = await fetch(appUrlStr, { redirect: "manual", headers: { cookie } });
  const html = await authed.text();
  check(`页面内容正确（${fx.expect}）`, html.includes(fx.expect), `<title>${/<title>([^<]*)<\/title>/.exec(html)?.[1]}</title>`);

  // 8. 权限强制：换无权限用户 → 403（把应用改为 self 后验证）
  await call("set_app_permission", { appId: pub.appId, visibility: "self", agentToken: token });
  const liLogin = await fetch(`${HUB}/__hub__/auth/dev-login?name=${encodeURIComponent("小李")}`, { redirect: "manual" });
  const liCookie = liLogin.headers.getSetCookie()[0].split(";")[0];
  const denied = await fetch(appUrlStr, { redirect: "manual", headers: { cookie: liCookie } });
  check("越权访问被网关拦下（403）", denied.status === 403, `HTTP ${denied.status}`);

  // 9. 日志留痕
  const logFile = path.join(HUB_ROOT, "data", "logs", `${pub.appId}.log`);
  check("构建/运行日志已落盘", fs.existsSync(logFile), logFile);

  await client.close();
  console.log(`\n${kind} 应用 docker 验收通过 · ${passed} 项断言（应用保留在门户，appId=${pub.appId}）`);
  process.exit(0);
}

main().catch((e) => {
  console.error("验收失败:", e.message);
  process.exit(1);
});
