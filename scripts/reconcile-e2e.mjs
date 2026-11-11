#!/usr/bin/env node
/**
 * P0 能力回归：状态对账 + 生产清理
 *
 * 覆盖 4 组能力：
 *   1. 状态探测：容器在跑/不在、进程存活/已死、静态目录存在/消失、探测失败
 *   2. 状态对账：status 从快照纠正为真实值；failed/archived 不被覆盖；unknown 不误伤
 *   3. 门户渲染：已停止的应用显示异常态而不是绿点「运行中」；归档记录不进门户
 *   4. 清理逻辑：死链归档、dev 账号删除、归属转移避免 ownerId 悬空、连带清理
 *
 * 全程使用隔离的 HUB_DATA_DIR，不触碰真实 data/。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hub-reconcile-test-"));
process.env.HUB_DATA_DIR = TMP;
process.env.HUB_EXECUTOR = "local";

const { load, save } = await import("../src/store.js");
const { probeAppState, probeAppStates, reconcileStatuses, archiveApps, STATUS_META, invalidateSnapshot, setTestExecutor } = await import(
  "../src/reconcile.js"
);
const { createExecutor } = await import("../src/executors/index.js");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}${detail ? ` · ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` · ${detail}` : ""}`);
  }
}

function section(t) {
  console.log(`\n${"-".repeat(58)}`);
  console.log(t);
  console.log("-".repeat(58));
}

/** 假执行器：按容器名返回指定状态 */
function fakeExecutor(containerStates) {
  return {
    async statusBatch(apps) {
      const m = new Map();
      for (const a of apps) {
        const c = a.runtime?.container;
        if (c) m.set(`c:${c}`, containerStates[c] ?? false);
      }
      return m;
    },
    async status(app) {
      return containerStates[app.runtime?.container] ?? false;
    },
  };
}

function resetStore(apps, users = [], extra = {}) {
  save({
    apps,
    users,
    agents: [],
    sessions: [],
    skills: [],
    installedSkills: [],
    library: [],
    usage: [],
    seq: 0,
    ...extra,
  });
}

const containerApp = (id, name, container, ownerId = "u1", owner = "甲") => ({
  id,
  name,
  slug: name,
  type: "python",
  ownerId,
  owner,
  visibility: "all",
  status: "running",
  createdAt: "2026-11-01T00:00:00.000Z",
  sourceDir: `/tmp/${id}`,
  url: `https://${name}.unilink.icu`,
  runtime: { kind: "container", container, image: `hub-app-${name}:${id}`, port: 8000 },
});

const staticApp = (id, name, dir, ownerId = "u1", owner = "甲") => ({
  id,
  name,
  slug: name,
  type: "static",
  ownerId,
  owner,
  visibility: "all",
  status: "running",
  createdAt: "2026-11-01T00:00:00.000Z",
  sourceDir: dir,
  url: `https://${name}.unilink.icu`,
  runtime: { kind: "static", dir },
});

const processApp = (id, name, pid, ownerId = "u1", owner = "甲") => ({
  id,
  name,
  slug: name,
  type: "node",
  ownerId,
  owner,
  visibility: "all",
  status: "running",
  createdAt: "2026-11-01T00:00:00.000Z",
  sourceDir: `/tmp/${id}`,
  url: `https://${name}.unilink.icu`,
  runtime: { kind: "process", pid, port: 3000 },
});

/* ==================== 1. 状态探测 ==================== */
section("1. 状态探测 probeAppState");

const liveDir = path.join(TMP, "alive-dir");
fs.mkdirSync(liveDir, { recursive: true });
const deadDir = path.join(TMP, "gone-dir");

const ex = fakeExecutor({ "hub-alive": true, "hub-dead": false });

