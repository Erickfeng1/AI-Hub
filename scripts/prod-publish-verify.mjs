/**
 * 生产环境单应用发布验证（服务器侧跑）。
 *
 * 目的：在真实服务器上验证「发布应用」这条完整链路的每一环：
 *   MCP connect → publish_app → docker build → 容器起 → Traefik 发现 label →
 *   子域名证书签发 → forwardAuth 鉴权 → 应用内容正确返回
 *
 * 与本地 docker-smoke-publish.mjs 的差别：
 *   1. 生产是飞书身份层，dev-login 不可用 → 直接从 store.json 取飞书用户的 token 当 userToken；
 *   2. 环境变量不在 shell 里，要显式注入子进程（执行器由子进程 env 决定）；
 *   3. 顺带验证 Cookie 会话与 Bearer 两条鉴权路径（生产浏览器走 Cookie）。
 *
 * 用法：node scripts/prod-publish-verify.mjs [projectPath] [appName]
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSession } from "../src/identity.js";

const HUB_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MCP_SERVER = path.join(HUB_ROOT, "src", "mcp-server.js");
const STORE_FILE = path.join(HUB_ROOT, "data", "store.json");

const projectPath = process.argv[2] || path.join(HUB_ROOT, "fixtures", "demo-app");
const appName = process.argv[3] || "Team Dashboard Live";

/** 生产环境变量：与 systemd 的 .env.production 对齐（子进程要自己拿到，否则执行器退回 local） */
const PROD_ENV = {
  HUB_EXECUTOR: "docker",
  HUB_DOMAIN: "unilink.icu",
  HUB_EXTERNAL_SCHEME: "https",
  HUB_PORT: "8099",
  // Traefik 容器回访宿主机中台做 forwardAuth 的地址
  HUB_INTERNAL_URL: "http://host.docker.internal:8099",
  // 应用路由挂证书解析器（不设则子域名没有证书，且 nginx 会 301 到 https 后 404）
  HUB_TLS_CERT_RESOLVER: "le",
  HUB_COOKIE_DOMAIN: ".unilink.icu",
  HUB_APP_CPUS: "1",
  HUB_APP_MEMORY: "512m",
  HUB_APP_PIDS_LIMIT: "256",
};

function toolText(res) {
  const first = res?.content?.[0];
  return first?.type === "text" ? first.text : JSON.stringify(res);
}

async function callToolOk(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`工具 ${name} 失败: ${toolText(res)}`);
  const text = toolText(res);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- 1. 取一个已存在用户（飞书优先）作为发布者 ----
  const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  const user = store.users.find((u) => u.provider === "feishu") || store.users[0];
  if (!user) throw new Error("store.json 里没有任何用户，无法绑定发布者");
  console.log(`发布者：${user.name}（${user.provider} / ${user.id}）`);
  console.log(`项目目录：${projectPath}`);
  console.log(`应用名称：${appName}`);

  // ---- 2. 连 MCP（stdio） ----
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER],
    env: { ...process.env, ...PROD_ENV },
  });
  const client = new Client({ name: "prod-verify", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const conn = await callToolOk(client, "connect", { agentName: "上线验收Agent", userToken: user.token });
  console.log(`MCP 连接成功，agentId=${conn.agentId}`);

  // ---- 3. 发布 ----
  const t0 = Date.now();
  const pub = await callToolOk(client, "publish_app", {
    projectPath,
    appName,
    visibility: "all",
    agentToken: conn.token,
  });
  await client.close();
  console.log(`发布耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("发布结果：", JSON.stringify(pub, null, 1));

  const url = pub.子域名 || pub.url;
  if (!url) throw new Error("发布结果里没有子域名/URL");
  const host = new URL(url).hostname;
  const slug = host.split(".")[0]; // publish 返回值里没有 slug，从子域名反推

  // ---- 4. 造一个 Cookie 会话（生产浏览器走的就是这条路径）----
  const session = createSession(user.id);
  console.log(`会话已创建：ah_session=${session.id.slice(0, 14)}…`);

  // ---- 5. 等证书签发（ACME HTTP-01，通常十几秒）----
  console.log("等待子域名证书签发…");
  let certOk = false;
  let certInfo = "";
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    try {
      const res = await fetch(`https://${host}/`, {
        redirect: "manual",
        headers: { Cookie: `ah_session=${session.id}` },
      });
      certInfo = `HTTPS 探测 code=${res.status}`;
      if (res.status < 500) {
        certOk = true;
        break;
      }
    } catch (e) {
      certInfo = `HTTPS 探测失败: ${e.message}`;
    }
    console.log(`  …第 ${i + 1} 次：${certInfo}`);
  }
  console.log(certOk ? `✓ ${host} HTTPS 可达（${certInfo}）` : `✗ ${host} HTTPS 不可达（${certInfo}）`);

  // ---- 6. 三态鉴权验证 ----
  const base = `https://${host}`;
  const anon = await fetch(base, { redirect: "manual", headers: { Accept: "text/html" } });
  const anonLoc = anon.headers.get("location") || "";
  console.log(`匿名访问 → ${anon.status} ${anonLoc}`);

  const bearer = await fetch(base, {
    redirect: "manual",
    headers: { Authorization: `Bearer ${user.token}`, Accept: "text/html" },
  });
  const bearerBody = await bearer.text();
  console.log(`Bearer 访问 → ${bearer.status}，正文 ${bearerBody.length} 字节`);

  const cookieRes = await fetch(base, {
    redirect: "manual",
    headers: { Cookie: `ah_session=${session.id}`, Accept: "text/html" },
  });
  const cookieBody = await cookieRes.text();
  console.log(`Cookie 访问 → ${cookieRes.status}，正文 ${cookieBody.length} 字节`);
  const hasContent = /团队数据看板|看板|dashboard/i.test(cookieBody);

  // ---- 7. 容器实况（publish 返回值里没有容器信息，直接查 Docker）----
  const { execFile } = await import("node:child_process");
  const dockerPs = await new Promise((resolve) => {
    execFile(
      "docker",
      ["ps", "--filter", `name=hub-${slug}`, "--format", "{{.Names}}|{{.Status}}|{{.Ports}}"],
      (err, stdout) => resolve(err ? "" : stdout.trim()),
    );
  });
  console.log(`容器：${dockerPs || "(未找到)"}`);

  // ---- 8. 汇总 ----
  const summary = {
    appId: pub.appId,
    slug,
    子域名: url,
    容器: dockerPs,
    证书可达: certOk,
    匿名状态码: anon.status,
    匿名跳登录: anonLoc.includes("/__hub__/auth/login"),
    Bearer状态码: bearer.status,
    Cookie状态码: cookieRes.status,
    应用内容正确: hasContent,
    sessionId: session.id,
  };
  console.log("\n=== 验证汇总 ===");
  console.log(JSON.stringify(summary, null, 1));

  const checks = [
    ["容器已启动", /Up .*healthy|Up \d/.test(dockerPs)],
    ["子域名 HTTPS 可达", certOk],
    ["匿名被拦（302 跳登录）", anon.status === 302 && summary.匿名跳登录],
    ["Bearer 放行 200", bearer.status === 200],
    ["Cookie 放行 200", cookieRes.status === 200],
    ["应用内容正确", hasContent],
  ];
  console.log("\n=== 断言 ===");
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✅" : "❌"} ${label}`);
    if (!ok) failed++;
  }
  console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项未通过 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
