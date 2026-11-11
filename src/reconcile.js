import fs from "node:fs";
import path from "node:path";
import { load, save } from "./store.js";
import { nowIso } from "./util.js";

/**
 * 状态对账（Reconciliation）
 *
 * 背景：`store.apps[].status` 是**发布那一刻写下的快照**，之后从不与运行时真实状态对账。
 * 后果：容器被删、崩溃或被外部重建后，门户仍显示绿点「运行中」，点开是死链。
 *
 * 本模块提供两条能力：
 *   1. probeAppState()  —— 问执行器「这个应用现在到底还活着吗」（只读，不落库）
 *   2. reconcileStatuses() —— 对账并把结果写回 store（供定时任务调用）
 *
 * 状态语义（写回 store 的 status）：
 *   running  —— 真实存活
 *   stopped  —— 记录说在跑，但运行时已不在（容器被删/退出、进程已死）
 *   failed   —— 发布失败
 *   starting —— 发布中
 *
 * 注意：stopped 是**新增**状态，与历史值兼容——旧记录里没有这个值，
 * 对账时才会被写入。门户据此显示异常态而不是「运行中」。
 */

/** 状态展示元信息（门户与 MCP 共用，避免两处各写一套） */
export const STATUS_META = {
  running: { label: "运行中", tone: "ok" },
  stopped: { label: "已停止", tone: "warn" },
  failed: { label: "失败", tone: "bad" },
  starting: { label: "启动中", tone: "wait" },
  archived: { label: "已归档", tone: "muted" },
};

/** 已知状态集合（用于校验对账结果，避免写入意外值） */
const KNOWN_STATUS = new Set(Object.keys(STATUS_META));

/**
 * 探测单个应用的真实存活状态。
 *
 * 判定依据按 runtime.kind 分：
 *   container —— 问执行器（容器是否存在且在运行）
 *   process  —— 进程 pid 是否还活着
 *   static   —— 静态目录是否还存在（静态应用由中台自己路由托管，无进程）
 *   未知/缺失 —— 无法判定，返回 "unknown"
 *
 * @param {object} [batch] 预取的批量状态（Map<pid|containerName, boolean|null>）
 * @returns {Promise<{alive: boolean, status: string, detail?: string}>}
 */
export async function probeAppState(app, executor, batch = null) {
  const runtime = app.runtime;
  if (!runtime || !runtime.kind) {
    return { alive: false, status: "unknown", detail: "无运行时信息" };
  }

  try {
    if (runtime.kind === "container") {
      const name = runtime.container;
      if (!name) return { alive: false, status: "unknown", detail: "无容器名" };
      if (batch && batch.has(`c:${name}`)) {
        const running = batch.get(`c:${name}`);
        if (running === true) return { alive: true, status: "running" };
        if (running === false) return { alive: false, status: "stopped", detail: `容器 ${name} 未运行` };
        return { alive: false, status: "unknown", detail: "无法查询容器状态" };
      }
      const running = await executor.status(app);
      if (running === true) return { alive: true, status: "running" };
      if (running === false) {
        return { alive: false, status: "stopped", detail: `容器 ${runtime.container || "?"} 未运行` };
      }
      return { alive: false, status: "unknown", detail: "无法查询容器状态" };
    }

    if (runtime.kind === "process") {
      const pid = runtime.pid;
      if (batch && typeof pid === "number" && batch.has(`pid:${pid}`)) {
        const alive = batch.get(`pid:${pid}`);
        if (alive === true) return { alive: true, status: "running" };
        if (alive === false) return { alive: false, status: "stopped", detail: `进程 ${pid ?? "?"} 已退出` };
        return { alive: false, status: "unknown", detail: "无法查询进程状态" };
      }
      const alive = typeof pid === "number" && isPidAlive(pid);
      if (alive) return { alive: true, status: "running" };
      return { alive: false, status: "stopped", detail: `进程 ${pid ?? "?"} 已退出` };
    }

    if (runtime.kind === "static") {
      const dir = runtime.dir;
      const exists = Boolean(dir) && fs.existsSync(dir);
      if (exists) return { alive: true, status: "running" };
      return { alive: false, status: "stopped", detail: "静态目录不存在" };
    }

    return { alive: false, status: "unknown", detail: `未知运行时类型 ${runtime.kind}` };
  } catch (e) {
    // 探测本身失败（如 docker 命令异常）：保守地判为 unknown，不误标 stopped
    return { alive: false, status: "unknown", detail: e.message };
  }
}

/** pid 是否存活（signal 0 只做权限/存在性检查，不实际发信号） */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // EPERM = 进程存在但当前用户无权发信号
  }
}