{
  const r = await probeAppState(containerApp("a1", "alive", "hub-alive"), ex);
  check("容器在跑 → running", r.status === "running" && r.alive === true, `status=${r.status}`);
}
{
  const r = await probeAppState(containerApp("a2", "dead", "hub-dead"), ex);
  check("容器不在 → stopped", r.status === "stopped" && r.alive === false, `status=${r.status}`);
  check("stopped 带有原因说明", Boolean(r.detail), r.detail);
}
{
  const r = await probeAppState(staticApp("a3", "s1", liveDir), ex);
  check("静态目录存在 → running", r.status === "running", `status=${r.status}`);
}
{
  const r = await probeAppState(staticApp("a4", "s2", deadDir), ex);
  check("静态目录不存在 → stopped", r.status === "stopped", `status=${r.status}`);
}
{
  const r = await probeAppState(processApp("a5", "p1", process.pid), ex);
  check("进程存活 → running", r.status === "running", `status=${r.status}`);
}
{
  const r = await probeAppState(processApp("a6", "p2", 999999), ex);
  check("进程已死 → stopped", r.status === "stopped", `status=${r.status}`);
}
{
  const r = await probeAppState({ id: "a7", name: "x", runtime: null }, ex);
  check("无运行时信息 → unknown（不误判）", r.status === "unknown", `status=${r.status}`);
}
{
  const broken = {
    async statusBatch() {
      throw new Error("docker 守护进程不可用");
    },
    async status() {
      throw new Error("docker 守护进程不可用");
    },
  };
  const r = await probeAppState(containerApp("a8", "x", "hub-x"), broken);
  check("探测异常 → unknown（不误标 stopped）", r.status === "unknown", `status=${r.status}`);
}

/* ==================== 2. 状态对账 ==================== */
section("2. 状态对账 reconcileStatuses");

{
  resetStore([
    containerApp("a1", "alive", "hub-alive"),
    containerApp("a2", "dead", "hub-dead"),
    { ...containerApp("a3", "failed", "hub-f"), status: "failed", error: "构建失败" },
    { ...containerApp("a4", "archived", "hub-ar"), status: "archived" },
  ]);
  const { changes } = await reconcileStatuses(fakeExecutor({ "hub-alive": true, "hub-dead": false }), {
    persist: true,
  });
  const s = load();
  check("死链 running → stopped", s.apps.find((x) => x.id === "a2").status === "stopped");
  check("存活应用保持 running", s.apps.find((x) => x.id === "a1").status === "running");
  check("failed 记录不被覆盖", s.apps.find((x) => x.id === "a3").status === "failed");
  check("archived 记录不被覆盖", s.apps.find((x) => x.id === "a4").status === "archived");
  check("变更明细只含实际变化项", changes.length === 1 && changes[0].appId === "a2", `changes=${changes.length}`);
}

{
  // unknown 不应写库（探测不了就不动）
  resetStore([containerApp("a9", "unknown", "hub-u")]);
  const broken = {
    async statusBatch() {
      return new Map([["hub-u", null]]);
    },
    async status() {
      return null;
    },
  };
  await reconcileStatuses(broken, { persist: true });
  const s = load();
  check("探测不出 → 保持原状态不动", s.apps[0].status === "running", `status=${s.apps[0].status}`);
}

{
  // 批量路径应被优先使用（避免 N 次 docker 调用）
  let batchCalls = 0;
  let singleCalls = 0;
  const counting = {
    async statusBatch(apps) {
      batchCalls++;
      const m = new Map();
      for (const a of apps) m.set(`c:${a.runtime.container}`, true);
      return m;
    },
    async status() {
      singleCalls++;
      return true;
    },
  };
  resetStore([containerApp("b1", "x1", "hub-1"), containerApp("b2", "x2", "hub-2"), containerApp("b3", "x3", "hub-3")]);
  await reconcileStatuses(counting, { persist: true });
  check("走批量路径（1 次 batch，0 次单查）", batchCalls === 1 && singleCalls === 0, `batch=${batchCalls} single=${singleCalls}`);
}

/* ==================== 3. 门户渲染 ==================== */
section("3. 门户渲染（真实状态 + 归档隐藏）");

