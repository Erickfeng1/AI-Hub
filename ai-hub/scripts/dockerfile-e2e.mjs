import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startRouter } from "../src/router.js";
import { HUB_ROOT, HUB_PORT } from "../src/config.js";
import { generateDockerfile, writeDockerfile, DOCKER_PORTS } from "../src/dockerfile.js";
import { hubLogin } from "./e2e-login.mjs";

const MCP_SERVER = path.join(HUB_ROOT, "src", "mcp-server.js");
const HUB = `http://localhost:${HUB_PORT}`;
const TMP = "/tmp/ah-dockerfile-e2e";

function section(title) {
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}

let passed = 0;
function check(label, cond, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) throw new Error(`断言失败: ${label}`);
  passed++;
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`工具 ${name} 返回错误: ${res.content?.[0]?.text}`);
  const text = res.content?.[0]?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 把 fixture 复制到临时目录并生成 Dockerfile，返回 { dir, result } */
function genFor(fixture, type) {
  const dir = path.join(TMP, fixture);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(HUB_ROOT, "fixtures", fixture), dir, { recursive: true });
  const app = { id: "app_9001", type, sourceDir: dir };
  const result = writeDockerfile(app);
  const dockerfile = fs.readFileSync(path.join(dir, "Dockerfile"), "utf8");
  return { dir, result, dockerfile };
}

/** dev Provider 走 dev-login；其他 Provider 回退到门户已有用户（cookie 为 null 时用 Bearer） */
async function devLogin(name, department) {
  const { user, cookie } = await hubLogin(name, department);
  return { ...user, cookie };
}

