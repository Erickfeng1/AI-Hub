#!/usr/bin/env node
/**
 * 生产数据清理：归档死链应用 + 清理 dev 测试账号
 *
 * 背景（2026-11-02 复检发现）：
 *   - store.apps 24 条里 19 条是本地 e2e 反复发布留下的同一份 demo 看板副本，
 *     其 url 固化指向开发机地址（http://xxx.localhost:8080），搬到服务器后必然是死链；
 *     其中 14 条 visibility=all，任何登录员工都能看到这些点不开的卡片。
 *   - store.users 8 个里有 7 个是 provider=dev 的测试账号（飞书登录入口虽已关闭，
 *     但记录与 userToken 仍在库中）。
 *
 * 处理原则（刻意保守）：
 *   1. **归档而非删除**：死链记录标记 status=archived 并写明原因与时间，
 *      数据仍在 store 里可查，随时可回滚。归档记录不再进门户展示。
 *   2. **只清 dev 账号，且不误伤存活资源**：
 *      存活应用中有一部分归属于 dev 账号（如 app_0006 属于 user_0002），
 *      直接删用户会让这些应用的 ownerId 悬空 → 没人能再下架它们。
 *      因此 dev 账号若仍持有存活资源，会先**转移归属**给指定接管者再删除。
 *   3. **先备份**：任何写操作前自动备份 store.json 到 data/backups/。
 *   4. **默认 dry-run**：不带 --apply 时只打印将要做的改动，不落盘。
 *
 * 用法：
 *   node scripts/prod-cleanup.mjs                     # 预演（默认，不改数据）
 *   node scripts/prod-cleanup.mjs --apply             # 执行清理
 *   node scripts/prod-cleanup.mjs --apply --takeover 冯哲君   # 指定 dev 资源接管者
 *   node scripts/prod-cleanup.mjs --keep-dev-users    # 保留 dev 账号，只归档死链
 *   node scripts/prod-cleanup.mjs --archive-only      # 只归档死链，不动用户
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../src/config.js";
import { load, save } from "../src/store.js";
import { nowIso } from "../src/util.js";
import { archiveApps, probeAppStates, invalidateSnapshot } from "../src/reconcile.js";
import { createExecutor } from "../src/executors/index.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const KEEP_DEV_USERS = args.includes("--keep-dev-users");
const ARCHIVE_ONLY = args.includes("--archive-only");
const takeoverIdx = args.indexOf("--takeover");
const TAKEOVER = takeoverIdx >= 0 ? args[takeoverIdx + 1] : null;

/** 死链判定：记录说在跑，但运行时探测不到它 */
function isDead(app, liveStates) {
  const st = liveStates?.get(app.id);
  if (!st) return false;
  // 探测不出来（unknown）不判死——避免因 docker 临时异常误伤
  if (st.status === "unknown") return false;
  return st.status !== "running";
}