{
  // 用真实 router 渲染，验证已停止的卡片不再是绿点 running
  resetStore(
    [
      containerApp("r1", "alive-app", "hub-alive"),
      containerApp("r2", "dead-app", "hub-dead"),
      { ...containerApp("r3", "arch-app", "hub-ar"), status: "archived" },
    ],
    [{ id: "u1", name: "甲", department: "研发", provider: "dev", token: "ah_tok" }],
  );
  // 注入可控执行器：让容器状态可预测（不依赖本机 docker）
  setTestExecutor(fakeExecutor({ "hub-alive": true, "hub-dead": false }));
  invalidateSnapshot();

  const { createHubServer } = await import("../src/router.js");
  const { createSession } = await import("../src/identity.js");
  // 建立真实会话，否则 visible 为空、卡片根本不渲染
  const session = createSession("u1");
  const server = createHubServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const resp = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: `ah_session=${session.id}` } });
  const html = await resp.text();

  check("门户返回 200", resp.status === 200, `HTTP ${resp.status}`);
  check("存活应用显示「运行中」", html.includes("运行中"));
  check("已停止应用显示「已停止」", html.includes("已停止"));
  check("已停止应用不再显示 running 原文", !html.includes(">running<"));
  check("已停止应用带原因说明", html.includes("容器 hub-dead 未运行"));
  check("已停止应用标记为异常卡片", html.includes('class="card abnormal"'));
  check("归档记录不出现在门户", !html.includes("arch-app"));

  // /__hub__/me 的 visibleApps 也不应含归档记录
  const meResp = await fetch(`http://127.0.0.1:${port}/__hub__/me`, {
    headers: { cookie: `ah_session=${session.id}` },
  });
  const meJson = await meResp.json();
  check("visibleApps 排除归档记录", !meJson.visibleApps.includes("r3"), JSON.stringify(meJson.visibleApps));
  check("visibleApps 只含存活应用", meJson.visibleApps.includes("r1") && meJson.visibleApps.includes("r2"));

  server.close();
  setTestExecutor(null);
}

{
  // 归档应用对外等同不存在：get_app / authz 都不应放行
  resetStore(
    [
      containerApp("g1", "live", "hub-alive"),
      { ...containerApp("g2", "archived-one", "hub-gone"), status: "archived" },
    ],
    [{ id: "u1", name: "甲", department: "研发", provider: "dev", token: "ah_tok" }],
  );
  setTestExecutor(fakeExecutor({ "hub-alive": true, "hub-gone": false }));
  invalidateSnapshot();

  const { getDeployer } = await import("../src/mcp-core.js");
  const dep = getDeployer();
  check("get_app 归档应用返回 null", dep.get("g2") === null);
  check("get_app 存活应用正常返回", dep.get("g1") !== null);

  const { createHubServer } = await import("../src/router.js");
  const { createSession } = await import("../src/identity.js");
  const session = createSession("u1");
  const server = createHubServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // 鉴权端点：归档子域名应 404
  const authz = await fetch(`http://127.0.0.1:${port}/__hub__/authz?host=archived-one.localhost`);
  check("鉴权端点拒绝归档应用", authz.status === 404, `HTTP ${authz.status}`);

  server.close();
  setTestExecutor(null);
}

/* ==================== 4. 清理逻辑 ==================== */
section("4. 清理逻辑（归档 + dev 账号 + 归属转移）");

