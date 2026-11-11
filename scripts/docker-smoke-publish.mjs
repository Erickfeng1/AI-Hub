/** docker 模式冒烟发布：把 fixture 应用发布为容器应用，供生产运行时验收。
 *
 * 前置（见 outputs/生产部署指南.md 第 2 节）：
 *   1. Docker Desktop 已启动（docker info 能连通守护进程）
 *   2. infra 的 Traefik 已起：cd infra && cp .env.example .env && docker compose up -d
 *   3. 中台以 docker 模式运行在 8080：HUB_EXECUTOR=docker npm run hub
 *
 * 运行：HUB_EXECUTOR=docker node scripts/docker-smoke-publish.mjs [static|node|python]
 */
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HUB_ROOT, HUB_PORT } from "../src/config.js";

const HUB = `http://localhost:${HUB_PORT}`;
const MCP_SERVER = path.join(HUB_ROOT, "src", "mcp-server.js");

const FIXTURES = {
  static: { dir: "demo-app", name: "静态验收应用", expect: "团队数据看板" },
  node: { dir: "node-app", name: "Node 验收应用", expect: "Node 演示应用" },
  python: { dir: "python-app", name: "Python 验收应用", expect: "运营助手" },
};

async function main() {
  const kind = process.argv[2] || "static";
  const fx = FIXTURES[kind];
  if (!fx) {
    console.error(`用法: node scripts/docker-smoke-publish.mjs [${Object.keys(FIXTURES).join("|")}]`);
    process.exit(1);
  }

  // 1. 门户登录拿 userToken（dev Provider）
  const login = await fetch(`${HUB}/__hub__/auth/dev-login?name=${encodeURIComponent("验收用户")}`, { redirect: "manual" });
  if (login.status !== 302) {
    console.error(`中台未就绪或非 dev 登录模式（HTTP ${login.status}）。确认 HUB_EXECUTOR=docker npm run hub 正在运行。`);
    process.exit(1);
  }
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const me = await (await fetch(`${HUB}/__hub__/me`, { headers: { cookie } })).json();

  // 2. 连通 stdio MCP（执行器由 HUB_EXECUTOR 决定，必须是 docker；
  //    HUB_INTERNAL_URL 决定 forwardAuth 回调地址，中台跑宿主机时默认 host.docker.internal）
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER],
    env: {
      ...process.env,
      HUB_EXECUTOR: "docker",
      HUB_INTERNAL_URL: process.env.HUB_INTERNAL_URL || `http://host.docker.internal:${HUB_PORT}`,
    },
  });
  const client = new Client({ name: "docker-smoke", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const connText = (await client.callTool({ name: "connect", arguments: { agentName: "验收Agent", userToken: me.user.token } })).content[0].text;
  const token = JSON.parse(connText).token;

  // 3. 发布
  const pubText = (
    await client.callTool({
      name: "publish_app",
      arguments: {
        projectPath: path.join(HUB_ROOT, "fixtures", fx.dir),
        appName: fx.name,
        visibility: "all",
        agentToken: token,
      },
    })
  ).content[0].text;
  const pub = JSON.parse(pubText);
  await client.close();

  console.log(`
发布成功 → ${pub.子域名}
运行时：${pub.类型} · 权限：全员

按顺序验收：
  1. 未登录浏览器开 ${pub.子域名}        → 应 302 跳登录页（Traefik forwardAuth 生效）
  2. 登录「验收用户」后刷新                → 应看到「${fx.expect}」页面（容器 + Traefik 路由生效）
  3. docker logs hub-$(new URL(pub.子域名).hostname.split(".")[0])   → 容器日志
  4. ai-hub/data/logs/${pub.appId}.log    → 中台构建/运行日志

容器状态：docker ps --filter name=hub-
清理：把上面 appId 告诉 Agent 调 unpublish_app，或 docker rm -f hub-<slug>
`);
}

main().catch((e) => {
  console.error("发布失败:", e.message);
  process.exit(1);
});