async function main() {
  section("第 0 步 · 启动中台（若已在运行则自动复用）");
  startRouter();

  section("第 1 步 · 静态应用 → nginx 镜像");
  const s = genFor("demo-app", "static");
  check("effectiveType=static / 端口 8080", s.result.effectiveType === "static" && s.result.port === 8080);
  check("基于 nginx:alpine", /FROM nginx:[\d.]+-alpine/.test(s.dockerfile));
  check("拷贝站点目录", s.dockerfile.includes("COPY . /usr/share/nginx/html"));
  check("附带 SPA 友好 nginx.conf（监听 8080 非特权端口）", fs.existsSync(path.join(s.dir, "nginx.conf")) && /listen 8080/.test(fs.readFileSync(path.join(s.dir, "nginx.conf"), "utf8")));
  check("非 root 运行（USER nginx）", /USER nginx/.test(s.dockerfile));
  check("EXPOSE 8080", /EXPOSE 8080/.test(s.dockerfile));

  section("第 2 步 · Node 应用（无锁文件）→ node:alpine + npm install");
  const n = genFor("node-app", "node");
  check("effectiveType=node / 端口 3000", n.result.effectiveType === "node" && n.result.port === 3000);
  check("基于 node:alpine", /FROM node:\d+-alpine/.test(n.dockerfile));
  check("无锁文件时用 npm install", /npm install --omit=dev/.test(n.dockerfile));
  check("依赖层与代码层分离（构建缓存）", /COPY package\.json \.\//.test(n.dockerfile) && n.dockerfile.indexOf("COPY package.json") < n.dockerfile.indexOf("COPY --chown"));
  check("非 root 运行（USER node）", /USER node/.test(n.dockerfile));
  check("清理 npm 缓存", /npm cache clean --force/.test(n.dockerfile));
  check("EXPOSE 3000 + ENV PORT", /EXPOSE 3000/.test(n.dockerfile) && /ENV PORT=3000/.test(n.dockerfile));
  check("CMD 走 npm start（scripts.start）", /CMD \["npm", "start"\]/.test(n.dockerfile));

  section("第 3 步 · Node 应用（有锁文件）→ npm ci 确定性安装");
  const lockedDir = path.join(TMP, "node-app-locked");
  fs.rmSync(lockedDir, { recursive: true, force: true });
  fs.cpSync(path.join(HUB_ROOT, "fixtures", "node-app"), lockedDir, { recursive: true });
  fs.writeFileSync(path.join(lockedDir, "package-lock.json"), "{}");
  const locked = generateDockerfile({ type: "node", sourceDir: lockedDir });
  check("有 package-lock.json 时用 npm ci", /npm ci --omit=dev/.test(locked.dockerfile), locked.dockerfile.split("\n").find((l) => l.includes("npm c")) || "");

  section("第 4 步 · Python 应用（Flask）→ python:slim + venv");
  const p = genFor("python-app", "python");
  check("effectiveType=python / 端口 8000", p.result.effectiveType === "python" && p.result.port === 8000);
  check("基于 python:slim", /FROM python:[\d.]+-slim/.test(p.dockerfile));
  check("venv 隔离安装", /python -m venv \/opt\/venv/.test(p.dockerfile) && /pip install --no-cache-dir -r requirements\.txt/.test(p.dockerfile));
  check("创建并切换到非 root 用户", /useradd --create-home --uid 10001 appuser/.test(p.dockerfile) && /USER appuser/.test(p.dockerfile));
  check("EXPOSE 8000 + PATH 指向 venv", /EXPOSE 8000/.test(p.dockerfile) && /ENV PATH="\/opt\/venv\/bin:\$PATH"/.test(p.dockerfile));
  check("CMD 启动 Flask 入口", /CMD \["\/opt\/venv\/bin\/python", "app\.py"\]/.test(p.dockerfile));

  section("第 5 步 · 降级规则与 local 执行器一致");
  // Node 项目无入口 → nginx 静态镜像（与 local 的 startNode 降级一致）
  const noEntryDir = path.join(TMP, "node-noentry");
  fs.rmSync(noEntryDir, { recursive: true, force: true });
  fs.mkdirSync(noEntryDir, { recursive: true });
  fs.writeFileSync(path.join(noEntryDir, "package.json"), JSON.stringify({ name: "lib-only", private: true }));
  const noEntry = generateDockerfile({ type: "node", sourceDir: noEntryDir });
  check("Node 无入口降级为 nginx 静态", noEntry.effectiveType === "static" && /FROM nginx/.test(noEntry.dockerfile));
  // Python 无框架 → 同样降级
  const noPyDir = path.join(TMP, "py-noframework");
  fs.rmSync(noPyDir, { recursive: true, force: true });
  fs.mkdirSync(noPyDir, { recursive: true });
  fs.writeFileSync(path.join(noPyDir, "requirements.txt"), "requests\n");
  const noPy = generateDockerfile({ type: "python", sourceDir: noPyDir });
  check("Python 无框架降级为 nginx 静态", noPy.effectiveType === "static" && /FROM nginx/.test(noPy.dockerfile));

  section("第 6 步 · 项目自带 Dockerfile 时尊重原样（端口从 EXPOSE 推断）");
  const ownDir = path.join(TMP, "own-dockerfile");
  fs.rmSync(ownDir, { recursive: true, force: true });
  fs.mkdirSync(ownDir, { recursive: true });
  fs.writeFileSync(path.join(ownDir, "Dockerfile"), "FROM alpine\nEXPOSE 9000\nCMD [\"sleep\", \"1\"]\n");
  const own = generateDockerfile({ type: "docker", sourceDir: ownDir });
  check("推断 EXPOSE 端口 9000", own.port === 9000, `port=${own.port}`);
  fs.writeFileSync(path.join(ownDir, "Dockerfile"), "FROM alpine\nCMD [\"sleep\", \"1\"]\n");
  check("无 EXPOSE 时默认 80", generateDockerfile({ type: "docker", sourceDir: ownDir }).port === 80);
  check("降级静态同样用 8080 + USER nginx", /EXPOSE 8080/.test(noEntry.dockerfile) && /USER nginx/.test(noEntry.dockerfile));

  section("第 7 步 · infra 编排文件通过 docker compose config 校验");
  const composeFile = path.join(HUB_ROOT, "infra", "docker-compose.yml");
  const envFile = path.join(HUB_ROOT, "infra", ".env");
  const hadEnv = fs.existsSync(envFile);
  if (!hadEnv) fs.copyFileSync(path.join(HUB_ROOT, "infra", ".env.example"), envFile); // full profile 的 hub 需要 env_file
  try {
    const composeOut = execFileSync("docker", ["compose", "-f", composeFile, "config"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const composeFull = execFileSync("docker", ["compose", "-f", composeFile, "--profile", "full", "config"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    check("默认渲染出 traefik 服务", /^ {2}traefik:/m.test(composeOut));
    check("hub 默认不在编排内（profile 隔离）", !/^ {2}hub:/m.test(composeOut));
    check("--profile full 渲染出 hub 且 HUB_EXECUTOR=docker", /^ {2}hub:/m.test(composeFull) && /HUB_EXECUTOR: docker/.test(composeFull));
    check("compose 定义 hub-net 网络", /hub-net/.test(composeOut));
  } finally {
    if (!hadEnv) fs.rmSync(envFile, { force: true });
  }

  section("第 8 步 · authz 鉴权端点契约（Traefik forwardAuth 回调，无需 Docker）");
  const fang = await devLogin("方科", "商务部");
  const li = await devLogin("小李", "广告执行部");
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_SERVER], env: { ...process.env } });
  const client = new Client({ name: "dockerfile-demo", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const conn = await call(client, "connect", { agentName: "DockerfileDemo", userToken: fang.token });
  const pub = await call(client, "publish_app", {
    projectPath: path.join(HUB_ROOT, "fixtures", "demo-app"),
    appName: "鉴权契约测试应用",
    visibility: "self",
    agentToken: conn.token,
  });
  const slug = new URL(pub.子域名).hostname.split(".")[0];
  console.log(`已发布: ${pub.子域名}（self 权限）`);

  const anon = await fetch(`${HUB}/__hub__/authz?host=${slug}.localhost:8080`);
  check("匿名 → 401", anon.status === 401, `HTTP ${anon.status}`);
  const deny = await fetch(`${HUB}/__hub__/authz?host=${slug}.localhost:8080`, { headers: { Authorization: `Bearer ${li.token}` } });
  check("越权 → 403", deny.status === 403, `HTTP ${deny.status}`);
  const allow = await fetch(`${HUB}/__hub__/authz?host=${slug}.localhost:8080`, { headers: { Authorization: `Bearer ${fang.token}` } });
  check(
    "发布者 → 200 且透传 X-Forwarded-User（百分号编码）",
    allow.status === 200 && decodeURIComponent(allow.headers.get("x-forwarded-user") || "") === "方科",
    `HTTP ${allow.status} · ${allow.headers.get("x-forwarded-user")}`,
  );
  const unknown = await fetch(`${HUB}/__hub__/authz?host=not-exist.localhost:8080`, { headers: { Authorization: `Bearer ${fang.token}` } });
  check("未知应用 → 404", unknown.status === 404, `HTTP ${unknown.status}`);
  const htmlNav = await fetch(`${HUB}/__hub__/authz?host=${slug}.localhost:8080`, { headers: { accept: "text/html" }, redirect: "manual" });
  check("浏览器导航 → 302 登录页", htmlNav.status === 302 && (htmlNav.headers.get("location") || "").includes("/__hub__/auth/login"), `HTTP ${htmlNav.status}`);

  await call(client, "unpublish_app", { appId: pub.appId, agentToken: conn.token });
  await client.close();

  section(`Docker 生产运行时验证通过 · ${passed} 项断言`);
  process.exit(0);
}

main().catch((e) => {
  console.error("演示失败:", e);
  process.exit(1);
});