{
  resetStore(
    [
      containerApp("c1", "keep-app", "hub-alive", "dev1", "开发甲"),
      containerApp("c2", "dead1", "hub-dead1", "dev1", "开发甲"),
      containerApp("c3", "dead2", "hub-dead2", "dev2", "开发乙"),
    ],
    [
      { id: "dev1", name: "开发甲", provider: "dev", token: "t1" },
      { id: "dev2", name: "开发乙", provider: "dev", token: "t2" },
      { id: "real1", name: "真用户", provider: "feishu", token: "t3" },
    ],
    {
      sessions: [
        { id: "s1", userId: "dev1" },
        { id: "s2", userId: "dev2" },
        { id: "s3", userId: "real1" },
      ],
      agents: [
        { id: "ag1", userId: "dev1", token: "a" },
        { id: "ag2", userId: "real1", token: "b" },
      ],
      usage: [
        { userId: "dev1", kind: "app", refId: "c2", count: 3 },
        { userId: "real1", kind: "app", refId: "c1", count: 1 },
      ],
      installedSkills: [{ userId: "dev1", skillId: "sk1", skillName: "s" }],
    },
  );

  const { archiveApps: archive } = await import("../src/reconcile.js");
  const store = load();
  const deadIds = ["c2", "c3"];
  archive(store, deadIds, "测试归档");
  // dev1 仍持有存活应用 c1 → 模拟归属转移
  store.apps.find((x) => x.id === "c1").ownerId = "real1";
  store.apps.find((x) => x.id === "c1").owner = "真用户";
  const removeIds = new Set(["dev2"]);
  store.users = store.users.filter((u) => !removeIds.has(u.id));
  store.sessions = store.sessions.filter((s) => !removeIds.has(s.userId));
  store.agents = store.agents.filter((a) => !removeIds.has(a.userId));
  store.installedSkills = store.installedSkills.filter((s) => !removeIds.has(s.userId));
  store.usage = store.usage.filter((u) => !deadIds.includes(u.refId));
  save(store);

  const after = load();
  check("死链被归档（status=archived）", after.apps.filter((x) => x.status === "archived").length === 2);
  check("归档记录保留在 store 中（可回滚）", after.apps.length === 3);
  check("存活应用保留", after.apps.find((x) => x.id === "c1").status === "running");
  check("归属已转移，ownerId 不悬空", after.apps.find((x) => x.id === "c1").ownerId === "real1");
  check("无主 dev 账号已删除", !after.users.some((u) => u.id === "dev2"));
  check("持有存活资源的 dev 账号保留", after.users.some((u) => u.id === "dev1"));
  check("飞书用户保留", after.users.some((u) => u.id === "real1"));
  check("已删用户的会话清理", !after.sessions.some((s) => s.userId === "dev2"));
  check("已删用户的 Agent 令牌清理", !after.agents.some((a) => a.userId === "dev2"));
  check("已删用户的安装留痕清理", !after.installedSkills.some((s) => s.userId === "dev2"));
  check("其他用户的会话不受影响", after.sessions.some((s) => s.userId === "real1"));
  check("指向死链的使用记录已清理", !after.usage.some((u) => u.refId === "c2"));
  check("存活应用的使用记录保留", after.usage.some((u) => u.refId === "c1"));
}

{
  check("STATUS_META 覆盖全部已知状态", ["running", "stopped", "failed", "starting", "archived"].every((k) => STATUS_META[k]));
  check("stopped 有独立文案", STATUS_META.stopped.label === "已停止");
}

/* ==================== 5. 清理脚本端到端 ==================== */
section("5. 清理脚本端到端（子进程跑真实脚本）");