/**
 * 批量对账：探测全部应用，把真实状态写回 store。
 *
 * 只改 status 字段，不动其它数据。返回变更明细供调用方记录。
 *
 * @param {object} executor 执行器实例（local / docker）
 * @param {object} [opts]
 * @param {boolean} [opts.persist=true] 是否写回 store（测试可传 false）
 * @param {string[]} [opts.only] 只对账指定 appId
 */
export async function reconcileStatuses(executor, { persist = true, only = null } = {}) {
  const store = load();
  const apps = store.apps || [];
  const changes = [];

  // 走批量路径：一次 docker ps / 一次进程表遍历，而不是逐个应用探测
  let batch = null;
  if (executor.statusBatch) {
    try {
      batch = await executor.statusBatch(apps);
    } catch {
      batch = null; // 批量探测不可用 → 退回逐个探测
    }
  }

  for (const app of apps) {
    if (only && !only.includes(app.id)) continue;
    // 已失败/已归档的记录不参与对账（保持原状，避免覆盖失败原因）
    if (app.status === "failed" || app.status === "archived") continue;

    const probe = await probeAppState(app, executor, batch);
    if (probe.status === "unknown") continue; // 判不了就不动，避免误伤

    const before = app.status;
    if (before !== probe.status) {
      app.status = probe.status;
      changes.push({
        appId: app.id,
        name: app.name,
        slug: app.slug,
        from: before,
        to: probe.status,
        detail: probe.detail || "",
      });
    }
  }

  if (persist && changes.length) save(store);
  return { changes, checked: apps.length };
}

/**
 * 归档应用记录（不删除数据，只标记状态并移出可见列表）。
 *
 * 归档用于清理「本地 e2e 反复发布留下的垃圾记录」——这些记录的 sourceDir/url
 * 固化指向开发机地址，在生产上必然是死链。归档保留审计痕迹，不做物理删除。
 *
 * @param {object} store 已加载的 store
 * @param {string[]} appIds 要归档的应用 id
 * @param {string} reason 归档原因（写入记录，便于事后追溯）
 */
export function archiveApps(store, appIds, reason = "历史记录归档") {
  const archived = [];
  for (const app of store.apps || []) {
    if (!appIds.includes(app.id)) continue;
    app.status = "archived";
    app.archivedAt = nowIso();
    app.archiveReason = reason;
    archived.push(app);
  }
  return archived;
}

/**
 * 归档记录不参与门户展示与权限可见性判定。
 * （归档即「不再对外提供服务」，但数据仍在 store 里可查）
 */
export function isVisibleApp(app) {
  return app.status !== "archived";
}

/** 校验状态值合法（写库前的最后一道闸） */
export function isKnownStatus(status) {
  return KNOWN_STATUS.has(status);
}

/**
 * 实时状态快照（带 TTL 缓存）。
 *
 * 门户每次刷新都渲染「真实状态」，但每次都打一次 docker ps 会拖慢页面。
 * 这里做一层短 TTL 缓存（默认 5 秒）：页面永远是近实时真相，
 * 同时把 docker 调用频次压到每 5 秒最多一次。
 *
 * 与 reconcileStatuses 的分工：
 *   - 本函数：**只读**，用于页面/MCP 展示，不写库
 *   - reconcileStatuses：写库，用于定时任务固化状态
 */
let snapshotCache = { at: 0, ttl: 5000, states: new Map() };

/**
 * 测试注入点：替换状态探测使用的执行器。
 * 仅供 e2e 使用（生产路径恒为真实执行器）；传入 null 恢复默认。
 */
let testExecutor = null;
export function setTestExecutor(executor) {
  testExecutor = executor;
  invalidateSnapshot();
}

/**
 * 取全部应用的实时状态快照。
 * @returns {Promise<Map<string, {alive: boolean, status: string, detail?: string}>>}
 *          key 为 appId
 */
export async function probeAppStates(apps, executor, { ttl = 5000, force = false } = {}) {
  const now = Date.now();
  const fresh = !force && snapshotCache.ttl === ttl && now - snapshotCache.at < ttl;
  if (fresh) return snapshotCache.states;

  const ex = testExecutor || executor;
  let batch = null;
  if (ex?.statusBatch) {
    try {
      batch = await ex.statusBatch(apps);
    } catch {
      batch = null;
    }
  }

  const states = new Map();
  for (const app of apps) {
    states.set(app.id, await probeAppState(app, ex, batch));
  }
  snapshotCache = { at: now, ttl, states };
  return states;
}

/** 使实时状态缓存失效（发布/下线后立即调用，避免展示过期状态） */
export function invalidateSnapshot() {
  snapshotCache = { at: 0, ttl: snapshotCache.ttl, states: new Map() };
}
