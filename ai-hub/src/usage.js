import { load, save } from "./store.js";
import { nowIso } from "./util.js";

/**
 * 使用记录：驱动千人千面首页。
 * - recordUsage：每次「打开应用根路径」或「下载资料」记一笔
 * - recentFor：按频次 + 最近时间排序，取前 N 条渲染「最近使用」
 * - usageCount：某资源的个人使用次数（列表排序用）
 */

export function recordUsage(userId, kind, refId) {
  if (!userId || !refId) return;
  const store = load();
  store.usage = store.usage || [];
  const rec = store.usage.find((u) => u.userId === userId && u.kind === kind && u.refId === refId);
  if (rec) {
    rec.count += 1;
    rec.lastAt = nowIso();
  } else {
    store.usage.push({ userId, kind, refId, count: 1, lastAt: nowIso() });
  }
  save(store);
}

export function recentFor(userId, limit = 6) {
  if (!userId) return [];
  return (load().usage || [])
    .filter((u) => u.userId === userId)
    .sort((a, b) => b.count - a.count || (b.lastAt || "").localeCompare(a.lastAt || ""))
    .slice(0, limit);
}

/** 某用户对某资源的使用次数（0 = 没用过） */
export function usageCount(userId, kind, refId) {
  const rec = (load().usage || []).find((u) => u.userId === userId && u.kind === kind && u.refId === refId);
  return rec?.count || 0;
}