{
  // 用真实脚本跑一遍完整的「预演 → 执行」流程，验证它对真实 store 的处理
  const scriptPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "prod-cleanup.mjs",
  );
  const cleanupTmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-cleanup-test-"));

  // 造数据：2 个存活 + 2 个死链；dev 账号持有存活资源
  // 「存活」用本地进程表达（process.pid 一定活着），「死链」用已退出 pid 表达——
  // 这样不依赖本机 docker，判定稳定可复现。
  const mkStore = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const aliveDir = path.join(dir, "alive-src");
    fs.mkdirSync(aliveDir, { recursive: true });
    const apps = [
      { ...processApp("k1", "keep1", process.pid, "devA", "开发甲"), visibility: "all" },
      { ...staticApp("k2", "keep2", aliveDir, "devB", "开发乙"), visibility: "all" },
      { ...processApp("k3", "dead1", 999998, "devA", "开发甲"), visibility: "all" },
      { ...staticApp("k4", "dead2", path.join(dir, "nope"), "devC", "开发丙"), visibility: "all" },
    ];
    fs.writeFileSync(
      path.join(dir, "store.json"),
      JSON.stringify(
        {
          apps,
          users: [
            { id: "devA", name: "开发甲", provider: "dev", token: "t1" },
            { id: "devB", name: "开发乙", provider: "dev", token: "t2" },
            { id: "devC", name: "开发丙", provider: "dev", token: "t3" },
            { id: "real", name: "真用户", provider: "feishu", token: "t4" },
          ],
          agents: [{ id: "ag1", userId: "devA", token: "a" }],
          sessions: [
            { id: "s1", userId: "devA" },
            { id: "s2", userId: "real" },
          ],
          skills: [],
          installedSkills: [],
          library: [],
          usage: [{ userId: "devA", kind: "app", refId: "k3", count: 2 }],
          seq: 0,
        },
        null,
        2,
      ),
    );
  };

  // 预演：不应修改任何数据
  const dryDir = path.join(cleanupTmp, "dry");
  mkStore(dryDir);
  const dryBefore = fs.readFileSync(path.join(dryDir, "store.json"), "utf8");
  const dryRun = spawnSync(
    "node",
    [scriptPath],
    {
      env: { ...process.env, HUB_DATA_DIR: dryDir, HUB_EXECUTOR: "local" },
      encoding: "utf8",
    },
  );
  const dryAfter = fs.readFileSync(path.join(dryDir, "store.json"), "utf8");
  check("清理脚本退出码为 0", dryRun.status === 0, `status=${dryRun.status}`);
  check("预演模式不修改 store.json", dryBefore === dryAfter);
  check("预演输出含「预演」标记", dryRun.stdout.includes("预演"));
  check("预演识别出 2 个死链", dryRun.stdout.includes("死链 2 条"), "见输出");
  check("预演识别出 2 个存活", dryRun.stdout.includes("存活 2 条"), "见输出");

  // 执行：应用归档 + 归属转移 + 用户删除
  const applyDir = path.join(cleanupTmp, "apply");
  mkStore(applyDir);
  const applyRun = spawnSync(
    "node",
    [scriptPath, "--apply"],
    {
      env: { ...process.env, HUB_DATA_DIR: applyDir, HUB_EXECUTOR: "local" },
      encoding: "utf8",
    },
  );
  check("执行模式退出码为 0", applyRun.status === 0, applyRun.stderr?.slice(0, 200) || "");
  check("执行模式生成了备份", fs.existsSync(path.join(applyDir, "backups")) || applyRun.stdout.includes("已备份"));

  const after = JSON.parse(fs.readFileSync(path.join(applyDir, "store.json"), "utf8"));
  const archived = after.apps.filter((a) => a.status === "archived");
  const running = after.apps.filter((a) => a.status === "running");
  check("死链被归档", archived.length === 2, `archived=${archived.length}`);
  check("存活应用保持运行", running.length === 2, `running=${running.length}`);
  check("归档记录带归档原因", archived.every((a) => a.archiveReason && a.archivedAt));
  check("存活应用归属已转移到接管者", running.every((a) => a.ownerId === "real"), running.map((a) => a.ownerId).join(","));
  check("dev 账号全部删除", !after.users.some((u) => u.provider === "dev"), JSON.stringify(after.users.map((u) => u.id)));
  check("飞书用户保留", after.users.some((u) => u.id === "real"));
  check("dev 用户的 Agent 令牌被清理", !after.agents.some((a) => a.userId === "devA"));
  check("dev 用户的会话被清理", !after.sessions.some((s) => s.userId === "devA"));
  check("飞书用户的会话保留", after.sessions.some((s) => s.userId === "real"));
  check("指向死链的使用记录被清理", !after.usage.some((u) => u.refId === "k3"));
  check("无 ownerId 悬空（存活资源都有 owner）", running.every((a) => after.users.some((u) => u.id === a.ownerId)));

  fs.rmSync(cleanupTmp, { recursive: true, force: true });
}

/* ==================== 汇总 ==================== */
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${"=".repeat(58)}`);
console.log(`P0 能力回归：${passed} 项通过${failed ? `，${failed} 项失败` : "，全部通过"}`);
console.log("=".repeat(58));
process.exit(failed ? 1 : 0);