async function main() {
  console.log(`\n${"=".repeat(62)}`);
  console.log("生产数据清理 · 死链归档 + dev 账号清理");
  console.log(`${"=".repeat(62)}`);
  console.log(`模式：${APPLY ? "执行（--apply）" : "预演（dry-run，不改数据）"}`);
  console.log(`数据目录：${DATA_DIR}`);

  const store = load();
  const executor = createExecutor();
  const apps = store.apps || [];

  console.log(`\n当前：应用 ${apps.length} 条 · 用户 ${(store.users || []).length} 个`);

  // ---------- 第一步：探测真实状态，找出死链 ----------
  const liveStates = await probeAppStates(apps, executor, { force: true });
  const dead = apps.filter((a) => a.status !== "archived" && isDead(a, liveStates));
  const alive = apps.filter((a) => a.status !== "archived" && !isDead(a, liveStates));

  console.log(`\n${"-".repeat(62)}`);
  console.log(`探测结果：存活 ${alive.length} 条 · 死链 ${dead.length} 条`);
  console.log("-".repeat(62));

  if (alive.length) {
    console.log("\n存活应用（保留）：");
    for (const a of alive) {
      const st = liveStates.get(a.id);
      console.log(`  ✓ ${a.id}  ${a.name.padEnd(18)} ${a.url}`);
      console.log(`      状态=${st?.status}  发布者=${a.owner}(${a.ownerId})  权限=${a.visibility}`);
    }
  }

  if (dead.length) {
    console.log(`\n死链应用（将归档）：`);
    const byVis = {};
    for (const a of dead) byVis[a.visibility] = (byVis[a.visibility] || 0) + 1;
    console.log(`  权限分布：${Object.entries(byVis).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    for (const a of dead.slice(0, 25)) {
      console.log(`  ✗ ${a.id}  ${String(a.name).padEnd(16)} ${a.url}`);
    }
    if (dead.length > 25) console.log(`  ... 其余 ${dead.length - 25} 条省略`);
  }

  // ---------- 第二步：dev 账号清理方案 ----------
  const devUsers = (store.users || []).filter((u) => u.provider === "dev");
  const feishuUsers = (store.users || []).filter((u) => u.provider !== "dev");

  // 找出仍被存活资源引用的 dev 用户（这些不能直接删，否则 ownerId 悬空）
  const referencedDevIds = new Set();
  for (const a of alive) {
    if (a.ownerId) referencedDevIds.add(a.ownerId);
  }
  for (const s of store.skills || []) {
    if (s.ownerId) referencedDevIds.add(s.ownerId);
  }
  for (const l of store.library || []) {
    if (l.ownerId) referencedDevIds.add(l.ownerId);
  }
  const takeoverId = TAKEOVER
    ? (store.users || []).find((u) => u.name === TAKEOVER)?.id
    : feishuUsers[0]?.id;
  const takeoverUser = (store.users || []).find((u) => u.id === takeoverId);

  let plan = { archive: [], removeUsers: [], reassign: [], removeSessions: 0, removeAgents: 0, removeUsage: 0, removeInstalled: 0 };
  plan.archive = dead.map((a) => a.id);

  if (!ARCHIVE_ONLY && !KEEP_DEV_USERS && devUsers.length) {
    console.log(`\n${"-".repeat(62)}`);
    console.log("dev 账号清理");
    console.log("-".repeat(62));

    if (!takeoverUser) {
      console.log("\n⚠️  有存活资源归属于 dev 账号，但找不到接管者（没有非 dev 用户）。");
      console.log("    请用 --takeover <用户名> 指定接管者。本次跳过 dev 用户清理。");
    } else {
      // 归属转移：所有 dev 账号持有的**存活**资源都要转移给接管者，
      // 否则删掉 dev 用户后这些资源的 ownerId 悬空 → 没人能再下架它们。
      // （死链资源会被归档，不需要转移）
      const devUserIds = new Set(devUsers.map((u) => u.id));
      const reassignTargets = [];
      for (const a of alive) {
        if (a.ownerId && devUserIds.has(a.ownerId) && a.ownerId !== takeoverId) {
          reassignTargets.push({ kind: "app", id: a.id, name: a.name, from: a.owner, fromId: a.ownerId });
        }
      }
      for (const s of store.skills || []) {
        if (s.ownerId && devUserIds.has(s.ownerId) && s.ownerId !== takeoverId) {
          reassignTargets.push({ kind: "skill", id: s.id, name: s.name, from: s.owner, fromId: s.ownerId });
        }
      }
      for (const l of store.library || []) {
        if (l.ownerId && devUserIds.has(l.ownerId) && l.ownerId !== takeoverId) {
          reassignTargets.push({ kind: "library", id: l.id, name: l.name, from: l.owner, fromId: l.ownerId });
        }
      }

      if (reassignTargets.length) {
        console.log(`\n归属转移（避免 ownerId 悬空导致资源无人能管）：→ ${takeoverUser.name}(${takeoverUser.id})`);
        for (const t of reassignTargets) {
          console.log(`  → ${t.kind} ${t.id} ${t.name}：${t.from}(${t.fromId}) → ${takeoverUser.name}`);
        }
        plan.reassign = reassignTargets;
      }

      // 归属转移完成后，所有 dev 账号都不再持有任何资源 → 全部可删。
      // （转移目标是飞书用户或接管者，不会是 dev 账号，所以不会自指。）
      const removable = devUsers.filter((u) => u.id !== takeoverUser.id);
      const keepUsers = devUsers.filter((u) => u.id === takeoverUser.id);

      console.log(`\n将删除的 dev 账号（${removable.length} 个）：`);
      for (const u of removable) {
        const owns = apps.filter((a) => a.ownerId === u.id).length;
        const ownsLive = alive.filter((a) => a.ownerId === u.id).length;
        console.log(
          `  ✗ ${u.id} ${u.name}（持有 ${owns} 条应用记录，其中存活 ${ownsLive} 条${ownsLive ? "（将先转移归属）" : "，随归档一并失效"}）`,
        );
      }
      if (keepUsers.length) {
        console.log(`\n保留（作为接管者，不删除）：`);
        for (const u of keepUsers) console.log(`  · ${u.id} ${u.name}`);
      }
      plan.removeUsers = removable;

      // 连带清理：这些用户的会话、Agent 令牌、安装留痕、使用记录
      const removeUserIds = new Set(removable.map((u) => u.id));
      const deadAppIds = new Set(dead.map((a) => a.id));
      plan.removeSessions = (store.sessions || []).filter((s) => removeUserIds.has(s.userId)).length;
      plan.removeAgents = (store.agents || []).filter((a) => removeUserIds.has(a.userId)).length;
      plan.removeInstalled = (store.installedSkills || []).filter((s) => removeUserIds.has(s.userId)).length;
      plan.removeUsage = (store.usage || []).filter((u) => deadAppIds.has(u.refId)).length;

      console.log(`\n连带清理：`);
      console.log(`  会话 ${plan.removeSessions} 条 · Agent 令牌 ${plan.removeAgents} 个`);
      console.log(`  Skill 安装留痕 ${plan.removeInstalled} 条 · 指向死链的使用记录 ${plan.removeUsage} 条`);
    }
  } else if (ARCHIVE_ONLY || KEEP_DEV_USERS) {
    console.log(`\n（${ARCHIVE_ONLY ? "--archive-only" : "--keep-dev-users"}：跳过 dev 账号清理）`);
  }

  // ---------- 第三步：执行 ----------
  if (!APPLY) {
    console.log(`\n${"=".repeat(62)}`);
    console.log("预演结束，未做任何修改。确认无误后加 --apply 执行。");
    console.log("=".repeat(62));
    return;
  }

  // 备份（写操作前的保险）
  const backupDir = path.join(DATA_DIR, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `store-${nowIso().replace(/[:.]/g, "-")}.json`);
  fs.copyFileSync(path.join(DATA_DIR, "store.json"), backupPath);
  console.log(`\n已备份：${backupPath}`);

  // 执行归档
  if (plan.archive.length) {
    archiveApps(store, plan.archive, "生产环境死链归档：本地 e2e 历史副本，url 指向开发机地址");
    console.log(`已归档 ${plan.archive.length} 条死链记录（status=archived，数据保留可回滚）`);
  }

  // 执行归属转移
  for (const t of plan.reassign) {
    const list = t.kind === "app" ? store.apps : t.kind === "skill" ? store.skills : store.library;
    const item = list.find((x) => x.id === t.id);
    if (!item) continue;
    item.ownerId = takeoverUser.id;
    item.owner = takeoverUser.name;
  }
  if (plan.reassign.length) console.log(`已转移 ${plan.reassign.length} 项资源的归属`);

  // 执行用户删除与连带清理
  if (plan.removeUsers.length) {
    const removeIds = new Set(plan.removeUsers.map((u) => u.id));
    store.users = (store.users || []).filter((u) => !removeIds.has(u.id));
    store.sessions = (store.sessions || []).filter((s) => !removeIds.has(s.userId));
    store.agents = (store.agents || []).filter((a) => !removeIds.has(a.userId));
    store.installedSkills = (store.installedSkills || []).filter((s) => !removeIds.has(s.userId));
    console.log(`已删除 ${plan.removeUsers.length} 个 dev 账号及关联的会话/Agent/安装留痕`);
  }

  // 清理指向死链的使用记录（避免门户「最近使用」出现死链）
  const deadAppIds = new Set(dead.map((a) => a.id));
  if (plan.removeUsage > 0) {
    store.usage = (store.usage || []).filter((u) => !deadAppIds.has(u.refId));
    console.log(`已清理 ${plan.removeUsage} 条指向死链的使用记录`);
  }

  save(store);
  invalidateSnapshot();

  // 验证
  const after = load();
  const afterAlive = after.apps.filter((a) => a.status === "running");
  const afterArchived = after.apps.filter((a) => a.status === "archived");
  console.log(`\n${"=".repeat(62)}`);
  console.log("清理完成 · 结果校验");
  console.log("-".repeat(62));
  console.log(`应用总数 ${after.apps.length}：运行中 ${afterAlive.length} · 已归档 ${afterArchived.length} · 其他 ${after.apps.length - afterAlive.length - afterArchived.length}`);
  console.log(`用户数 ${(after.users || []).length}：飞书 ${(after.users || []).filter((u) => u.provider !== "dev").length} · dev ${(after.users || []).filter((u) => u.provider === "dev").length}`);
  console.log(`备份：${backupPath}`);
  console.log("=".repeat(62));
}

main().catch((e) => {
  console.error(`\n清理失败：${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
