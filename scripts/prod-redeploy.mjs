/**
 * 历史应用原地重建（服务器侧跑）：把 store 里固化了本机路径/死链的应用，
 * 在服务器上重新拉起容器并修正对外 URL，不新增记录、不复制源码。
 *
 * 为什么需要它：
 *   - store 里历史应用的 sourceDir 指向开发机路径（/Users/fzj/...），
 *     服务器上不存在，docker build 会直接失败；
 *   - url 固化成 http://<slug>.localhost:8080，门户点进去全是死链；
 *   - publish_app 走的是「新建应用」语义，会与旧记录重复并复制一份源码；
 *     原地重建保留原 appId / slug / 权限，不产生重复。
 *
 * 用法：
 *   node scripts/prod-redeploy.mjs                 # 全部（按 appId 升序）
 *   node scripts/prod-redeploy.mjs app_0004        # 指定单个
 *   node scripts/prod-redeploy.mjs --dry           # 只看会做什么，不实际执行
 *   node scripts/prod-redeploy.mjs --keep-failed   # 保留原本就 failed 的记录不动
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ⚠️ 环境变量必须在 import 执行器之前设好：
//    DockerExecutor 在模块加载时就把 HUB_INTERNAL_URL / HUB_TLS_CERT_RESOLVER 读成常量了。
const PROD_ENV = {
  HUB_EXECUTOR: "docker",
  HUB_DOMAIN: "unilink.icu",
  HUB_EXTERNAL_SCHEME: "https",
  HUB_PORT: "8099",
  HUB_INTERNAL_URL: "http://host.docker.internal:8099",
  HUB_TLS_CERT_RESOLVER: "le",
  HUB_COOKIE_DOMAIN: ".unilink.icu",
};
Object.assign(process.env, PROD_ENV);

const { DockerExecutor } = await import("../src/executors/docker.js");
const { load, save } = await import("../src/store.js");
const { DATA_DIR, appUrl } = await import("../src/config.js");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry");
const keepFailed = args.includes("--keep-failed");
const only = args.filter((a) => !a.startsWith("--"));

/** 服务器上源码的真实位置：优先用服务器路径，其次按 appId 回退到 data/apps/<id>/source */
function resolveSourceDir(app) {
  const candidates = [
    app.sourceDir,
    path.join(DATA_DIR, "apps", app.id, "source"),
    path.join("/opt/ai-hub", "data", "apps", app.id, "source"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  return null;
}

const store = load();
const targets = (only.length ? store.apps.filter((a) => only.includes(a.id)) : store.apps).sort((a, b) =>
  a.id.localeCompare(b.id),
);

console.log(`候选应用 ${targets.length} 个${dryRun ? "（试运行，不实际执行）" : ""}\n`);

const executor = new DockerExecutor();
const results = [];

for (const app of targets) {
  const src = resolveSourceDir(app);
  const label = `${app.id} ${app.name}（${app.type}，${app.visibility}）`;
  if (!src) {
    console.log(`  ⏭  ${label} —— 找不到源码目录，跳过`);
    results.push({ id: app.id, name: app.name, 结果: "跳过（无源码）" });
    continue;
  }
  if (keepFailed && app.status === "failed") {
    console.log(`  ⏭  ${label} —— 原状态 failed，按 --keep-failed 保留不动`);
    results.push({ id: app.id, name: app.name, 结果: "跳过（原 failed）" });
    continue;
  }
  console.log(`  ▶️  ${label}`);
  console.log(`      源码：${src}`);
  console.log(`      旧地址：${app.url}`);
  if (dryRun) {
    console.log(`      新地址：${appUrl(app.slug)}\n`);
    results.push({ id: app.id, name: app.name, 结果: "试运行" });
    continue;
  }

  // 用服务器上的真实源码目录构建。
  // 构建在临时目录里做：writeDockerfile 会把生成的 Dockerfile/nginx.conf 写进 sourceDir，
  // 原地写会污染原始源码目录（第二次跑就会误判为「项目自带 Dockerfile」）。
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), `hub-build-${app.id}-`));
  fs.cpSync(src, buildDir, {
    recursive: true,
    filter: (p) => {
      const base = path.basename(p);
      if (base === "node_modules" || base === ".git" || base === "venv" || base === ".venv" || base === "__pycache__") return false;
      // macOS AppleDouble 残留（从开发机打包带过来的 ._xxx），会污染镜像
      if (base.startsWith("._") || base === ".DS_Store") return false;
      return true;
    },
  });
  const buildApp = { ...app, sourceDir: buildDir };
  try {
    const runtime = await executor.start(buildApp);
    app.sourceDir = src;
    app.runtime = runtime;
    app.status = "running";
    app.url = appUrl(app.slug);
    delete app.error;
    console.log(`      ✅ 容器 ${runtime.container}（端口 ${runtime.port}）→ ${app.url}\n`);
    results.push({ id: app.id, name: app.name, 结果: "成功", url: app.url, 容器: runtime.container });
  } catch (e) {
    app.status = "failed";
    app.error = e.message;
    console.log(`      ❌ 失败：${e.message}\n`);
    results.push({ id: app.id, name: app.name, 结果: "失败", 错误: e.message });
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

if (!dryRun) {
  save(store);
  console.log("store.json 已更新");
}

console.log("\n=== 汇总 ===");
for (const r of results) {
  console.log(`  ${r.结果.padEnd(4, "　")} ${r.id} ${r.name}${r.url ? " → " + r.url : r.错误 ? " → " + r.错误 : ""}`);
}
const ok = results.filter((r) => r.结果 === "成功").length;
const bad = results.filter((r) => r.结果 === "失败").length;
console.log(`\n成功 ${ok} · 失败 ${bad} · 跳过 ${results.length - ok - bad}`);
process.exit(bad === 0 ? 0 : 1);
